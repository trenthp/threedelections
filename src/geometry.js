import * as THREE from 'three';

// Per-county color + height live in a float texture (TEX_W x TEX_H texels), so
// changing year/mode just rewrites ~3k texels and the GPU extrudes every vertex.
export const TEX_W = 256;
export const TEX_H = 16; // 4096 slots >= number of counties

/**
 * Builds one merged prism mesh for every county plus a line set tracing the
 * top edge of each prism. Vertices carry a county id and a 0/1 "top" flag; the
 * vertex shader lifts top vertices by the county's height.
 */
export function buildCountyGeometry(data) {
  const { coordScale: S, width, height } = data.meta;
  const cx = width / 2;
  const cy = height / 2;

  const pos = [];
  const nrm = [];
  const ids = [];
  const tops = [];
  const index = [];
  const linePos = [];
  const lineIds = [];
  let v = 0;

  const push = (x, y, nx, ny, nz, id, top) => {
    pos.push(x, y);
    nrm.push(nx, ny, nz);
    ids.push(id);
    tops.push(top);
    return v++;
  };

  data.counties.forEach((county, id) => {
    for (const poly of county.p) {
      const rings = poly.map((r) => {
        const pts = [];
        for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k] / S - cx, cy - r[k + 1] / S));
        return pts;
      });
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
  mesh.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));

  // Positions are 2D (z comes from the shader), so Three can't compute bounds itself.
  const bounds = new THREE.Sphere(new THREE.Vector3(), Math.hypot(cx, cy) + 400);
  mesh.boundingSphere = bounds;

  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 2));
  lines.setAttribute('aId', new THREE.BufferAttribute(new Uint16Array(lineIds), 1));
  lines.boundingSphere = bounds;

  return { mesh, lines, vertexCount: v };
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
vec4 countyData(float idf) {
  int id = int(idf + 0.5);
  ivec2 uv = ivec2(id % ${TEX_W}, id / ${TEX_W});
  return mix(texelFetch(uFrom, uv, 0), texelFetch(uTo, uv, 0), uMix);
}
`;

const PRISM_VERT = /* glsl */ `${COMMON}
in vec2 position;
in vec3 normal;
in float aId;
in float aTop;
out vec3 vColor;
out vec3 vNormal;
out float vTop;
flat out float vId;
void main() {
  vec4 d = countyData(aId);
  float h = d.a * uHeightScale;
  vColor = d.rgb;
  vNormal = normal;
  vTop = aTop;
  vId = aId;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, aTop * h, 1.0);
}
`;

const PRISM_FRAG = /* glsl */ `
precision highp float;
uniform float uHover;
uniform vec3 uLightDir;
in vec3 vColor;
in vec3 vNormal;
in float vTop;
flat in float vId;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  float diff = max(dot(n, uLightDir), 0.0);
  float isWall = 1.0 - step(0.5, n.z);
  // Tops show the true color; walls are shaded by orientation and darken toward
  // the ground (fake ambient occlusion) so towers read as solid.
  float light = mix(0.92 + 0.08 * diff, 0.42 + 0.48 * diff, isWall);
  light *= mix(1.0, mix(0.55, 1.0, vTop), isWall);
  vec3 c = vColor * light;
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
