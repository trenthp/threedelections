import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCountyGeometry, buildLineGeometry, createMaterials, TEX_W, TEX_H, AUX_OFFSET } from './geometry.js';
import {
  colorForCounty, marginColor, radialFill, densityWeight, legendGradient, winnerGradient, radialSwatch, toCss,
  NO_DATA, EMPTY, MARGIN_CAP, WEIGHT_FULL_DENSITY, RADIAL_FULL_DENSITY,
} from './colors.js';

// Height = measure (what) on a scale (how). The hint describes the combination.
const MEASURE_HINTS = {
  votes: { what: 'votes cast per square mile', volume: 'votes cast' },
  net: { what: "the winner's vote lead per square mile", volume: "the county's net vote lead" },
};
const SCALE_HINTS = {
  sqrt: 'square-root scaled so mid-sized counties stay visible.',
  log: 'log scaled to spread out the least dense counties.',
};

const fmtInt = new Intl.NumberFormat('en-US');
const COLOR_HINTS = {
  margin: 'The deeper the color, the more lopsided the result.',
  weighted: `Margin color, faded toward gray where few people vote. Full strength at ${fmtInt.format(WEIGHT_FULL_DENSITY)}+ votes per sq mi.`,
  radial: `A circle in each county whose area is proportional to its votes. It fills the county at ${fmtInt.format(RADIAL_FULL_DENSITY)}+ votes per sq mi.`,
  winner: 'Solid color for whoever won the county, however close.',
};

function modeHint() {
  if (state.measure === 'flat') return 'A standard 2D map: each county at its land area.';
  const m = MEASURE_HINTS[state.measure];
  if (state.scale === 'linear') return `Height = ${m.what}, so volume is proportional to ${m.volume}.`;
  return `Height = ${m.what}, ${SCALE_HINTS[state.scale]}`;
}

const MAX_HEIGHT = 160; // world units for the densest county (map is ~975 wide)
const ANIM_MS = 1100;
const BEACON_HEIGHT = 34; // world units the pinned-county marker rises above its block
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Matches the small-screen breakpoint in style.css: the panel becomes a bottom sheet.
const sheetQuery = window.matchMedia('(max-width: 720px)');

const state = {
  election: '', // id like 'p2024' or 'h2022'; set at startup (latest, or from a shared link)
  measure: 'flat',
  lastMeasure: 'votes',
  scale: 'linear',
  color: 'radial',
  view: 'tilt',
  exaggeration: 1,
  hover: -1,
  selected: -1,
};

// ---------------------------------------------------------------------------
// Renderer & scene

const canvas = document.getElementById('scene');
if (!document.createElement('canvas').getContext('webgl2')) {
  const el = document.getElementById('loading');
  el.textContent = "This map needs WebGL 2, which isn't available in this browser. Try a recent version of Chrome, Firefox, Safari or Edge.";
  el.classList.add('error');
  throw new Error('WebGL 2 unavailable');
}
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim() || '#0d0f13');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 5, 6000);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = THREE.MathUtils.degToRad(84);
controls.minDistance = 40;
controls.maxDistance = 2600;
controls.zoomSpeed = 1.2;
controls.screenSpacePanning = false; // pan along the map plane

const VIEWS = {
  tilt: { pos: [0, -1000, 840], target: [0, -10, 0] },
  top: { pos: [0, -1, 1380], target: [0, 0, 0] },
  low: { pos: [430, -880, 240], target: [140, 40, 30] },
};

// Data textures: rgb = color, a = height (pre-scale). Animate from -> to.
const texFrom = new Float32Array(TEX_W * TEX_H * 4);
const texTo = new Float32Array(TEX_W * TEX_H * 4);
const dataFrom = new THREE.DataTexture(texFrom, TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType);
const dataTo = new THREE.DataTexture(texTo, TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType);

const uniforms = {
  uFrom: { value: dataFrom },
  uTo: { value: dataTo },
  uMix: { value: 1 },
  uHeightScale: { value: 1 },
  uHover: { value: -1 },
  uSelected: { value: -1 },
  uLightDir: { value: new THREE.Vector3(-0.45, -0.7, 0.55).normalize() },
  uEmpty: { value: new THREE.Vector3(...EMPTY) },
};
const materials = createMaterials(uniforms);

let data;
let derived; // per-election computed values
let anim = null;
let camAnim = null;

// Pinned-county marker: a short stalk rising from the top of the block with a
// dot on the end. Drawn over everything so it can't hide behind tall neighbors.
const beacon = new THREE.Group();
beacon.visible = false;
beacon.renderOrder = 4;
{
  const stalk = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, BEACON_HEIGHT)]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
  );
  const dotTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#0d0f13';
    g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(32, 32, 21, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  })();
  const dot = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, BEACON_HEIGHT)]),
    new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: dotTex, transparent: true, depthTest: false }),
  );
  stalk.renderOrder = dot.renderOrder = 4;
  beacon.add(stalk, dot);
}
scene.add(beacon);

// ---------------------------------------------------------------------------
// Data

async function load() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/election.json`);
  if (!res.ok) throw new Error(`Couldn't load election data (HTTP ${res.status}). Run "npm run data" first.`);
  data = await res.json();

  derived = {};
  let maxDensity = 0;
  for (const id of data.meta.order) {
    derived[id] = data.results[id].map((r, i) => {
      if (!r || !r[2]) return null;
      const [g, d, t, flag, eevp] = r;
      const area = data.counties[i].a || 1;
      const density = t / area;
      maxDensity = Math.max(maxDensity, density);
      return { g, d, t, flag, eevp, margin: (d - g) / t, density, net: Math.abs(d - g) / area };
    });
  }
  data.maxDensity = maxDensity;

  const { mesh, lines, area, reach, centers } = buildCountyGeometry(data);
  data.shape = { area, reach, centers };
  const prisms = new THREE.Mesh(mesh, materials.prism);
  prisms.frustumCulled = false;
  scene.add(prisms);

  const outlines = new THREE.LineSegments(lines, materials.outline);
  outlines.frustumCulled = false;
  outlines.renderOrder = 1;
  scene.add(outlines);

  const selectedOutline = new THREE.LineSegments(lines, materials.selected);
  selectedOutline.frustumCulled = false;
  selectedOutline.renderOrder = 3;
  scene.add(selectedOutline);

  const stateLines = new THREE.LineSegments(
    buildLineGeometry(data, data.borders, 0.06),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  stateLines.renderOrder = 2;
  scene.add(stateLines);
  const coast = new THREE.LineSegments(
    buildLineGeometry(data, data.coast, 0.04),
    new THREE.LineBasicMaterial({ color: 0x9aa3b2, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  scene.add(coast);

  pickScene.add(new THREE.Mesh(mesh, materials.pick)).frustumCulled = false;
}

function heightFor(v) {
  if (!v || state.measure === 'flat') return 0;
  // Both measures share one reference (the densest county's votes/sq mi), so
  // votes and net margin are drawn on comparable scales.
  const x = state.measure === 'net' ? v.net : v.density;
  const m = data.maxDensity;
  switch (state.scale) {
    case 'sqrt': return Math.sqrt(x / m) * MAX_HEIGHT;
    case 'log': return (Math.log1p(x) / Math.log1p(m)) * MAX_HEIGHT * 0.55;
    default: return (x / m) * MAX_HEIGHT;
  }
}

/**
 * Radius (world units) of a county's disc. The disc covers the same share of
 * the footprint as radialFill(), so its area is proportional to votes cast. As
 * the fill nears 1 the radius grows to the county's farthest corner so full
 * counties are fully colored.
 */
function circleRadius(i, v) {
  const f = radialFill(v.density);
  const equal = Math.sqrt(data.shape.area[i] / Math.PI);
  const full = 1.02 * data.shape.reach[i];
  return Math.sqrt(f) * (equal + (full - equal) * f * f * f);
}

function writeTarget(arr) {
  const vals = derived[state.election];
  const radial = state.color === 'radial' ? 1 : 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const c = v ? colorForCounty(v, state.color) : NO_DATA;
    arr.set([c[0], c[1], c[2], heightFor(v)], i * 4);
    // The radius is written in every mode so switching to radial grows from the right size.
    arr.set([v ? circleRadius(i, v) : 0, v ? radial : 0, 0, 0], (AUX_OFFSET + i) * 4);
  }
}

/** Snapshot what's currently on screen into "from", write the new target, animate. */
function transition() {
  const t = uniforms.uMix.value;
  for (let i = 0; i < texFrom.length; i++) texFrom[i] += (texTo[i] - texFrom[i]) * t;
  writeTarget(texTo);
  dataFrom.needsUpdate = true;
  dataTo.needsUpdate = true;
  uniforms.uMix.value = 0;
  anim = { start: performance.now(), dur: reducedMotion ? 1 : ANIM_MS };
}

/** Height of a county's block as currently drawn (mid-animation included). */
function drawnHeight(i) {
  const k = i * 4 + 3;
  return (texFrom[k] + (texTo[k] - texFrom[k]) * uniforms.uMix.value) * uniforms.uHeightScale.value;
}

// ---------------------------------------------------------------------------
// Picking (GPU): render county ids to a 1x1 target under the cursor.

const pickScene = new THREE.Scene();
const pickTarget = new THREE.WebGLRenderTarget(1, 1);
const pickPixel = new Uint8Array(4);
const pointer = { x: 0, y: 0, inside: false, dirty: false, down: false, moved: false };

function pick() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // The view offset rebuilds an unshifted projection, so undo the layout shift
  // by moving the sampled pixel instead.
  camera.setViewOffset(w, h, Math.round(pointer.x - viewShift.x), Math.round(pointer.y - viewShift.y), 1, 1);
  renderer.setRenderTarget(pickTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(pickScene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);
  renderer.setRenderTarget(null);
  renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim() || '#0d0f13');
  camera.clearViewOffset();
  applyViewShift();
  return pickPixel[0] + pickPixel[1] * 256 - 1;
}

// ---------------------------------------------------------------------------
// UI

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const fmt1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const fmtCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const marginLabel = (m) => (Math.abs(m) < 0.0005 ? 'Even' : `${m > 0 ? 'D' : 'R'}+${(Math.abs(m) * 100).toFixed(1)}`);
// Elections: ids like 'p2024' (presidential) and 'h2022' (House).
const E = (id) => data.meta.elections[id];
const isHouse = (id) => E(id).race === 'House';
const raceOf = (id) => (isHouse(id) ? 'house' : 'pres');
const electionId = (race, year) => `${race === 'house' ? 'h' : 'p'}${year}`;
const raceIds = (race) => data.meta.order.filter((id) => raceOf(id) === race);
const raceName = (id) => (isHouse(id) ? 'House' : 'presidential');
const latestElection = () => data.meta.order[data.meta.order.length - 1];
/** Every year with an election, for the timeline. */
const electionYears = () => [...new Set(data.meta.order.map((id) => E(id).year))];
const barSeg = (cls, share, label) =>
  `<div class="seg-fill ${cls}" style="flex-basis:${share * 100}%" title="${esc(label)}: ${pct(share)}"></div>`;

function setupSeg(id, key, onChange) {
  const el = $(id);
  const sync = () => {
    for (const b of el.querySelectorAll('button')) {
      const on = String(state[key]) === b.dataset.v;
      b.setAttribute('aria-pressed', on);
      b.classList.toggle('on', on);
    }
  };
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onChange(b.dataset.v);
    sync();
  });
  sync();
  return sync;
}

let syncMeasure;
let syncElection;
function updateModeUI() {
  $('mode-hint').textContent = modeHint();
  // Scale only applies once the map has height.
  const flat = state.measure === 'flat';
  $('scale-row').classList.toggle('disabled', flat);
  for (const b of $('scale').querySelectorAll('button')) b.disabled = flat;
  $('exag').disabled = flat;
  $('exag').closest('.control').classList.toggle('disabled', flat);
  syncOptionsSummary();
}

// The collapsed "Map options" row still says what the map is showing.
function syncOptionsSummary() {
  const label = (group, v) => $(group).querySelector(`[data-v="${v}"]`)?.textContent ?? v;
  const parts = [state.measure === 'flat' ? 'Flat' : `${label('measure', state.measure)} height`];
  if (state.measure !== 'flat') {
    parts.push(label('scale', state.scale));
    if (state.exaggeration !== 1) parts.push(`${state.exaggeration.toFixed(1)}×`);
  }
  parts.push(`${label('color', state.color)} color`);
  $('options-summary').textContent = parts.join(' · ');
}

function setMeasure(measure) {
  if (measure === state.measure) return;
  state.measure = measure;
  if (measure !== 'flat') state.lastMeasure = measure;
  syncMeasure?.();
  updateModeUI();
  transition();
  scheduleLink();
}

function setScale(scale) {
  if (scale === state.scale) return;
  state.scale = scale;
  syncs.scale?.();
  updateModeUI();
  transition();
  scheduleLink();
}

function setColor(color) {
  if (color === state.color) return;
  state.color = color;
  syncs.color?.();
  transition();
  updateColorUI();
  scheduleLink();
}

function setExaggeration(x) {
  state.exaggeration = x;
  uniforms.uHeightScale.value = x;
  $('exag').value = x;
  $('exag-out').textContent = `${x.toFixed(1)}×`;
  syncOptionsSummary();
  scheduleLink();
}

function setView(view) {
  state.view = view;
  syncs.view?.();
  flyTo(view);
  scheduleLink();
}

// ---------------------------------------------------------------------------
// Shareable links: the URL hash mirrors the election, pinned county, settings
// and camera, e.g. #y=2024&c=13121&col=margin&v=top. Settings at their default
// are left out to keep links short.

const LINK_DEFAULTS = { measure: 'votes', scale: 'linear', color: 'radial', exaggeration: 1, view: 'tilt' };
const LINK_CHOICES = {
  measure: ['flat', 'votes', 'net'],
  scale: ['linear', 'sqrt', 'log'],
  color: ['margin', 'weighted', 'radial', 'winner'],
  view: Object.keys(VIEWS),
};
const syncs = {};
let linkReady = false; // don't write the hash until the opening animation has settled
let linkTimer = 0;

/** Parses the hash, keeping only valid values. */
function readLink() {
  const p = new URLSearchParams(location.hash.slice(1));
  const out = {};
  // y = year, r = race ('pres' or 'house'). Without r, a year's presidential race wins.
  const y = Number(p.get('y'));
  const race = p.get('r');
  const pick = [electionId(race === 'house' ? 'house' : 'pres', y), electionId('house', y)].find((id) => E(id));
  if (pick) out.election = pick;
  const fips = p.get('c');
  if (fips) {
    const i = data.counties.findIndex((c) => c.id === fips);
    if (i >= 0) out.selected = i;
  }
  for (const [key, param] of [['measure', 'h'], ['scale', 's'], ['color', 'col'], ['view', 'v']]) {
    if (LINK_CHOICES[key].includes(p.get(param))) out[key] = p.get(param);
  }
  const x = Number(p.get('x'));
  if (x >= 0.2 && x <= 5) out.exaggeration = Math.round(x * 10) / 10;
  const cam = (p.get('cam') ?? '').split(',').map(Number);
  if (cam.length === 6 && cam.every(Number.isFinite)) out.camera = cam;
  return out;
}

function linkHash() {
  const parts = [['y', E(state.election).year]];
  if (isHouse(state.election) && E(electionId('pres', E(state.election).year))) parts.push(['r', 'house']);
  if (state.selected >= 0) parts.push(['c', data.counties[state.selected].id]);
  if (state.measure !== LINK_DEFAULTS.measure) parts.push(['h', state.measure]);
  if (state.scale !== LINK_DEFAULTS.scale) parts.push(['s', state.scale]);
  if (state.color !== LINK_DEFAULTS.color) parts.push(['col', state.color]);
  if (state.exaggeration !== LINK_DEFAULTS.exaggeration) parts.push(['x', state.exaggeration]);
  if (state.view) {
    if (state.view !== LINK_DEFAULTS.view) parts.push(['v', state.view]);
  } else {
    parts.push(['cam', [...camera.position.toArray(), ...controls.target.toArray()].map(Math.round).join(',')]);
  }
  return `#${parts.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

function writeLink() {
  clearTimeout(linkTimer);
  linkTimer = 0;
  if (!linkReady) return;
  const hash = linkHash();
  // replaceState: settings changes shouldn't each add a Back-button step.
  if (hash !== location.hash) history.replaceState(null, '', hash);
}

/**
 * Writes the hash shortly after a change. A throttle, not a debounce: camera
 * damping fires change events for seconds, which would keep postponing a debounce.
 */
function scheduleLink() {
  if (!linkTimer) linkTimer = setTimeout(writeLink, 300);
}

/** Applies a parsed link to a running map (e.g. a link pasted into the same tab). */
function applyLink(l) {
  // Anything the link leaves out is at its default, so reset it.
  setElection(l.election ?? latestElection());
  setMeasure(l.measure ?? LINK_DEFAULTS.measure);
  setScale(l.scale ?? LINK_DEFAULTS.scale);
  setColor(l.color ?? LINK_DEFAULTS.color);
  setExaggeration(l.exaggeration ?? LINK_DEFAULTS.exaggeration);
  setSelected(l.selected ?? -1);
  if (l.camera) setCamera(l.camera);
  else setView(l.view ?? LINK_DEFAULTS.view);
}

function setCamera(cam, instant = false) {
  const pos = new THREE.Vector3(...cam.slice(0, 3));
  const target = new THREE.Vector3(...cam.slice(3));
  state.view = null;
  syncs.view?.();
  if (instant || reducedMotion) {
    camera.position.copy(pos);
    controls.target.copy(target);
  } else {
    camAnim = { start: performance.now(), dur: 1400, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), pos, target };
  }
}

function setElection(id) {
  if (id === state.election || !E(id)) return;
  state.election = id;
  syncElection();
  transition();
  updateStats();
  updateYearHint();
  refreshTooltip();
  renderCard();
  scheduleLink();
}

/** Previous/next election of the current race. */
function stepElection(dir) {
  const ids = raceIds(raceOf(state.election));
  const next = ids[ids.indexOf(state.election) + dir];
  if (next) setElection(next);
}

/** Switches race, keeping the year if that race was held then, else the nearest earlier one. */
function setRace(race) {
  if (race === raceOf(state.election)) return;
  const year = E(state.election).year;
  const ids = raceIds(race);
  const same = electionId(race, year);
  setElection(E(same) ? same : ids.filter((id) => E(id).year < year).pop() ?? ids[0]);
}

/** A timeline click: the current race in that year if there was one, else the other race. */
function pickYear(year) {
  const race = raceOf(state.election);
  const id = [electionId(race, year), electionId(race === 'pres' ? 'house' : 'pres', year)].find((x) => E(x));
  if (id) setElection(id);
}

function setSelected(id) {
  if (id === state.selected) return;
  state.selected = id;
  uniforms.uSelected.value = id;
  beacon.visible = id >= 0;
  renderCard();
  refreshTooltip();
  scheduleLink();
}

function setupUI() {
  // Year bar: race toggle plus a timeline of every election year. Years the
  // current race wasn't held stay on the axis, dimmed; clicking one switches race.
  const timeline = $('year');
  for (const y of electionYears()) {
    const b = document.createElement('button');
    b.className = 'tl-year';
    b.dataset.year = y;
    b.innerHTML = `<span class="yl">${y}</span><span class="ys">’${String(y).slice(2)}</span>`;
    timeline.append(b);
  }
  timeline.addEventListener('click', (e) => {
    const b = e.target.closest('[data-year]');
    if (b) pickYear(Number(b.dataset.year));
  });
  $('race').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setRace(b.dataset.v);
  });
  syncElection = () => {
    const id = state.election;
    const race = raceOf(id);
    const year = E(id).year;
    for (const b of $('race').querySelectorAll('button')) {
      const on = b.dataset.v === race;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    for (const b of timeline.children) {
      const y = Number(b.dataset.year);
      const on = y === year;
      const held = Boolean(E(electionId(race, y)));
      b.classList.toggle('on', on);
      b.classList.toggle('other', !held);
      b.setAttribute('aria-pressed', on);
      b.setAttribute('aria-label', `${y} ${held ? raceName(electionId(race, y)) : 'House'} election`);
    }
    const ids = raceIds(race);
    $('year-prev').disabled = id === ids[0];
    $('year-next').disabled = id === ids[ids.length - 1];
    const e = E(id);
    $('election-caption').innerHTML = isHouse(id)
      ? `<strong>${e.year} House${e.year % 4 ? ' midterm' : ''}</strong> · districts summed by county`
      : `<strong>${e.year} President</strong> · ${esc(e.sub)}`;
  };
  syncElection();
  $('year-prev').addEventListener('click', () => stepElection(-1));
  $('year-next').addEventListener('click', () => stepElection(1));
  updateYearHint();

  syncMeasure = setupSeg('measure', 'measure', (v) => setMeasure(v));
  syncs.scale = setupSeg('scale', 'scale', (v) => setScale(v));
  syncs.color = setupSeg('color', 'color', (v) => setColor(v));
  syncs.view = setupSeg('view', 'view', (v) => setView(v));
  // Leaving a camera preset takes an actual drag or zoom, not just a click (which pins a county).
  let userCamera = false;
  controls.addEventListener('start', () => { userCamera = true; });
  controls.addEventListener('end', () => { userCamera = false; });
  controls.addEventListener('change', () => {
    if (userCamera && state.view) { state.view = null; syncs.view(); }
    if (!state.view) scheduleLink();
  });

  // Map options start collapsed; remember if this viewer opens them.
  const options = $('options');
  try { options.open = localStorage.getItem('mapOptionsOpen') === '1'; } catch {}
  options.addEventListener('toggle', () => {
    try { localStorage.setItem('mapOptionsOpen', options.open ? '1' : '0'); } catch {}
  });

  const exag = $('exag');
  exag.addEventListener('input', () => setExaggeration(Number(exag.value)));
  setExaggeration(state.exaggeration);

  updateColorUI();

  // A link pasted into the same tab only changes the hash; apply it.
  window.addEventListener('hashchange', () => applyLink(readLink()));

  // Card: close and copy-link buttons, and the chart's points (which switch the election).
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-close')) { setSelected(-1); return; }
    const copy = e.target.closest('.card-link');
    if (copy) { copyLink(copy); return; }
    const point = e.target.closest('[data-election]');
    if (point) setElection(point.dataset.election);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Arrow keys belong to the slider while it has focus.
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest('input, select, textarea')) {
      e.preventDefault();
      stepElection(e.key === 'ArrowLeft' ? -1 : 1);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest('input, select, textarea, .controls, .card')) {
      // Up/down switch race; scrollable areas keep their arrow keys.
      e.preventDefault();
      setRace(e.key === 'ArrowUp' ? 'pres' : 'house');
    } else if (e.key === 'Escape' && state.selected >= 0) {
      setSelected(-1);
    } else if (e.code === 'Space' && !e.target.closest('input, button, summary, a')) {
      e.preventDefault();
      setMeasure(state.measure === 'flat' ? state.lastMeasure : 'flat');
    }
  });

  // Mouse hover shows a tooltip. A click or tap without a drag pins the county
  // under it; clicking it again, or clicking empty space, unpins.
  const setPointer = (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
  };
  let downAt = null;
  const active = new Set(); // pointers currently down; a second finger makes it a gesture, not a tap
  canvas.addEventListener('pointerdown', (e) => {
    if (active.size) pointer.moved = true;
    else {
      pointer.moved = false;
      downAt = [e.clientX, e.clientY];
    }
    active.add(e.pointerId);
    pointer.down = true;
    if (e.pointerType !== 'touch') setPointer(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointer.down && downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) pointer.moved = true;
    if (e.pointerType === 'touch') return; // no hover on touch
    setPointer(e);
    pointer.inside = true;
    pointer.dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    active.delete(e.pointerId);
    pointer.down = active.size > 0;
    pointer.dirty = true;
    if (pointer.down || pointer.moved || e.button > 0) return;
    setPointer(e);
    const id = pick();
    setSelected(id === state.selected ? -1 : id);
  });
  canvas.addEventListener('pointercancel', (e) => {
    active.delete(e.pointerId);
    pointer.down = active.size > 0;
    pointer.moved = true;
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    pointer.inside = false;
    setHover(-1);
  });
}

// Legend rows for weighted mode: example densities (votes / sq mi) from full color down to the floor.
const WEIGHT_ROWS = [WEIGHT_FULL_DENSITY, 30, 1];
// Swatches for radial mode, in votes / sq mi.
const RADIAL_SWATCHES = [5, 30, RADIAL_FULL_DENSITY];

function updateColorUI() {
  const mode = state.color;
  $('color-hint').textContent = COLOR_HINTS[mode];
  syncOptionsSummary();
  const cap = Math.round(MARGIN_CAP * 100);
  const labels = mode === 'winner' ? ['D won', '', 'R won'] : [`D+${cap}`, 'Even', `R+${cap}`];
  const labelHtml = `<div class="legend-labels">${labels.map((l) => `<span>${l}</span>`).join('')}</div>`;
  const density = (d, full) => `${fmtInt.format(d)}${d === full ? '+' : ''}`;
  let html;
  if (mode === 'weighted') {
    html =
      `<div class="legend-title">Votes per sq mi</div>` +
      WEIGHT_ROWS.map((d) =>
        `<div class="legend-grid-row"><div class="legend-ramp" style="background:${legendGradient(densityWeight(d))}"></div><span>${density(d, WEIGHT_FULL_DENSITY)}</span></div>`,
      ).join('') +
      `<div class="legend-grid-row">${labelHtml}<span></span></div>`;
  } else if (mode === 'radial') {
    const sample = marginColor(-0.4);
    // Two parts: stacked on desktop, side by side in the strip on small screens.
    html =
      `<div class="legend-part"><div class="legend-ramp" style="background:${legendGradient()}"></div>${labelHtml}</div>` +
      `<div class="legend-part legend-circles"><div class="legend-title">Circle area ∝ votes cast</div>` +
      `<div class="legend-swatches">${RADIAL_SWATCHES.map((d) =>
        `<div><div class="legend-swatch" style="background:${radialSwatch(sample, radialFill(d))}"></div><span>${density(d, RADIAL_FULL_DENSITY)}</span></div>`,
      ).join('')}<span class="legend-unit">votes per<br>sq mi</span></div></div>`;
  } else {
    html = `<div class="legend-ramp" style="background:${mode === 'winner' ? winnerGradient() : legendGradient()}"></div>${labelHtml}`;
  }
  $('legend').innerHTML = mode === 'radial' ? html : `<div class="legend-part">${html}</div>`;
  resize?.();
}

function updateYearHint() {
  const e = E(state.election);
  const el = $('year-hint');
  el.hidden = !e.unofficial;
  if (e.unofficial) {
    el.innerHTML = `<span class="badge">Unofficial</span> House votes by county as of ${asOfLabel(e)}. Counting and certification are still under way.`;
  }
}

const asOfLabel = (e) => new Date(`${e.asOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function updateStats() {
  const vals = derived[state.election];
  let landR = 0, landD = 0, votesR = 0, votesD = 0, votesO = 0, nR = 0, nD = 0;
  vals.forEach((v, i) => {
    if (!v) return;
    const a = data.counties[i].a;
    if (v.g > v.d) { landR += a; nR++; } else { landD += a; nD++; }
    votesR += v.g; votesD += v.d; votesO += v.t - v.g - v.d;
  });
  const c = E(state.election);
  const land = landR + landD;
  const votes = votesR + votesD + votesO;
  $('bar-land').innerHTML = barSeg('d', landD / land, c.d) + barSeg('r', landR / land, c.r);
  $('bar-votes').innerHTML = barSeg('d', votesD / votes, c.d) + barSeg('o', votesO / votes, 'Other') + barSeg('r', votesR / votes, c.r);
  // Short labels keep the two values on one line when party names are long.
  const [ds, rs] = [c.ds ?? c.d, c.rs ?? c.r];
  setBarLabels('bar-land', [[ds, landD / land], [rs, landR / land]]);
  setBarLabels('bar-votes', [[ds, votesD / votes], [rs, votesR / votes]]);
  $('stats-title').textContent = `${c.year} ${c.race} results`;
  $('stats-note').innerHTML =
    `Counties won: ${c.d} <strong>${fmt.format(nD)}</strong>, ${c.r} <strong>${fmt.format(nR)}</strong>.`;
}

function setBarLabels(id, pairs) {
  const el = $(id);
  let lab = el.nextElementSibling;
  if (!lab?.classList.contains('bar-values')) {
    lab = document.createElement('div');
    lab.className = 'bar-values';
    el.after(lab);
  }
  lab.innerHTML = pairs.map(([n, s], i) => `<span class="${i ? 'r' : 'd'}">${n} ${pct(s)}</span>`).join('');
}

// ---------------------------------------------------------------------------
// County details: shared by the hover tooltip and the pinned card.

const countyName = (c) => `${esc(c.n)}${c.n === c.s ? '' : `, ${esc(c.s)}`}`;

function noResultText(i, id) {
  const raw = data.results[id][i];
  const fips = data.counties[i].id;
  if (raw && raw[3] & data.meta.flags.noRace) {
    return 'No House votes were reported here, usually because the seat was uncontested and left off the ballot.';
  }
  if (fips === '11001' && isHouse(id)) return 'DC has no voting seat in the House.';
  return `The data source has no ${E(id).year} ${raceName(id)} results for this area.`;
}

function resultHtml(i, id, { bar = false } = {}) {
  const c = data.counties[i];
  const v = derived[id][i];
  const cand = E(id);
  const F = data.meta.flags;
  const head = (margin) =>
    `<div class="tt-margin">${margin} <span class="muted">${cand.year} ${cand.race}</span>${cand.unofficial ? '<span class="badge">Unofficial</span>' : ''}</div>`;
  if (!v) return head('<span class="muted">No result</span>') + `<div class="tt-note">${noResultText(i, id)}</div>`;
  const other = v.t - v.g - v.d;
  let html = head(`<span class="chip" style="background:${toCss(marginColor(v.margin))}"></span>${marginLabel(v.margin)}`);
  if (bar) html += `<div class="bar card-bar">${barSeg('d', v.d / v.t, cand.d) + barSeg('o', other / v.t, 'Other') + barSeg('r', v.g / v.t, cand.r)}</div>`;
  html +=
    `<div class="tt-row"><span>${cand.d}</span><span>${pct(v.d / v.t)} · ${fmt.format(v.d)}</span></div>` +
    `<div class="tt-row"><span>${cand.r}</span><span>${pct(v.g / v.t)} · ${fmt.format(v.g)}</span></div>` +
    (other >= 0.005 * v.t ? `<div class="tt-row"><span>Other</span><span>${pct(other / v.t)} · ${fmt.format(other)}</span></div>` : '') +
    `<div class="tt-sep"></div>` +
    `<div class="tt-row"><span>Total votes</span><span>${fmt.format(v.t)}</span></div>` +
    `<div class="tt-row"><span>Land area</span><span>${fmt.format(Math.round(c.a))} sq mi</span></div>` +
    `<div class="tt-row"><span>Density</span><span>${fmt1.format(v.density)} votes / sq mi</span></div>`;
  const note = (t) => (html += `<div class="tt-note">${t}</div>`);
  if (v.flag & F.ak) note("Alaska doesn't report by borough. Showing the statewide result.");
  if (v.flag & F.ak && id === 'h2022') note('First-round count. Peltola (D) won after the ranked-choice tabulation.');
  if (v.flag & F.ct) note("Approximated from Connecticut's 2024 planning-region results.");
  if (v.flag & F.uncontested) note(`No ${v.g === 0 ? 'Republican' : 'Democratic'} candidate was on the ballot here, so this isn't a head-to-head margin.`);
  if (v.flag & F.partial) note(`Still counting: about ${v.eevp}% of the expected vote is in.`);
  return html;
}

// Tooltip
const tooltip = $('tooltip');
function setHover(id) {
  if (id === state.hover) return;
  state.hover = id;
  uniforms.uHover.value = id;
  refreshTooltip();
}

function refreshTooltip() {
  const id = state.hover;
  // The pinned county's details are already in the card.
  if (id < 0 || id === state.selected || !data.counties[id]) { tooltip.hidden = true; return; }
  tooltip.innerHTML = `<div class="tt-title">${countyName(data.counties[id])}</div>${resultHtml(id, state.election)}`;
  tooltip.hidden = false;
  positionTooltip();
}

function positionTooltip() {
  if (tooltip.hidden) return;
  const pad = 16;
  const r = tooltip.getBoundingClientRect();
  let x = pointer.x + pad;
  let y = pointer.y + pad;
  if (x + r.width > window.innerWidth - 8) x = pointer.x - r.width - pad;
  // On small screens the panel is a bottom sheet; keep the tooltip above it.
  const panel = $('panel').getBoundingClientRect();
  const bottom = sheetQuery.matches ? panel.top : window.innerHeight;
  if (y + r.height > bottom - 8) y = pointer.y - r.height - pad;
  y = Math.min(y, bottom - r.height - 8);
  tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
}

// Pinned card
const card = $('card');

/** Smallest round axis extent (as a margin fraction) that fits every margin shown. */
function axisExtent(maxAbs) {
  return [0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1].find((e) => e >= maxAbs * 1.06) ?? 1;
}

/**
 * The county's margin in every election: D up, R down, presidential races as
 * solid dots on a solid line, House races as hollow dots on a dashed line.
 * Points are clickable and switch the map to that election.
 */
function chartHtml(i) {
  const F = data.meta.flags;
  const ids = data.meta.order;
  const years = electionYears();
  const W = 280, H = 128, L = 30, R = 10, T = 8, B = 20;
  const x = (yr) => L + ((yr - years[0]) / (years[years.length - 1] - years[0])) * (W - L - R);
  const vals = Object.fromEntries(ids.map((id) => [id, derived[id][i]]));
  const shown = ids.filter((id) => vals[id]);
  const ext = axisExtent(Math.max(0, ...shown.map((id) => Math.abs(vals[id].margin))));
  const mid = T + (H - T - B) / 2;
  const half = (H - T - B) / 2;
  const y = (m) => mid - (m / ext) * half;
  const uncontested = (id) => Boolean(vals[id].flag & F.uncontested);
  const cur = state.election;
  const f1 = (n) => n.toFixed(1);

  let svg = '';
  // Party halves, the zero line and axis labels.
  svg += `<rect x="${L}" y="${T}" width="${W - L - R}" height="${half}" class="ch-dem"/>`;
  svg += `<rect x="${L}" y="${mid}" width="${W - L - R}" height="${half}" class="ch-rep"/>`;
  svg += `<line x1="${L}" x2="${W - R}" y1="${mid}" y2="${mid}" class="ch-zero"/>`;
  const extLabel = Math.round(ext * 100);
  svg += `<text x="${L - 4}" y="${T + 7}" class="ch-label" text-anchor="end">D+${extLabel}</text>`;
  svg += `<text x="${L - 4}" y="${mid + 3}" class="ch-label" text-anchor="end">0</text>`;
  svg += `<text x="${L - 4}" y="${H - B}" class="ch-label" text-anchor="end">R+${extLabel}</text>`;
  for (const yr of years.filter((yr) => yr % 4 === 0)) {
    svg += `<text x="${f1(x(yr))}" y="${H - 5}" class="ch-label" text-anchor="middle">’${String(yr).slice(2)}</text>`;
  }
  // The selected election.
  svg += `<line x1="${f1(x(E(cur).year))}" x2="${f1(x(E(cur).year))}" y1="${T}" y2="${H - B}" class="ch-now"/>`;
  // Lines, House first so presidential sits on top. Uncontested races are left
  // out of the line (they aren't real margins).
  for (const race of ['house', 'pres']) {
    const pts = raceIds(race).filter((id) => vals[id] && !uncontested(id)).map((id) => `${f1(x(E(id).year))},${f1(y(vals[id].margin))}`);
    if (pts.length > 1) svg += `<polyline points="${pts.join(' ')}" class="ch-line ${race}"/>`;
  }
  // Points.
  let anyFaded = false;
  for (const race of ['house', 'pres']) {
    for (const id of raceIds(race).filter((id) => vals[id])) {
      const v = vals[id];
      const faded = uncontested(id);
      anyFaded ||= faded;
      const cx = f1(x(E(id).year));
      const cy = f1(y(v.margin));
      const col = toCss(marginColor(v.margin));
      const on = id === cur;
      const r = on ? 5.5 : race === 'pres' ? 4 : 3.5;
      const style = race === 'pres' ? `fill:${col}` : `stroke:${col}`;
      svg +=
        `<g class="ch-pt ${race}${on ? ' on' : ''}${faded ? ' faded' : ''}" data-election="${id}">` +
        `<title>${E(id).year} ${raceName(id)}: ${marginLabel(v.margin)}${faded ? ' (uncontested)' : ''}</title>` +
        `<circle cx="${cx}" cy="${cy}" r="10" class="ch-hit"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${r}" class="ch-dot" style="${style}"/></g>`;
    }
  }
  return (
    `<div class="hist">` +
    `<div class="label">Margin by election</div>` +
    `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(data.counties[i].n)} margin by election">${svg}</svg>` +
    `<div class="chart-key"><span class="k pres">President</span><span class="k house">House</span>` +
    `${anyFaded ? '<span class="k faded">Uncontested</span>' : ''}</div>` +
    shiftHtml(i) +
    `</div>`
  );
}

/** Change since the previous election of the same race. */
function shiftHtml(i) {
  const id = state.election;
  const ids = raceIds(raceOf(id));
  const prev = ids[ids.indexOf(id) - 1];
  if (!prev) return '';
  const a = derived[prev][i];
  const b = derived[id][i];
  const prevYear = E(prev).year;
  if (!a || !b) return '';
  const F = data.meta.flags;
  if ((a.flag | b.flag) & F.uncontested) {
    return `<p class="shift">Not comparable with ${prevYear}: a major party had no candidate in one of the races.</p>`;
  }
  const pts = (b.margin - a.margin) * 100;
  const turnout = b.t / a.t - 1;
  const dir = pts > 0 ? 'D' : 'R';
  const swing = Math.abs(pts) < 0.05
    ? `No change in margin since ${prevYear}`
    : `Shifted <strong class="${dir === 'D' ? 'd' : 'r'}">${Math.abs(pts).toFixed(1)} pts toward ${dir}</strong> since ${prevYear}`;
  const votes = `${turnout >= 0 ? '+' : '−'}${Math.abs(turnout * 100).toFixed(1)}% votes cast`;
  return `<p class="shift">${swing} · ${votes} (${fmtCompact.format(a.t)} → ${fmtCompact.format(b.t)})</p>`;
}

async function copyLink(button) {
  linkReady = true;
  writeLink();
  let ok = false;
  try {
    await navigator.clipboard.writeText(location.href);
    ok = true;
  } catch {
    // Clipboard can be blocked (permissions, insecure context); the address bar has the link either way.
  }
  button.textContent = ok ? 'Copied' : 'Link is in the address bar';
  button.classList.add('done');
  setTimeout(() => { if (button.isConnected) { button.textContent = 'Copy link'; button.classList.remove('done'); } }, 1800);
}

function renderCard() {
  const id = state.selected;
  const show = id >= 0 && Boolean(data.counties[id]);
  card.hidden = !show;
  const panel = $('panel');
  const wasShowing = panel.classList.contains('has-card');
  panel.classList.toggle('has-card', show);
  if (!show) { card.innerHTML = ''; return; }
  const c = data.counties[id];
  card.innerHTML =
    `<div class="card-head"><div><div class="card-title">${esc(c.n)}</div>${c.n === c.s ? '' : `<div class="card-sub">${esc(c.s)}</div>`}</div>` +
    `<div class="card-actions"><button class="card-link" title="Copy a link to this view">Copy link</button>` +
    `<button class="card-close" aria-label="Unpin ${esc(c.n)}" title="Unpin (Esc)">×</button></div></div>` +
    resultHtml(id, state.election, { bar: true }) +
    chartHtml(id);
  // On small screens the card replaces the controls in the sheet; start at its top.
  if (sheetQuery.matches && !wasShowing) panel.scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Layout

/** The year bar and card float over the map on wide screens and live in the bottom sheet on small ones. */
function placeChrome() {
  const panel = $('panel');
  const yearbar = $('yearbar');
  if (sheetQuery.matches) panel.prepend(yearbar, card);
  else document.body.append(yearbar, card);
}

// ---------------------------------------------------------------------------
// Camera

function flyTo(name, instant = false) {
  const v = VIEWS[name];
  const to = { pos: new THREE.Vector3(...v.pos), target: new THREE.Vector3(...v.target) };
  if (instant || reducedMotion) {
    camera.position.copy(to.pos);
    controls.target.copy(to.target);
    return;
  }
  camAnim = { start: performance.now(), dur: 1400, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), ...to };
}

// Pixel offset that centers the map in the area not covered by the panel.
const viewShift = { x: 0, y: 0 };

/** Shift the projection center in screen space (applied after updateProjectionMatrix). */
function applyViewShift() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const m = camera.projectionMatrix.elements;
  // clip.x += dx * clip.w, and clip.w = -z for a perspective camera.
  m[8] -= (2 * viewShift.x) / w;
  m[9] += (2 * viewShift.y) / h;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function resize() {
  if (!data) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;

  const panel = $('panel').getBoundingClientRect();
  const yearbar = $('yearbar');
  const legend = $('legend');
  legend.style.bottom = '';
  let visW = w;
  let visH = h;
  if (sheetQuery.matches) {
    yearbar.style.left = '';
    card.style.maxHeight = '';
    // The map gets the strip between the legend (top) and the sheet (bottom).
    const top = legend.getBoundingClientRect().bottom + 4;
    const bottom = Math.min(panel.top, h);
    visH = Math.max(bottom - top, h * 0.25);
    viewShift.x = 0;
    viewShift.y = (top + bottom) / 2 - h / 2;
  } else {
    visW = w - panel.right;
    viewShift.x = panel.right / 2;
    viewShift.y = 0;
    // Center the year bar under the visible map, clear of the panel; lift the
    // legend above it if they'd collide.
    const bw = yearbar.offsetWidth;
    yearbar.style.left = `${Math.max((panel.right + w) / 2, panel.right + 12 + bw / 2)}px`;
    const yb = yearbar.getBoundingClientRect();
    if (yb.right > legend.getBoundingClientRect().left - 12) legend.style.bottom = `${h - yb.top + 10}px`;
    // Keep the card clear of the legend.
    card.style.maxHeight = `${legend.getBoundingClientRect().top - 16 - 12}px`;
  }
  // Zoom so the whole country fits the visible area. The vertical FOV spans the
  // full canvas height, so both fits are relative to h.
  camera.zoom = Math.min(1, visW / h / 1.45, visH / h + 0.05);
  camera.updateProjectionMatrix();
  applyViewShift();
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function frame(now) {
  if (anim) {
    const t = Math.min((now - anim.start) / anim.dur, 1);
    uniforms.uMix.value = ease(t);
    if (t >= 1) anim = null;
  }
  if (camAnim) {
    const t = ease(Math.min((now - camAnim.start) / camAnim.dur, 1));
    camera.position.lerpVectors(camAnim.fromPos, camAnim.pos, t);
    controls.target.lerpVectors(camAnim.fromTarget, camAnim.target, t);
    if (t >= 1) camAnim = null;
  }
  controls.update();

  if (pointer.inside && !pointer.down && (pointer.dirty || anim || camAnim)) {
    setHover(pick());
    pointer.dirty = false;
  }
  positionTooltip();

  if (state.selected >= 0) {
    const i = state.selected;
    beacon.position.set(data.shape.centers[i * 2], data.shape.centers[i * 2 + 1], drawnHeight(i));
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------

load()
  .then(() => {
    // Settings from a shared link apply before the UI is built, so controls start in sync.
    const link = readLink();
    state.election = link.election ?? latestElection();
    for (const k of ['scale', 'color', 'exaggeration']) if (link[k] !== undefined) state[k] = link[k];
    placeChrome();
    setupUI();
    resize();
    window.addEventListener('resize', resize);
    sheetQuery.addEventListener('change', () => { placeChrome(); resize(); });
    // Both textures start flat; the rise to the chosen height animates below.
    writeTarget(texTo);
    texFrom.set(texTo);
    dataFrom.needsUpdate = dataTo.needsUpdate = true;
    updateModeUI();
    updateStats();
    if (link.camera) setCamera(link.camera, true);
    else {
      state.view = link.view ?? LINK_DEFAULTS.view;
      syncs.view();
      flyTo(state.view, true);
    }
    if (link.selected !== undefined) setSelected(link.selected);
    $('loading').remove();
    requestAnimationFrame(frame);
    // Start as the familiar flat map, then raise it (unless the link asks for flat).
    const measure = link.measure ?? LINK_DEFAULTS.measure;
    setTimeout(() => {
      setMeasure(measure);
      linkReady = true;
      scheduleLink();
    }, reducedMotion ? 0 : 900);
  })
  .catch((err) => {
    console.error(err);
    $('loading').textContent = err.message;
    $('loading').classList.add('error');
  });
