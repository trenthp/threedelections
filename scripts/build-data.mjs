// Builds public/data/election.json from public sources:
//   - County shapes: us-atlas (US Census cartographic boundaries), counties-10m
//   - County results: github.com/tonmcg/US_County_Level_Election_Results_08-24
//
// Run with: npm run data
// Raw downloads are cached in data-raw/ (git-ignored).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { geoAlbersUsa, geoArea } from 'd3-geo';
import * as topojson from 'topojson-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data-raw');
const OUT = path.join(ROOT, 'public', 'data', 'election.json');

// 2016 is omitted: the source file is a pre-certification snapshot (e.g. CA is
// ~1.4M votes short), so its totals don't match official results.
const PRES_YEARS = [2020, 2024];
const MIDTERM_YEAR = 2026;
const YEARS = [...PRES_YEARS, MIDTERM_YEAR];

// 2026 House results by county are UNOFFICIAL (counting/certification ongoing).
// Source: NYT/AP results compiled by github.com/mike10010100/elections-2026,
// pinned to a commit so builds are reproducible. To refresh, update the SHA and
// date below, delete data-raw/2026-house.json, and run `npm run data`.
const MIDTERM_COMMIT = '4f04365b5675299cb8120de9b5e392ea9d55df58';
const MIDTERM_AS_OF = '2026-11-15';

const ELECTIONS = {
  2020: { race: 'presidential', d: 'Biden', r: 'Trump', sub: 'Biden v. Trump' },
  2024: { race: 'presidential', d: 'Harris', r: 'Trump', sub: 'Harris v. Trump' },
  2026: { race: 'House', d: 'Democrats', r: 'Republicans', ds: 'Dem.', rs: 'Rep.', sub: 'House midterm', unofficial: true, asOf: MIDTERM_AS_OF },
};

const SOURCES = {
  'counties-10m.json': 'https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/counties-10m.json',
  '2026-house.json': `https://raw.githubusercontent.com/mike10010100/elections-2026/${MIDTERM_COMMIT}/site_data/county_shifts.json`,
  ...Object.fromEntries(
    PRES_YEARS.map((y) => [
      `${y}.csv`,
      `https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/${y}_US_County_Level_Presidential_Results.csv`,
    ]),
  ),
};

const EARTH_RADIUS_MI = 3958.8;
const COORD_SCALE = 10; // projected coords stored as ints in 0.1-unit steps

// Bit flags stored alongside each result so the UI can explain caveats.
const FLAG_NONE = 0;
const FLAG_AK_STATEWIDE = 1; // Alaska reports by house district, not borough
const FLAG_CT_REGIONS = 2; // CT 2024 reports by planning region, not county
const FLAG_UNCONTESTED = 4; // a major party had no candidate on the ballot here
const FLAG_PARTIAL = 8; // < PARTIAL_THRESHOLD of the expected vote counted
const PARTIAL_THRESHOLD = 95;

async function fetchCached(name) {
  const file = path.join(RAW, name);
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    const url = SOURCES[name];
    console.log(`  downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    const text = await res.text();
    await fs.mkdir(RAW, { recursive: true });
    await fs.writeFile(file, text);
    return text;
  }
}

// Minimal RFC-4180-ish CSV parser (handles quoted fields like "37,410").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (s) => Math.round(Number(String(s).replace(/,/g, '')) || 0);

// 2026: { counties: { [fips]: { h26: { d, r, i (percent), v (total votes), eevp } } } }
function loadMidterm(jsonText) {
  const byFips = new Map();
  for (const c of Object.values(JSON.parse(jsonText).counties)) {
    const h = c.h26;
    if (!h || !h.v) continue;
    let flags = FLAG_NONE;
    if (h.d === 0 || h.r === 0) flags |= FLAG_UNCONTESTED;
    if (h.eevp < PARTIAL_THRESHOLD) flags |= FLAG_PARTIAL;
    byFips.set(c.fips, {
      g: Math.round((h.r / 100) * h.v),
      d: Math.round((h.d / 100) * h.v),
      t: h.v,
      state: c.state,
      flags,
      eevp: h.eevp,
    });
  }
  return byFips;
}

function loadResults(year, csvText) {
  const byFips = new Map();
  for (const r of parseCsv(csvText)) {
    const fips = String(r.county_fips ?? r.combined_fips).padStart(5, '0');
    byFips.set(fips, { g: num(r.votes_gop), d: num(r.votes_dem), t: num(r.total_votes), state: r.state_name ?? r.state_abbr, name: r.county_name });
  }
  return byFips;
}

// Collects projected geometry from a d3 projection stream.
function projectRings(projection, geometry) {
  const polygons = [];
  let rings = null;
  let ring = null;
  const sink = {
    point(x, y) { ring?.push(x, y); },
    lineStart() { ring = []; },
    lineEnd() { if (rings && ring) rings.push(ring); ring = null; },
    polygonStart() { rings = []; },
    polygonEnd() { if (rings.length) polygons.push(rings); rings = null; },
    sphere() {},
  };
  // Feed the GeoJSON through the projection's stream so AlbersUsa can route
  // Alaska/Hawaii to their insets and clip as needed.
  const stream = projection.stream(sink);
  const feedRing = (coords) => {
    stream.lineStart();
    // GeoJSON rings repeat the first point at the end; d3 streams do not.
    for (let i = 0; i < coords.length - 1; i++) stream.point(coords[i][0], coords[i][1]);
    stream.lineEnd();
  };
  const feedPolygon = (poly) => {
    stream.polygonStart();
    poly.forEach(feedRing);
    stream.polygonEnd();
  };
  if (geometry.type === 'Polygon') feedPolygon(geometry.coordinates);
  else if (geometry.type === 'MultiPolygon') geometry.coordinates.forEach(feedPolygon);
  return polygons;
}

function projectLines(projection, geometry) {
  const lines = [];
  let line = null;
  const stream = projection.stream({
    point(x, y) { line?.push(x, y); },
    lineStart() { line = []; },
    lineEnd() { if (line?.length >= 4) lines.push(line); line = null; },
    polygonStart() {}, polygonEnd() {}, sphere() {},
  });
  const coordsList = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
  for (const coords of coordsList) {
    stream.lineStart();
    for (const [lon, lat] of coords) stream.point(lon, lat);
    stream.lineEnd();
  }
  return lines;
}

// Round to ints and drop consecutive duplicates created by rounding.
function quantize(flat, closed) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    const x = Math.round(flat[i] * COORD_SCALE);
    const y = Math.round(flat[i + 1] * COORD_SCALE);
    const n = out.length;
    if (n && out[n - 2] === x && out[n - 1] === y) continue;
    out.push(x, y);
  }
  if (closed && out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

async function main() {
  console.log('Loading sources...');
  const topo = JSON.parse(await fetchCached('counties-10m.json'));
  const resultsByYear = {};
  for (const y of PRES_YEARS) resultsByYear[y] = loadResults(y, await fetchCached(`${y}.csv`));
  resultsByYear[MIDTERM_YEAR] = loadMidterm(await fetchCached('2026-house.json'));

  const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
  const stateNames = new Map(topo.objects.states.geometries.map((g) => [g.id, g.properties.name]));

  // --- Counties -------------------------------------------------------------
  const features = topojson.feature(topo, topo.objects.counties).features;
  const counties = [];
  for (const f of features) {
    const fips = String(f.id).padStart(5, '0');
    const stateFips = fips.slice(0, 2);
    if (Number(stateFips) > 56) continue; // territories (PR etc.) aren't in AlbersUsa
    const polys = projectRings(projection, f.geometry)
      .map((rings) => rings.map((r) => quantize(r, true)).filter((r) => r.length >= 6))
      .filter((rings) => rings.length);
    if (!polys.length) continue;
    let sr = geoArea(f);
    if (sr > 2 * Math.PI) sr = 4 * Math.PI - sr; // guard against inverted winding
    counties.push({
      id: fips,
      n: f.properties.name,
      s: stateNames.get(stateFips) ?? stateFips,
      a: Math.round(sr * EARTH_RADIUS_MI ** 2 * 10) / 10,
      p: polys,
    });
  }
  counties.sort((a, b) => a.id.localeCompare(b.id));
  const countyIndex = new Map(counties.map((c, i) => [c.id, i]));

  // Display names: the Census shapes carry bare names ("Plaquemines"), but the
  // results files have full ones ("Plaquemines Parish", "Richmond city"). Prefer
  // 2020 (CT still had counties; 2024 uses planning regions). Alaska's results are
  // by house district, so its boroughs keep the bare shape names.
  for (const y of [...PRES_YEARS].sort()) {
    for (const [fips, r] of resultsByYear[y]) {
      const c = counties[countyIndex.get(fips)];
      if (c && !c.fullName && r.name && !fips.startsWith('02')) c.fullName = r.name;
    }
  }
  for (const c of counties) {
    if (c.fullName) c.n = c.fullName;
    else if (!c.id.startsWith('02')) c.n += ' County'; // no results row (e.g. Kalawao)
    delete c.fullName;
  }

  // --- Results per year, aligned with counties ---------------------------------
  // Source FIPS -> shape FIPS. Falls Church is too small to survive the 10m
  // simplification, so it's folded into surrounding Fairfax County. DC 2024 is
  // reported by ward (11002-11008); those are summed into the single DC shape.
  const FIPS_ALIASES = { '46113': '46102', '51515': '51019', '51610': '51059' };
  const aliasFor = (fips) => (fips.startsWith('11') ? '11001' : FIPS_ALIASES[fips]);
  const results = {};
  const report = {};
  for (const y of YEARS) {
    const src = resultsByYear[y];
    const arr = counties.map(() => null);
    const unmatched = [];

    // Alaska: aggregate statewide, then spread evenly by land area so the
    // state's density is uniform and its totals stay correct.
    const akRows = [...src.entries()].filter(([f]) => f.startsWith('02'));
    let ak;
    ak = akRows.reduce((s, [, r]) => ({ g: s.g + r.g, d: s.d + r.d, t: s.t + r.t }), { g: 0, d: 0, t: 0 });
    const akCounties = counties.map((c, i) => [c, i]).filter(([c]) => c.id.startsWith('02'));
    const akArea = akCounties.reduce((s, [c]) => s + c.a, 0);
    for (const [c, i] of akCounties) {
      const share = c.a / akArea;
      arr[i] = [ak.g * share, ak.d * share, ak.t * share].map(Math.round).concat(FLAG_AK_STATEWIDE);
    }

    // Connecticut 2024: planning regions -> legacy counties (approximate).
    if (y === 2024 && src.has('09110')) {
      const R = (f) => src.get(f);
      const sum = (...fs) => fs.map(R).reduce((s, r) => ({ g: s.g + r.g, d: s.d + r.d, t: s.t + r.t }), { g: 0, d: 0, t: 0 });
      const scale = (r, k) => ({ g: r.g * k, d: r.d * k, t: r.t * k });
      const prev = resultsByYear[2020];
      const hartShare = prev.get('09003').t / (prev.get('09003').t + prev.get('09013').t);
      const crosswalk = {
        '09001': sum('09120', '09190'), // Fairfield <- Greater Bridgeport + Western CT
        '09003': scale(R('09110'), hartShare), // Hartford <- Capitol (split w/ Tolland)
        '09013': scale(R('09110'), 1 - hartShare), // Tolland <- Capitol
        '09005': R('09160'), // Litchfield <- Northwest Hills
        '09007': R('09130'), // Middlesex <- Lower CT River Valley
        '09009': sum('09170', '09140'), // New Haven <- South Central + Naugatuck Valley
        '09011': R('09180'), // New London <- Southeastern CT
        '09015': R('09150'), // Windham <- Northeastern CT
      };
      for (const [fips, r] of Object.entries(crosswalk)) {
        arr[countyIndex.get(fips)] = [r.g, r.d, r.t].map(Math.round).concat(FLAG_CT_REGIONS);
      }
    }

    for (const [fips, r] of src) {
      if (fips.startsWith('02') || (y === 2024 && fips.startsWith('091'))) continue;
      const idx = countyIndex.get(fips) ?? countyIndex.get(aliasFor(fips));
      if (idx === undefined) { unmatched.push(`${fips} (${r.state})`); continue; }
      if (arr[idx] && !(arr[idx][3] & (FLAG_AK_STATEWIDE | FLAG_CT_REGIONS))) {
        // Two source rows mapped onto one shape (e.g. a merged county): add them.
        arr[idx] = [arr[idx][0] + r.g, arr[idx][1] + r.d, arr[idx][2] + r.t, arr[idx][3] | (r.flags ?? 0)];
      } else arr[idx] = [r.g, r.d, r.t, r.flags ?? FLAG_NONE];
      // Share of the expected vote counted, for results still being tallied.
      if (r.eevp !== undefined && r.eevp < 100) arr[idx][4] = r.eevp;
    }
    const missing = counties.filter((_, i) => !arr[i]).map((c) => `${c.id} ${c.n}, ${c.s}`);
    results[y] = arr;
    report[y] = { unmatched, missing };
  }

  // --- State borders & national outline ----------------------------------------
  const borders = projectLines(projection, topojson.mesh(topo, topo.objects.states, (a, b) => a !== b)).map((l) => quantize(l, false));
  const coast = projectLines(projection, topojson.mesh(topo, topo.objects.states, (a, b) => a === b)).map((l) => quantize(l, false));

  const out = {
    meta: {
      coordScale: COORD_SCALE,
      width: 975,
      height: 610,
      years: YEARS,
      elections: ELECTIONS,
      flags: { ak: FLAG_AK_STATEWIDE, ct: FLAG_CT_REGIONS, uncontested: FLAG_UNCONTESTED, partial: FLAG_PARTIAL },
      sources: [
        'County boundaries: U.S. Census Bureau via us-atlas 3.0.1',
        'Presidential results: tonmcg/US_County_Level_Election_Results_08-24',
        `2026 House results (unofficial, as of ${MIDTERM_AS_OF}): NYT/AP via mike10010100/elections-2026@${MIDTERM_COMMIT.slice(0, 7)}`,
      ],
    },
    counties,
    results,
    borders,
    coast,
  };

  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  await fs.writeFile(OUT, json);

  console.log(`\nWrote ${path.relative(ROOT, OUT)} (${(json.length / 1e6).toFixed(2)} MB), ${counties.length} counties`);
  for (const y of YEARS) {
    const tot = results[y].reduce((s, r) => (r ? [s[0] + r[0], s[1] + r[1], s[2] + r[2]] : s), [0, 0, 0]);
    console.log(`  ${y}: R ${tot[0].toLocaleString()}  D ${tot[1].toLocaleString()}  total ${tot[2].toLocaleString()}`);
    if (report[y].unmatched.length) console.log(`    unmatched source rows: ${report[y].unmatched.join(', ')}`);
    if (report[y].missing.length) console.log(`    shapes with no result: ${report[y].missing.join('; ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
