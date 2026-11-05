// The market manifold: one smooth multi-handle surface, shared by the main thread (node placement,
// flow paths, labels) and manifold.worker.js (mesh).
//
// Data -> layout:   hole radius = sector energy share,  hole order on the ring = sector correlation
// Fixed (no data):  funnel, saddle, tube proportions  — the shape vocabulary only.
//
// 2-D construction on the x–z plane: the solid region is a smooth union of a central plate and one disc per
// sector; each sector disc is pierced by a hole. The 3-D surface is that region inflated with round edges:
//   F(x,y,z) = | (max(d+a, 0), y - c) | - a
// d = 2-D signed distance (negative inside), a = half thickness, c = mid-sheet height (funnel + saddle).

export const MAXS = 24;
const sq = (x) => x * x;

function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }

// ring layout. radii[i] = hole radius of sector i; order = sector indices around the ring
export function layoutRing(radii, order) {
  const S = radii.length;
  const holes = radii.map((r) => ({ r, a: (S >= 9 ? 0.32 : 0.38) * r }));
  const span = (i) => 2 * (holes[i].r + 1.55 * holes[i].a);
  const tot = order.reduce((s, i) => s + span(i), 0);
  const maxOut = Math.max(...holes.map((h) => h.r + 2 * h.a), 10);
  const R = Math.max(tot / (2 * Math.PI) * (S >= 9 ? 1.0 : S >= 7 ? 0.9 : 1.0), maxOut * 1.85, 34);
  let acc = 0;
  order.forEach((i, k) => {
    const w = span(i), th = ((acc + w / 2) / tot) * 2 * Math.PI - Math.PI / 2;
    acc += w;
    const st = S >= 7 ? (k % 2 ? 1.14 : 0.84) : 1;          // two staggered rings when there are many sectors
    holes[i].x = Math.cos(th) * R * st; holes[i].z = Math.sin(th) * R * st; holes[i].th = th;
  });
  const aMean = holes.reduce((s, h) => s + h.a, 0) / Math.max(S, 1);
  const L = {
    holes, R,
    Rc: R * 0.78,               // central plate radius
    ac: aMean * 0.62,           // central plate half thickness
    rc: R * 0.085,              // throat radius
    D: R * 0.46,                // funnel depth
    sig: R * 0.36,              // funnel width
    U: R * 0.13,                // saddle amplitude
  };
  L.ext = Math.max(...holes.map((h) => Math.hypot(h.x, h.z) + h.r + 2 * h.a), L.Rc) + 4;
  return L;
}

// 2-D fields at (x,z): out = [d, a, c]
export function field2(L, x, z, out) {
  const r = Math.hypot(x, z);
  let d = r - L.Rc, hole = r - L.rc, wsum = 0.25, asum = 0.25 * L.ac;
  for (const h of L.holes) {
    const q = Math.hypot(x - h.x, z - h.z);
    d = smin(d, q - (h.r + 2.2 * h.a), h.a * 1.6);
    hole = Math.min(hole, q - h.r);
    const w = Math.exp(-sq(q / (h.r + 2.2 * h.a)) * 2.2);
    wsum += w; asum += w * h.a;
  }
  d = smax(d, -hole, 2.0);
  const a = asum / wsum;
  const th = Math.atan2(z, x), rr = r / L.R;
  const c = -L.D * Math.exp(-sq(r / L.sig)) + L.U * rr * rr * Math.cos(2 * th + 0.7) + L.U * 0.35 * rr * rr * Math.sin(3 * th - 0.4);
  out[0] = d; out[1] = a; out[2] = c;
  return out;
}

const _o = [0, 0, 0];
// height of the upper sheet at (x,z) (null if outside the surface footprint)
export function topY(L, x, z) {
  field2(L, x, z, _o);
  const inner = _o[0] + _o[1];
  if (inner > _o[1]) return null;
  return _o[2] + Math.sqrt(Math.max(sq(_o[1]) - sq(Math.max(inner, 0)), 0));
}
export function sheet(L, x, z, upper) {
  field2(L, x, z, _o);
  const inner = _o[0] + _o[1];
  if (inner > _o[1]) return null;
  const t = Math.sqrt(Math.max(sq(_o[1]) - sq(Math.max(inner, 0)), 0));
  return upper ? _o[2] + t : _o[2] - t;
}

// point on the inner tube of hole h: phi = 0 innermost rim, pi/2 = top of the tube, pi = outer side
export function tubePoint(L, h, th, phi, out) {
  const rho = h.r + h.a - h.a * Math.cos(phi);
  const x = h.x + Math.cos(th) * rho, z = h.z + Math.sin(th) * rho;
  field2(L, x, z, _o);
  out[0] = x; out[2] = z; out[1] = _o[2] + h.a * Math.sin(phi);
  return out;
}

// Surface nets over F. Returns {pos, nrm, idx}
export function buildMesh(L, res = 230) {
  const E = L.ext + 6, h = (2 * E) / res;
  const nx = res, nz = res, nx1 = nx + 1, nz1 = nz + 1;
  // 2-D pass
  const D2 = new Float32Array(nx1 * nz1), A2 = new Float32Array(nx1 * nz1), C2 = new Float32Array(nx1 * nz1);
  let cmin = Infinity, cmax = -Infinity, amax = 0;
  const o = [0, 0, 0];
  for (let k = 0; k < nz1; k++) for (let i = 0; i < nx1; i++) {
    field2(L, -E + i * h, -E + k * h, o);
    const p = i + nx1 * k; D2[p] = o[0]; A2[p] = o[1]; C2[p] = o[2];
    if (o[0] < o[1]) { cmin = Math.min(cmin, o[2]); cmax = Math.max(cmax, o[2]); amax = Math.max(amax, o[1]); }
  }
  const y0 = cmin - amax - 3 * h, y1 = cmax + amax + 3 * h;
  const ny = Math.ceil((y1 - y0) / h), ny1 = ny + 1;
  const F = new Float32Array(nx1 * ny1 * nz1);
  for (let k = 0; k < nz1; k++) for (let i = 0; i < nx1; i++) {
    const p = i + nx1 * k, a = A2[p], inner = D2[p] + a, c = C2[p], ip = Math.max(inner, 0);
    for (let j = 0; j < ny1; j++) {
      const dy = y0 + j * h - c;
      F[i + nx1 * (j + ny1 * k)] = Math.sqrt(ip * ip + dy * dy) - a;
    }
  }
  // vertices: one per sign-changing cell
  const vid = new Int32Array(nx * ny * nz).fill(-1);
  let cap = 1 << 18, pos = new Float32Array(cap * 3), nv = 0;
  const off = [0, 1, nx1, nx1 + 1, nx1 * ny1, nx1 * ny1 + 1, nx1 * ny1 + nx1, nx1 * ny1 + nx1 + 1];
  const cx = [0, 1, 0, 1, 0, 1, 0, 1], cy = [0, 0, 1, 1, 0, 0, 1, 1], cz = [0, 0, 0, 0, 1, 1, 1, 1];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float32Array(8);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const base = i + nx1 * (j + ny1 * k);
    let m = 0;
    for (let q = 0; q < 8; q++) { v[q] = F[base + off[q]]; if (v[q] < 0) m |= 1 << q; }
    if (m === 0 || m === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      const va = v[a], vb = v[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += cx[a] + (cx[b] - cx[a]) * t; sy += cy[a] + (cy[b] - cy[a]) * t; sz += cz[a] + (cz[b] - cz[a]) * t; n++;
    }
    if (nv >= cap) { cap *= 2; const p2 = new Float32Array(cap * 3); p2.set(pos); pos = p2; }
    pos[3 * nv] = -E + (i + sx / n) * h; pos[3 * nv + 1] = y0 + (j + sy / n) * h; pos[3 * nv + 2] = -E + (k + sz / n) * h;
    vid[i + nx * (j + ny * k)] = nv++;
  }
  // quads across sign-changing grid edges
  let icap = 1 << 19, idx = new Uint32Array(icap), ni = 0;
  const C = (i, j, k) => vid[i + nx * (j + ny * k)];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (ni + 6 > icap) { icap *= 2; const i2 = new Uint32Array(icap); i2.set(idx); idx = i2; }
    if (flip) { idx.set([a, d, c, a, c, b], ni); } else { idx.set([a, b, c, a, c, d], ni); }
    ni += 6;
  };
  for (let k = 1; k < nz; k++) for (let j = 1; j < ny; j++) for (let i = 1; i < nx; i++) {
    const p = i + nx1 * (j + ny1 * k), f0 = F[p] < 0;
    if (f0 !== (F[p + 1] < 0)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k), !f0);
    if (f0 !== (F[p + nx1] < 0)) quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1), !f0);
    if (f0 !== (F[p + nx1 * ny1] < 0)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k), !f0);
  }
  pos = pos.slice(0, nv * 3); idx = idx.slice(0, ni);
  // area-weighted vertex normals
  const nrm = new Float32Array(nv * 3);
  for (let t = 0; t < ni; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    const qx = uy * wz - uz * wy, qy = uz * wx - ux * wz, qz = ux * wy - uy * wx;
    for (const s of [a, b, c]) { nrm[s] += qx; nrm[s + 1] += qy; nrm[s + 2] += qz; }
  }
  for (let s = 0; s < nv * 3; s += 3) { const l = Math.hypot(nrm[s], nrm[s + 1], nrm[s + 2]) || 1; nrm[s] /= l; nrm[s + 1] /= l; nrm[s + 2] /= l; }
  // light Laplacian-free smoothing is unnecessary: surface nets on a smooth F is already clean
  return { pos, nrm, idx, nv, nt: ni / 3, h };
}
