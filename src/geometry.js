import * as THREE from 'three';

// Per-county color + height live in a float texture (TEX_W x TEX_H texels), so
// changing year/mode just rewrites ~3k texels and the GPU extrudes every vertex.
// Rows 0..15 hold color + height; rows 16..31 hold the auxiliary slot for the
// same county (radial circle radius, radial strength).
export const TEX_W = 256;
const SLOT_ROWS = 16; // 4096 slots >= number of counties
export const TEX_H = SLOT_ROWS * 2;
export const AUX_OFFSET = TEX_W * SLOT_ROWS;

// ---------------------------------------------------------------------------
// Shape helpers (world units)

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x - r[i].x) * (r[j].y + r[i].y);
  return a / 2;
}

function ringCentroid(r) {
  let x = 0, y = 0, a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j].x * r[i].y - r[i].x * r[j].y;
    x += (r[j].x + r[i].x) * f;
    y += (r[j].y + r[i].y) * f;
    a += f;
  }
  return a ? { x: x / (3 * a), y: y / (3 * a) } : r[0];
}

/** Signed distance from (x, y) to the polygon's edges: positive inside, negative outside. */
function signedDist(x, y, rings) {
  let inside = false;
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[j], b = r[i];
      if ((b.y > y) !== (a.y > y) && x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x) inside = !inside;
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
    }
  }
  return inside ? best : -best;
}

/**
 * Where a county's circle is centered: the polygon's centroid, unless that falls
 * outside it or hugs an edge (crescents, L shapes), in which case the point
 * farthest from any edge, found by a coarse grid search with refinement.
 */
function circleCenter(rings, area) {
  const c = ringCentroid(rings[0]);
  const cd = signedDist(c.x, c.y, rings);
  // Compact shapes (most counties): the centroid is comfortably inside, so skip the search.
  if (cd >= 0.4 * Math.sqrt(area / Math.PI)) return c;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rings[0]) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  let best = { x: c.x, y: c.y, d: cd };
  let step = Math.max(maxX - minX, maxY - minY) / 12;
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, span = 6;
  for (let iter = 0; iter < 4; iter++) {
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const x = cx + i * step, y = cy + j * step;
        const d = signedDist(x, y, rings);
        if (d > best.d) best = { x, y, d };
      }
    }
    cx = best.x; cy = best.y; step /= 4; span = 4;
  }
  return cd > 0 && cd >= 0.5 * best.d ? c : best;
}

/**
 * Builds one merged prism mesh for every county plus a line set tracing the
 * top edge of each prism. Vertices carry a county id, a 0/1 "top" flag and the
 * county's circle center; the vertex shader lifts top vertices by the county's height.
 *
 * Also returns per-county shape metrics for the radial circle: `area` (world
 * units², all parts) and `reach` (farthest vertex of the main part from the center).
 */
export function buildCountyGeometry(data) {
  const { coordScale: S, width, height } = data.meta;
  const cx = width / 2;
  const cy = height / 2;

  const pos = [];
  const nrm = [];
  const ids = [];
  const tops = [];
  const ctr = [];
  const index = [];
  const linePos = [];
  const lineIds = [];
  const n = data.counties.length;
  const area = new Float32Array(n);
  const reach = new Float32Array(n);
  let v = 0;
  let center;

  const push = (x, y, nx, ny, nz, id, top) => {
    pos.push(x, y);
    nrm.push(nx, ny, nz);
    ids.push(id);
    tops.push(top);
    ctr.push(center.x, center.y);
    return v++;
  };

  data.counties.forEach((county, id) => {
    const polys = county.p.map((poly) =>
      poly.map((r) => {
        const pts = [];
        for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k] / S - cx, cy - r[k + 1] / S));
        return pts;
      }),
    );
    // The circle centers on the largest part; islands and exclaves sit outside it.
    let main = polys[0];
    let mainArea = -1;
    for (const rings of polys) {
      const a = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, h) => s + Math.abs(ringArea(h)), 0);
      area[id] += a;
      if (a > mainArea) { mainArea = a; main = rings; }
    }
    center = main && main[0].length >= 3 ? circleCenter(main, mainArea) : { x: 0, y: 0 };
    for (const p of main?.[0] ?? []) reach[id] = Math.max(reach[id], Math.hypot(p.x - center.x, p.y - center.y));

    for (const rings of polys) {
      const outer = rings[0];
      const holes = rings.slice(1);
      // Outer ring CCW, holes CW: then (dy, -dx) is always the outward wall normal.
      if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse();
      for (const h of holes) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();

      // Top cap
      const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
      const base = v;
      for (const ring of [outer, ...holes]) for (const p of ring) push(p.x, p.y, 0, 0, 127, id, 1);
      for (const f of faces) index.push(base + f[0], base + f[1], base + f[2]);

      // Side walls + top outline
      for (const ring of [outer, ...holes]) {
        const n = ring.length;
        for (let k = 0; k < n; k++) {
          const a = ring[k];
          const b = ring[(k + 1) % n];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = Math.round((dy / len) * 127);
          const ny = Math.round((-dx / len) * 127);
          const a0 = push(a.x, a.y, nx, ny, 0, id, 0);
          const b0 = push(b.x, b.y, nx, ny, 0, id, 0);
          const b1 = push(b.x, b.y, nx, ny, 0, id, 1);
          const a1 = push(a.x, a.y, nx, ny, 0, id, 1);
          index.push(a0, b0, b1, a0, b1, a1);
          linePos.push(a.x, a.y, b.x, b.y);
          lineIds.push(id, id);
        }
      }
    }
  });

  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 2));
  mesh.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(nrm), 3, true));
  mesh.setAttribute('aId', new THREE.BufferAttribute(new Uint16Array(ids), 1));
  mesh.setAttribute('aTop', new THREE.BufferAttribute(new Uint8Array(tops), 1));
  mesh.setAttribute('aCenter', new THREE.BufferAttribute(new Float32Array(ctr), 2));
  mesh.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));

  // Positions are 2D (z comes from the shader), so Three can't compute bounds itself.
  const bounds = new THREE.Sphere(new THREE.Vector3(), Math.hypot(cx, cy) + 400);
  mesh.boundingSphere = bounds;

  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 2));
  lines.setAttribute('aId', new THREE.BufferAttribute(new Uint16Array(lineIds), 1));
  lines.boundingSphere = bounds;

  return { mesh, lines, vertexCount: v, area, reach };
}

/** Flat polylines (state borders, coastline) on the ground plane. */
export function buildLineGeometry(data, lineList, z) {
  const { coordScale: S, width, height } = data.meta;
  const cx = width / 2;
  const cy = height / 2;
  const out = [];
  for (const l of lineList) {
    for (let k = 0; k + 3 < l.length; k += 2) {
      out.push(l[k] / S - cx, cy - l[k + 1] / S, z, l[k + 2] / S - cx, cy - l[k + 3] / S, z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  return g;
}

// ---------------------------------------------------------------------------
// Shaders

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
uniform float uHeightScale;
vec4 countySlot(int slot) {
  ivec2 uv = ivec2(slot % ${TEX_W}, slot / ${TEX_W});
  return mix(texelFetch(uFrom, uv, 0), texelFetch(uTo, uv, 0), uMix);
}
// rgb = color, a = height
vec4 countyData(float idf) { return countySlot(int(idf + 0.5)); }
// r = circle radius (world units), g = radial strength (0 = flat color, 1 = circle)
vec4 countyAux(float idf) { return countySlot(int(idf + 0.5) + ${AUX_OFFSET}); }
`;

const PRISM_VERT = /* glsl */ `${COMMON}
in vec2 position;
in vec3 normal;
in float aId;
in float aTop;
in vec2 aCenter;
out vec3 vColor;
out vec3 vNormal;
out float vTop;
out vec2 vPos;
flat out float vId;
flat out vec2 vCenter;
flat out vec2 vCircle;
void main() {
  vec4 d = countyData(aId);
  float h = d.a * uHeightScale;
  vColor = d.rgb;
  vNormal = normal;
  vTop = aTop;
  vId = aId;
  vPos = position;
  vCenter = aCenter;
  vCircle = countyAux(aId).rg;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, aTop * h, 1.0);
}
`;

const PRISM_FRAG = /* glsl */ `
precision highp float;
uniform float uHover;
uniform vec3 uLightDir;
uniform vec3 uEmpty;
in vec3 vColor;
in vec3 vNormal;
in float vTop;
in vec2 vPos;
flat in float vId;
flat in vec2 vCenter;
flat in vec2 vCircle;
out vec4 fragColor;
void main() {
  vec3 base = vColor;
  if (vCircle.y > 0.001) {
    // Radial: a solid circle whose area is proportional to the county's votes,
    // with an antialiased edge one pixel wide.
    float r = vCircle.x;
    float d = length(vPos - vCenter);
    float aa = fwidth(d);
    float k = 1.0 - smoothstep(r - aa, r + aa, d);
    base = mix(vColor, mix(uEmpty, vColor, k), vCircle.y);
  }
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uLightDir), 0.0);
  float isWall = 1.0 - step(0.5, n.z);
  // Tops show the true color; walls are shaded by orientation and darken toward
  // the ground (fake ambient occlusion) so towers read as solid.
  float light = mix(0.92 + 0.08 * diff, 0.42 + 0.48 * diff, isWall);
  light *= mix(1.0, mix(0.55, 1.0, vTop), isWall);
  vec3 c = base * light;
  if (abs(vId - uHover) < 0.5) c = mix(c, vec3(1.0), 0.45);
  fragColor = vec4(c, 1.0);
}
`;

const PICK_FRAG = /* glsl */ `
precision highp float;
flat in float vId;
out vec4 fragColor;
void main() {
  int id = int(vId + 0.5) + 1;
  fragColor = vec4(float(id % 256) / 255.0, float(id / 256) / 255.0, 0.0, 1.0);
}
`;

const OUTLINE_VERT = /* glsl */ `${COMMON}
in vec2 position;
in float aId;
void main() {
  vec4 d = countyData(aId);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, d.a * uHeightScale + 0.02, 1.0);
}
`;

const OUTLINE_FRAG = /* glsl */ `
precision highp float;
uniform float uOpacity;
out vec4 fragColor;
void main() { fragColor = vec4(0.0, 0.0, 0.0, uOpacity); }
`;

export function createMaterials(uniforms) {
  const shared = { glslVersion: THREE.GLSL3 };
  const prism = new THREE.RawShaderMaterial({
    ...shared,
    uniforms,
    vertexShader: PRISM_VERT,
    fragmentShader: PRISM_FRAG,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const pick = new THREE.RawShaderMaterial({ ...shared, uniforms, vertexShader: PRISM_VERT, fragmentShader: PICK_FRAG });
  const outline = new THREE.RawShaderMaterial({
    ...shared,
    uniforms: { ...uniforms, uOpacity: { value: 0.22 } },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  return { prism, pick, outline };
}
