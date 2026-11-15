// Diverging blue <-> neutral gray <-> red scale for vote margin.
// Equal step count per arm; the midpoint is a hue-less gray so "even" reads as nothing.

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export const NEUTRAL = '#cfcdc7';
export const DEM_ARM = [NEUTRAL, '#9cc0ee', '#4a8ad9', '#2a64b8', '#173f80'].map(hex);
export const REP_ARM = [NEUTRAL, '#f0a59c', '#de5a4f', '#b8302b', '#7d1a1a'].map(hex);
export const DEM_SOLID = hex('#3b7fd6');
export const REP_SOLID = hex('#d9473d');
export const NO_DATA = hex('#5b5d63');

/** Margin at which the scale saturates (0.7 = 70 points). */
export const MARGIN_CAP = 0.7;

function sampleArm(arm, t) {
  const x = Math.min(Math.max(t, 0), 1) * (arm.length - 1);
  const i = Math.min(Math.floor(x), arm.length - 2);
  const f = x - i;
  const a = arm[i];
  const b = arm[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * @param {number} margin (dem - gop) / total, in [-1, 1]
 * @param {'margin'|'winner'} mode
 * @returns {[number, number, number]} sRGB in 0..1
 */
export function colorForMargin(margin, mode) {
  if (mode === 'winner') return margin >= 0 ? DEM_SOLID : REP_SOLID;
  const t = Math.abs(margin) / MARGIN_CAP;
  return sampleArm(margin >= 0 ? DEM_ARM : REP_ARM, t);
}

/** CSS gradient for the legend, D on the left. */
export function legendGradient() {
  const toCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  const stops = [];
  const n = DEM_ARM.length - 1;
  for (let i = n; i >= 0; i--) stops.push(`${toCss(DEM_ARM[i])} ${((n - i) / n) * 50}%`);
  for (let i = 1; i <= n; i++) stops.push(`${toCss(REP_ARM[i])} ${50 + (i / n) * 50}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
