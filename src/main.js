import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildCountyGeometry, buildLineGeometry, createMaterials, TEX_W, TEX_H } from './geometry.js';
import { colorForMargin, legendGradient, NO_DATA, MARGIN_CAP } from './colors.js';

// Height = measure (what) on a scale (how). The hint describes the combination.
const MEASURE_HINTS = {
  votes: { what: 'votes cast per square mile', volume: 'votes cast' },
  net: { what: "the leading candidate's vote lead per square mile", volume: "the county's net vote lead" },
};
const SCALE_HINTS = {
  sqrt: 'on a square-root scale. This compresses the tallest counties so smaller differences are easier to see.',
  log: 'on a log scale. This spreads out differences among the least dense counties.',
};

function modeHint() {
  if (state.measure === 'flat') return 'A standard 2D map: each county is shown at its land area, colored by margin.';
  const m = MEASURE_HINTS[state.measure];
  if (state.scale === 'linear') return `Height = ${m.what}, so volume is proportional to ${m.volume}.`;
  return `Height = ${m.what}, ${SCALE_HINTS[state.scale]}`;
}

const MAX_HEIGHT = 160; // world units for the densest county (map is ~975 wide)
const ANIM_MS = 1100;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  year: 2024,
  measure: 'flat',
  lastMeasure: 'votes',
  scale: 'linear',
  color: 'margin',
  exaggeration: 1,
  hover: -1,
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
  uLightDir: { value: new THREE.Vector3(-0.45, -0.7, 0.55).normalize() },
};
const materials = createMaterials(uniforms);

let data;
let derived; // per-year computed values
let anim = null;
let camAnim = null;

// ---------------------------------------------------------------------------
// Data

async function load() {
  const res = await fetch(`${import.meta.env.BASE_URL}data/election.json`);
  if (!res.ok) throw new Error(`Couldn't load election data (HTTP ${res.status}). Run "npm run data" first.`);
  data = await res.json();

  derived = {};
  let maxDensity = 0;
  for (const y of data.meta.years) {
    derived[y] = data.results[y].map((r, i) => {
      if (!r || !r[2]) return null;
      const [g, d, t, flag, eevp] = r;
      const area = data.counties[i].a || 1;
      const density = t / area;
      maxDensity = Math.max(maxDensity, density);
      return { g, d, t, flag, eevp, margin: (d - g) / t, density, net: Math.abs(d - g) / area };
    });
  }
  data.maxDensity = maxDensity;

  const { mesh, lines } = buildCountyGeometry(data);
  const prisms = new THREE.Mesh(mesh, materials.prism);
  prisms.frustumCulled = false;
  scene.add(prisms);

  const outlines = new THREE.LineSegments(lines, materials.outline);
  outlines.frustumCulled = false;
  outlines.renderOrder = 1;
  scene.add(outlines);

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

function writeTarget(arr) {
  const vals = derived[state.year];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const c = v ? colorForMargin(v.margin, state.color) : NO_DATA;
    arr.set([c[0], c[1], c[2], heightFor(v)], i * 4);
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
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const marginLabel = (m) => (Math.abs(m) < 0.0005 ? 'Even' : `${m > 0 ? 'D' : 'R'}+${(Math.abs(m) * 100).toFixed(1)}`);

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
function updateModeUI() {
  $('mode-hint').textContent = modeHint();
  // Scale only applies once the map has height.
  const flat = state.measure === 'flat';
  $('scale-row').classList.toggle('disabled', flat);
  for (const b of $('scale').querySelectorAll('button')) b.disabled = flat;
  $('exag').disabled = flat;
  $('exag').closest('.control').classList.toggle('disabled', flat);
}

function setMeasure(measure) {
  state.measure = measure;
  if (measure !== 'flat') state.lastMeasure = measure;
  syncMeasure?.();
  updateModeUI();
  transition();
}

function setupUI() {
  const yearEl = $('year');
  for (const y of data.meta.years) {
    const b = document.createElement('button');
    b.dataset.v = y;
    b.innerHTML = `${y}<small>${esc(data.meta.elections[y].sub)}</small>`;
    yearEl.append(b);
  }
  setupSeg('year', 'year', (v) => { state.year = Number(v); transition(); updateStats(); updateYearHint(); refreshTooltip(); });
  updateYearHint();
  syncMeasure = setupSeg('measure', 'measure', (v) => setMeasure(v));
  setupSeg('scale', 'scale', (v) => { state.scale = v; updateModeUI(); transition(); });
  setupSeg('color', 'color', (v) => { state.color = v; transition(); });
  const syncView = setupSeg('view', 'view', (v) => { state.view = v; flyTo(v); });
  controls.addEventListener('start', () => { state.view = null; syncView(); });

  const exag = $('exag');
  exag.addEventListener('input', () => {
    state.exaggeration = Number(exag.value);
    uniforms.uHeightScale.value = state.exaggeration;
    $('exag-out').textContent = `${state.exaggeration.toFixed(1)}×`;
  });

  $('legend-ramp').style.background = legendGradient();
  const capLabel = Math.round(MARGIN_CAP * 100);
  const labels = $('legend').querySelectorAll('.legend-labels span');
  labels[0].textContent = `D+${capLabel}`;
  labels[2].textContent = `R+${capLabel}`;

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.closest('input, button, summary, a')) return;
    e.preventDefault();
    setMeasure(state.measure === 'flat' ? state.lastMeasure : 'flat');
  });

  // Mouse: hover shows the tooltip. Touch: a tap (no drag) selects a county and
  // the tooltip stays until the next tap or drag.
  const setPointer = (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = e.clientX - r.left;
    pointer.y = e.clientY - r.top;
  };
  let downAt = null;
  canvas.addEventListener('pointerdown', (e) => {
    pointer.down = true;
    pointer.moved = false;
    downAt = [e.clientX, e.clientY];
    if (e.pointerType !== 'touch') setPointer(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointer.down) {
      if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) pointer.moved = true;
      if (e.pointerType === 'touch' && pointer.moved) { pointer.inside = false; setHover(-1); }
      if (e.pointerType === 'touch') return;
    }
    setPointer(e);
    pointer.inside = true;
    pointer.dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    pointer.down = false;
    if (e.pointerType === 'touch') {
      if (pointer.moved) return;
      setPointer(e);
      pointer.inside = true;
    }
    pointer.dirty = true;
  });
  canvas.addEventListener('pointerleave', (e) => {
    // Touch fires pointerleave right after every tap; keep the tapped county shown.
    if (e.pointerType === 'touch') return;
    pointer.inside = false;
    setHover(-1);
  });
}

function updateYearHint() {
  const e = data.meta.elections[state.year];
  const el = $('year-hint');
  el.hidden = !e.unofficial;
  if (e.unofficial) {
    const asOf = new Date(`${e.asOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    el.innerHTML = `<span class="badge">Unofficial</span> House votes by county as of ${asOf}. Counting and certification are still under way.`;
  }
}

function updateStats() {
  const vals = derived[state.year];
  let landR = 0, landD = 0, votesR = 0, votesD = 0, votesO = 0, nR = 0, nD = 0;
  vals.forEach((v, i) => {
    if (!v) return;
    const a = data.counties[i].a;
    if (v.g > v.d) { landR += a; nR++; } else { landD += a; nD++; }
    votesR += v.g; votesD += v.d; votesO += v.t - v.g - v.d;
  });
  const c = data.meta.elections[state.year];
  const land = landR + landD;
  const votes = votesR + votesD + votesO;
  const seg = (cls, share, label) =>
    `<div class="seg-fill ${cls}" style="flex-basis:${share * 100}%" title="${label}: ${pct(share)}"></div>`;
  $('bar-land').innerHTML = seg('d', landD / land, c.d) + seg('r', landR / land, c.r);
  $('bar-votes').innerHTML = seg('d', votesD / votes, c.d) + seg('o', votesO / votes, 'Other') + seg('r', votesR / votes, c.r);
  // Short labels keep the two values on one line when party names are long.
  const [ds, rs] = [c.ds ?? c.d, c.rs ?? c.r];
  setBarLabels('bar-land', [[ds, landD / land], [rs, landR / land]]);
  setBarLabels('bar-votes', [[ds, votesD / votes], [rs, votesR / votes]]);
  $('stats-title').textContent = `${state.year} ${c.race} results`;
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
  if (id < 0 || !data.counties[id]) { tooltip.hidden = true; return; }
  const c = data.counties[id];
  const v = derived[state.year][id];
  const cand = data.meta.elections[state.year];
  const F = data.meta.flags;
  let html = `<div class="tt-title">${esc(c.n)}${c.n === c.s ? '' : `, ${esc(c.s)}`}</div>`;
  if (!v) {
    html += `<div class="tt-row muted">No reported results for this area</div>`;
  } else {
    const col = colorForMargin(v.margin, 'margin').map((x) => Math.round(x * 255)).join(',');
    html +=
      `<div class="tt-margin"><span class="chip" style="background:rgb(${col})"></span>${marginLabel(v.margin)} <span class="muted">${state.year} ${cand.race}</span></div>` +
      `<div class="tt-row"><span>${cand.d}</span><span>${pct(v.d / v.t)} · ${fmt.format(v.d)}</span></div>` +
      `<div class="tt-row"><span>${cand.r}</span><span>${pct(v.g / v.t)} · ${fmt.format(v.g)}</span></div>` +
      (v.t - v.g - v.d >= 0.005 * v.t ? `<div class="tt-row"><span>Other</span><span>${pct((v.t - v.g - v.d) / v.t)} · ${fmt.format(v.t - v.g - v.d)}</span></div>` : '') +
      `<div class="tt-sep"></div>` +
      `<div class="tt-row"><span>Total votes</span><span>${fmt.format(v.t)}</span></div>` +
      `<div class="tt-row"><span>Land area</span><span>${fmt.format(Math.round(c.a))} sq mi</span></div>` +
      `<div class="tt-row"><span>Density</span><span>${fmt1.format(v.density)} votes / sq mi</span></div>`;
    const note = (t) => (html += `<div class="tt-note">${t}</div>`);
    if (v.flag & F.ak) note("Alaska doesn't report by borough. Showing the statewide result.");
    if (v.flag & F.ct) note("Approximated from Connecticut's 2024 planning-region results.");
    if (v.flag & F.uncontested) note(`No ${v.g === 0 ? 'Republican' : 'Democratic'} candidate was on the ballot here, so this isn't a head-to-head margin.`);
    if (v.flag & F.partial) note(`Still counting: about ${v.eevp}% of the expected vote is in.`);
  }
  tooltip.innerHTML = html;
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
  const bottom = panel.width >= window.innerWidth - 1 ? panel.top : window.innerHeight;
  if (y + r.height > bottom - 8) y = pointer.y - r.height - pad;
  y = Math.min(y, bottom - r.height - 8);
  tooltip.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
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
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;

  const panel = $('panel').getBoundingClientRect();
  const bottomSheet = panel.width >= w - 1;
  let visW = w;
  let visH = h;
  if (bottomSheet) {
    visH = Math.max(h - panel.height, h * 0.4);
    viewShift.x = 0;
    viewShift.y = -(h - visH) / 2;
  } else {
    visW = w - panel.right;
    viewShift.x = panel.right / 2;
    viewShift.y = 0;
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

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------

load()
  .then(() => {
    setupUI();
    resize();
    window.addEventListener('resize', resize);
    // Start as the familiar flat map, then raise it.
    writeTarget(texTo);
    texFrom.set(texTo);
    dataFrom.needsUpdate = dataTo.needsUpdate = true;
    updateModeUI();
    updateStats();
    flyTo('tilt', true);
    state.view = 'tilt';
    $('loading').remove();
    requestAnimationFrame(frame);
    setTimeout(() => setMeasure('votes'), reducedMotion ? 0 : 900);
  })
  .catch((err) => {
    console.error(err);
    $('loading').textContent = err.message;
    $('loading').classList.add('error');
  });
