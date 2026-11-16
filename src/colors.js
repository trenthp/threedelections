// Diverging blue <-> neutral gray <-> red scale for vote margin.
// Equal step count per arm; the midpoint is a hue-less gray so "even" reads as nothing.
// The arms are lightness-matched (OKLab L 0.85 -> 0.80 -> 0.69 -> 0.61 -> 0.53) and
// stop at a vivid mid tone rather than near-black, so lopsided counties don't carry
// extra visual weight just for being lopsided.

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export const NEUTRAL = '#cfcdc7';
export const DEM_ARM = [NEUTRAL, '#a7c5ec', '#6e9fe0', '#4a80d0', '#3866bb'].map(hex);
export const REP_ARM = [NEUTRAL, '#efaaa0', '#e37a6c', '#d4544a', '#bb3a33'].map(hex);
export const DEM_SOLID = hex('#3b7fd6');
export const REP_SOLID = hex('#d9473d');
export const NO_DATA = hex('#5b5d63');
/** "Empty land": what sparse counties fade toward, and the ground around radial circles. */
export const EMPTY = hex('#34363c');

/** Margin at which the scale saturates (0.7 = 70 points). */
export const MARGIN_CAP = 0.7;

/** Weighted mode: vote density (votes / sq mi) at which color reaches full strength, on a log scale from 1. */
export const WEIGHT_FULL_DENSITY = 1000;
/** Weighted mode: color strength kept by the emptiest counties, so their margin is still legible up close. */
export const WEIGHT_FLOOR = 0.15;

/** Radial mode: vote density at which a county's circle fills its whole footprint. */
export const RADIAL_FULL_DENSITY = 300;

export const COLOR_MODES = ['margin', 'weighted', 'radial', 'winner'];

function sampleArm(arm, t) {
  const x = Math.min(Math.max(t, 0), 1) * (arm.length - 1);
  const i = Math.min(Math.floor(x), arm.length - 2);
  return mixRgb(arm[i], arm[i + 1], x - i);
}

/** Margin ramp color. @param {number} margin (dem - gop) / total, in [-1, 1] */
export function marginColor(margin) {
  return sampleArm(margin >= 0 ? DEM_ARM : REP_ARM, Math.abs(margin) / MARGIN_CAP);
}

/** 0..1 color strength for a vote density: 1 vote/sq mi -> 0, WEIGHT_FULL_DENSITY -> 1. */
export function densityWeight(density) {
  const w = Math.log10(Math.max(density, 1)) / Math.log10(WEIGHT_FULL_DENSITY);
  return WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * Math.min(w, 1);
}

/** Fraction of a county's footprint covered by its radial circle (area ∝ votes cast). */
export function radialFill(density) {
  return Math.min(density / RADIAL_FULL_DENSITY, 1);
}

/**
 * Flat per-county color. Radial mode returns the plain margin color; the shader
 * draws the circle.
 * @param {{margin: number, density: number}} v
 * @param {'margin'|'weighted'|'radial'|'winner'} mode
 * @returns {[number, number, number]} sRGB in 0..1
 */
export function colorForCounty(v, mode) {
  if (mode === 'winner') return v.margin >= 0 ? DEM_SOLID : REP_SOLID;
  const c = marginColor(v.margin);
  if (mode === 'weighted') return mixRgb(EMPTY, c, densityWeight(v.density));
  return c;
}

/** CSS gradient for the legend, D on the left. `strength` fades it toward EMPTY. */
export function legendGradient(strength = 1) {
  const stops = [];
  const n = DEM_ARM.length - 1;
  const css = (c) => toCss(mixRgb(EMPTY, c, strength));
  for (let i = n; i >= 0; i--) stops.push(`${css(DEM_ARM[i])} ${((n - i) / n) * 50}%`);
  for (let i = 1; i <= n; i++) stops.push(`${css(REP_ARM[i])} ${50 + (i / n) * 50}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function winnerGradient() {
  return `linear-gradient(90deg, ${toCss(DEM_SOLID)} 0 50%, ${toCss(REP_SOLID)} 50% 100%)`;
}

/** CSS swatch of a solid circle covering `fill` of a square, as the shader draws it. */
export function radialSwatch(color, fill) {
  // Radius of a disc covering `fill` of a unit square, as a share of the
  // gradient's extent (CSS circles run to the farthest corner, half a diagonal).
  const r = Math.sqrt(fill / Math.PI);
  const half = Math.SQRT1_2;
  const pct = (k) => `${Math.min((k * r) / half, 1) * 100}%`;
  const c = toCss(color);
  const e = toCss(EMPTY);
  // A 1px blend keeps the edge crisp without the jaggies of a hard CSS stop.
  return `radial-gradient(circle, ${c} 0 calc(${pct(1)} - 0.5px), ${e} calc(${pct(1)} + 0.5px))`;
}

export { toCss };
