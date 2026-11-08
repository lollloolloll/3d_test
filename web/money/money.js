// Money Map — 20 years of where money sits and where it actually moves.
//
// Encodings (all from data.json, built by tools/build_money.py):
//   ball size        = dollars held in that pool (sqrt scale → area reads as amount)
//   stream           = measured net purchases (Fed Z.1 transactions; stablecoin minting). Cyan = into the pool,
//                      amber = out of it, width = dollars per quarter. Nothing flows where nothing is measured.
//   thin line        = 13-week correlation of weekly returns (blue together, orange opposite); |ρ| < 0.4 hidden
//   timeline         = stacked pool sizes + driver lanes (inflation, rates, oil, dollar …) on the same axis
// Idle motion (stream dashes travelling, gentle camera drift) never changes size, colour or width.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const boot = (t, p) => { $('ldStep').textContent = t; $('ldBar').style.width = `${Math.round(p * 100)}%`; };

const GROUPS = [
  { id: 'cash', label: 'CASH', x: -66, hue: '#5ee4ff' },
  { id: 'bonds', label: 'BONDS', x: -33, hue: '#7ea8ff' },
  { id: 'real', label: 'REAL ASSETS', x: 0, hue: '#ffcf6b' },
  { id: 'stocks', label: 'STOCKS', x: 33, hue: '#b48cff' },
  { id: 'crypto', label: 'CRYPTO', x: 66, hue: '#ff8ad8' },
];
const GH = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
const REGION = new URLSearchParams(location.search).get('r') === 'kr' ? 'kr' : 'us';
const HUBPOS = REGION === 'kr'
  ? { bok: [-52, 32, -48], households: [-15, 38, -56], inst: [17, 34, -54], foreign: [50, 32, -48] }
  : { fed: [-46, 34, -50], households: [2, 38, -56], foreign: [44, 34, -50] };
const SHORT = { cpi: 'Inflation', ff: 'Fed rate', y10: '10-year yield', credit: 'Credit stress', oilp: 'Oil price', dxy: 'Dollar strength', fedbs: 'Fed balance sheet', rrp: 'Fed reverse repo', m2: 'Money supply growth', usdkrw: 'USD/KRW', krrate: 'Korea rate', kr10: 'Korea 10-year', krcpi: 'Korea inflation', kospi: 'KOSPI' };
const laneName = (l) => SHORT[l.id] || l.label;
const flowName = (f) => f.label.replace(/ \(.*\)/, '').replace('money market funds', 'money funds').replace('Foreigners', 'Foreign');
const C_IN = new THREE.Color('#5ee4ff'), C_OUT = new THREE.Color('#ffad5c'), C_TIE = new THREE.Color('#6fa8ff'), C_OPP = new THREE.Color('#ff9a5c');

// amounts are in billions of the region's currency: US $ → $1.23T / $456B; Korea ₩ → ₩2,585조 / ₩4,560억
const fmtB = (b) => {
  if (b == null || !isFinite(b)) return '—';
  const a = Math.abs(b);
  if (REGION === 'kr') return a >= 1000 ? `₩${(b / 1000).toLocaleString('en-US', { maximumFractionDigits: a >= 100000 ? 0 : 1 })}조` : `₩${Math.round(b * 10).toLocaleString('en-US')}억`;
  return a >= 1000 ? `$${(b / 1000).toFixed(a >= 10000 ? 1 : 2)}T` : `$${Math.round(b)}B`;
};
const fmtSB = (b) => (b == null || !isFinite(b) ? '—' : `${b >= 0 ? '+' : '−'}${fmtB(Math.abs(b))}`);
const fmtPct = (p) => (p == null || !isFinite(p) ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`);
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const quarterOf = (t) => { const d = new Date(t); return `${d.getFullYear()} Q${Math.floor(d.getMonth() / 3) + 1}`; };

// ------------------------------------------------------------------ renderer
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
let DPR = Math.min(devicePixelRatio || 1, 1.75);
renderer.setPixelRatio(DPR);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene(); scene.background = new THREE.Color('#03040a');
scene.fog = new THREE.FogExp2(0x03040a, 0.0032);
const cam = new THREE.PerspectiveCamera(42, 1, 0.5, 2000);
cam.position.set(0, 92, 168);
const controls = new OrbitControls(cam, canvas);
controls.target.set(0, 14, -6); controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 40; controls.maxDistance = 420; controls.maxPolarAngle = Math.PI * 0.49;
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.6, 0.2); composer.addPass(bloom);
composer.addPass(new OutputPass());

scene.add(new THREE.AmbientLight(0x8090c0, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-60, 120, 80); scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.8); rim.position.set(80, 40, -120); scene.add(rim);

// stars (decoration)
{
  const n = 1800, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const r = 600 + Math.random() * 500, th = Math.random() * Math.PI * 2, ph = Math.acos(Math.random() * 1.6 - 0.6); p[3 * i] = r * Math.sin(ph) * Math.cos(th); p[3 * i + 1] = r * Math.cos(ph); p[3 * i + 2] = r * Math.sin(ph) * Math.sin(th); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8e9ccc, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0.55, fog: false })));
}
// floor: soft radial glow + faint grid
{
  const g = new THREE.PlaneGeometry(420, 260, 1, 1);
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: {},
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec2 vP; void main(){
      vec2 q = vP / vec2(210.0, 130.0); float r = length(q);
      vec2 gg = abs(fract(vP / 11.0 - 0.5) - 0.5) / fwidth(vP / 11.0);
      float line = 1.0 - min(min(gg.x, gg.y), 1.0);
      float a = (0.10 * (1.0 - smoothstep(0.0, 1.0, r)) + line * 0.07 * (1.0 - smoothstep(0.3, 1.0, r)));
      gl_FragColor = vec4(vec3(0.42, 0.5, 0.9), a); }` });
  const floor = new THREE.Mesh(g, m); floor.rotation.x = -Math.PI / 2; floor.position.y = -0.05; scene.add(floor);
}

// ------------------------------------------------------------------ state
const S = { D: null, T: 0, playing: !REDUCED, speed: 4.345, lastI: -1, nodes: {}, flows: [], links: [], lanesSet: REGION, userTouched: false, hover: null };
let hubs = {};

// ------------------------------------------------------------------ build scene from data
function poolMaterial(hue) {
  const c = new THREE.Color(hue);
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: true,
    uniforms: { uC: { value: c }, uHi: { value: 0 } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uC; uniform float uHi; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.2); float d = max(dot(vN, normalize(vec3(-0.4,0.8,0.5))), 0.0);
        vec3 col = uC * (0.22 + 0.55*d) + uC * f * 1.25 + vec3(1.0) * f * 0.18 + vec3(1.0)*uHi*0.12;
        gl_FragColor = vec4(col, 0.78 + 0.22*f); }`,
  });
}
function makeNodes() {
  const D = S.D;
  const byGroup = {};
  for (const p of D.pools) (byGroup[p.group] ||= []).push(p);
  const root = $('labels');
  for (const g of GROUPS) {
    const list = byGroup[g.id] || [];
    list.forEach((p, k) => {
      const z = (k - (list.length - 1) / 2) * 26 + (g.id === 'stocks' ? 0 : 0);
      const isPrice = p.kind === 'price';
      const geo = isPrice ? new THREE.OctahedronGeometry(1.6, 0) : new THREE.SphereGeometry(1, 48, 32);
      const mat = isPrice ? new THREE.MeshBasicMaterial({ color: g.hue, wireframe: true, transparent: true, opacity: 0.8 }) : poolMaterial(g.hue);
      const mesh = new THREE.Mesh(geo, mat); mesh.position.set(g.x, 2, z); mesh.userData.id = p.id; scene.add(mesh);
      const lab = document.createElement('div'); lab.className = 'pl' + (isPrice ? ' price' : ''); lab.style.setProperty('--hue', g.hue); root.appendChild(lab);
      S.nodes[p.id] = { p, g, mesh, lab, r: 1.6, x: g.x, z, isPrice };
    });
    const gl = document.createElement('div'); gl.className = 'gl'; gl.textContent = g.label; root.appendChild(gl);
    S.nodes['__g_' + g.id] = { gl, x: g.x, z: ((byGroup[g.id] || []).length - 1) / 2 * 26 + 20 };
  }
  for (const h of D.hubs) {
    const pos = HUBPOS[h.id] || [0, 44, -50];
    const m = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.32, 12, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }));
    m.position.set(...pos); m.rotation.x = Math.PI / 2; scene.add(m);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff })); core.position.set(...pos); scene.add(core);
    const lab = document.createElement('div'); lab.className = 'hl'; lab.textContent = h.label; root.appendChild(lab);
    hubs[h.id] = { h, pos: new THREE.Vector3(...pos), lab, m };
  }
}

// flow tubes: built once with radius 1 around the curve; the vertex shader scales the offset by uW (data width)
function flowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uW: { value: 0 }, uT: { value: 0 }, uDir: { value: 1 }, uC: { value: C_IN.clone() }, uA: { value: 0 }, uLen: { value: 100 } },
    vertexShader: `attribute vec3 aCtr; uniform float uW; varying float vU; varying vec3 vN; varying vec3 vV;
      void main(){ vec3 p = aCtr + (position - aCtr) * uW; vU = uv.x; vec4 mv = modelViewMatrix*vec4(p,1.0);
        vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float uT, uDir, uA, uLen; uniform vec3 uC; varying float vU; varying vec3 vN; varying vec3 vV;
      void main(){ float s = vU * uLen / 7.0 - uT * uDir * 1.4; float dash = smoothstep(0.0, 0.35, fract(s)) * (1.0 - smoothstep(0.55, 1.0, fract(s)));
        float edge = pow(max(dot(vN, vV), 0.0), 0.8); float ends = smoothstep(0.0, 0.05, vU) * (1.0 - smoothstep(0.95, 1.0, vU));
        float a = uA * ends * (0.28 + 0.72 * dash) * (0.35 + 0.65 * edge);
        gl_FragColor = vec4(uC * (0.7 + 0.9 * dash), a); }`,
  });
}
function curveBetween(a, b, lift, side = 0) {
  const mid = a.clone().lerp(b, 0.5); mid.y += lift; mid.x += side;
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}
function makeFlows() {
  const D = S.D, perTarget = {};
  for (const f of D.flows) {
    const k = (perTarget[f.to] = (perTarget[f.to] || 0) + 1) - 1;
    S.flows.push({ f, k, mesh: null });
  }
}
function buildFlowMesh(F) {
  const to = S.nodes[F.f.to], toHub = hubs[F.f.to], fromHub = hubs[F.f.from], fromNode = S.nodes[F.f.from];
  if (!to && !toHub) return;
  const b = to ? new THREE.Vector3(to.x, to.mesh.position.y + to.r * 0.9, to.z) : toHub.pos.clone();
  const a = fromHub ? fromHub.pos.clone() : new THREE.Vector3(fromNode.x, fromNode.mesh.position.y + fromNode.r, fromNode.z);
  const curve = curveBetween(a, b, fromHub || toHub ? 6 : 26, (F.k - 0.5) * 7);
  if (F.mesh) { scene.remove(F.mesh); F.mesh.geometry.dispose(); }
  const TS = 72, RS = 10;
  const geo = new THREE.TubeGeometry(curve, TS, 1, RS, false);
  const ctr = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i <= TS; i++) { const c = curve.getPointAt(i / TS); for (let j = 0; j <= RS; j++) { const v = i * (RS + 1) + j; ctr[3 * v] = c.x; ctr[3 * v + 1] = c.y; ctr[3 * v + 2] = c.z; } }
  geo.setAttribute('aCtr', new THREE.BufferAttribute(ctr, 3));
  const mat = F.mat || (F.mat = flowMaterial());
  mat.uniforms.uLen.value = curve.getLength();
  F.mesh = new THREE.Mesh(geo, mat); F.mesh.renderOrder = 2; F.anchorR = to ? to.r : 0; F.anchorFromR = fromNode?.r;
  scene.add(F.mesh);
}
function makeLinks() {
  for (const L of S.D.links) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(25 * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: C_TIE, transparent: true, opacity: 0, depthWrite: false }));
    line.renderOrder = 1; scene.add(line);
    S.links.push({ L, line, built: -1 });
  }
}
function placeLink(K) {
  const a = S.nodes[K.L.a], b = S.nodes[K.L.b]; if (!a || !b) return;
  const pa = new THREE.Vector3(a.x, a.mesh.position.y + a.r, a.z), pb = new THREE.Vector3(b.x, b.mesh.position.y + b.r, b.z);
  const c = curveBetween(pa, pb, 6 + pa.distanceTo(pb) * 0.12);
  const arr = K.line.geometry.attributes.position.array;
  for (let i = 0; i <= 24; i++) { const p = c.getPoint(i / 24); arr[3 * i] = p.x; arr[3 * i + 1] = p.y; arr[3 * i + 2] = p.z; }
  K.line.geometry.attributes.position.needsUpdate = true; K.line.geometry.computeBoundingSphere();
}

// ------------------------------------------------------------------ per-frame data
const val = (arr, T) => { const i = Math.floor(T), f = T - i, a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)]; if (a == null) return null; if (b == null) return a; return lerp(a, b, f); };
const radiusFor = (v) => (v == null ? 0 : Math.max(0.7, (S.D?.meta.rscale || 0.042) * Math.sqrt(Math.max(v, 0))));

function applyFrame(T) {
  const D = S.D, i = Math.floor(T);
  let relayout = false;
  for (const n of Object.values(S.nodes)) {
    if (!n.p) continue;
    if (n.isPrice) { n.r = 1.6; n.mesh.position.y = 3.2; n.mesh.visible = true; continue; }
    const v = val(n.p.v, T), r = radiusFor(v);
    n.v = v; n.mesh.visible = v != null;
    if (v != null) { n.mesh.scale.setScalar(r); n.mesh.position.y = r + 0.4; if (Math.abs(r - n.r) > 0.35) relayout = true; n.r = r; }
  }
  for (const F of S.flows) {
    const w = F.f.q[i];
    if (!F.mesh || relayout || Math.abs((S.nodes[F.f.to]?.r ?? 0) - (F.anchorR ?? 0)) > 0.35) buildFlowMesh(F);
    if (!F.mesh) continue;
    const to = S.nodes[F.f.to];
    const vis = w != null && w !== 0 && to?.mesh.visible !== false && (!S.nodes[F.f.from] || S.nodes[F.f.from].mesh.visible);
    F.mesh.visible = vis && layerOn('flows');
    if (!vis) continue;
    const q = Math.abs(w);                                              // $bn per quarter
    const qs = Math.sqrt(q) * (S.D.meta.rscale || 0.042) / 0.042;      // same currency scaling as the balls
    F.mat.uniforms.uW.value = 0.18 + 0.075 * qs;
    F.mat.uniforms.uDir.value = w > 0 ? 1 : -1;
    F.mat.uniforms.uC.value.copy(w > 0 ? C_IN : C_OUT);
    F.mat.uniforms.uA.value = clamp(0.35 + qs / 40, 0.35, 1.0);
  }
  for (const K of S.links) {
    if (K.built !== S.layoutGen || relayout) { placeLink(K); K.built = S.layoutGen; }
    const c = K.L.c[i];
    const on = c != null && Math.abs(c) >= 0.4 && S.nodes[K.L.a]?.mesh.visible && S.nodes[K.L.b]?.mesh.visible && layerOn('links');
    K.line.visible = !!on;
    if (on) { K.line.material.color.copy(c > 0 ? C_TIE : C_OPP); K.line.material.opacity = clamp((Math.abs(c) - 0.3) / 0.7, 0.15, 0.85); }
  }
  if (relayout) S.layoutGen = (S.layoutGen || 0) + 1;
}
const layerOn = () => true;

// ------------------------------------------------------------------ HUD (once per week index)
function yearAgo(arr, i) { const j = i - 52; return j >= 0 ? arr[j] : null; }
function updateHud(i) {
  const D = S.D, t = D.weeks[i];
  $('wDate').textContent = fmtDate(t);
  $('wQuarter').textContent = quarterOf(t);
  const anyEst = D.pools.some((p) => p.est && p.est[i] && p.v[i] != null);
  $('wEst').hidden = !anyEst;
  // flows this quarter
  const rows = D.flows.map((f) => ({ f, q: f.q[i] }));
  const mx = Math.max(1, ...rows.map((r) => Math.abs(r.q ?? 0)));
  rows.sort((a, b) => Math.abs(b.q ?? -1) - Math.abs(a.q ?? -1));
  const published = rows.some((r) => r.q != null && r.f.per === 'q');
  const fastNote = D.flows.some((f) => f.per !== 'q') ? (REGION === 'kr' ? ' KRX investor flows are monthly (shown as the last 13 weeks).' : ' Stablecoin minting is measured weekly (shown as the last 13 weeks).') : '';
  $('flowQ').textContent = published ? `${quarterOf(t)} · per quarter` : `${quarterOf(t)} · not published yet`;
  $('flowRows').innerHTML = (published ? '' : `<div class="empty">${esc(D.meta.flows_name || 'Official flow data')} for this quarter is not out yet (latest: ${esc(D.meta.z1_latest)}).${fastNote}</div>`) +
    rows.map(({ f, q }) => {
      if (q == null) return `<div class="fr none" title="${esc(f.src)}"><span class="n">${esc(flowName(f))}</span><span class="bar"></span><span class="v">—</span></div>`;
      const w = Math.abs(q) / mx * 50, pos = q >= 0;
      return `<div class="fr" title="${esc(f.label)} · ${esc(f.src)}${f.note ? ' · ' + esc(f.note) : ''}"><span class="n">${esc(flowName(f))}</span><span class="bar"><i style="${pos ? 'left:50%' : `left:${50 - w}%`};width:${w}%;background:${pos ? 'var(--in)' : 'var(--out)'}"></i></span><span class="v ${pos ? 'up' : 'dn'}">${fmtSB(q)}</span></div>`;
    }).join('');
  // biggest changes vs 1y
  const ch = D.pools.filter((p) => p.kind !== 'price').map((p) => { const a = p.v[i], b = yearAgo(p.v, i); return { p, a, d: a != null && b ? (a / b - 1) * 100 : null, dd: a != null && b != null ? a - b : null }; })
    .filter((x) => x.d != null).sort((x, y) => Math.abs(y.dd) - Math.abs(x.dd)).slice(0, 6);
  $('chgRows').innerHTML = ch.map((x) => `<div class="cr"><span class="n">${esc(x.p.label)}</span><span class="v"><span class="${x.dd >= 0 ? 'up' : 'dn'}">${fmtSB(x.dd)}</span> <span class="mute">${fmtPct(x.d)}</span></span></div>`).join('') || '<div class="empty">—</div>';
  // co-movement
  const LBL = Object.fromEntries(D.pools.map((p) => [p.id, p.label.replace(/ \(.*\)/, '')]));
  const cs = D.links.map((L) => ({ L, c: L.c[i] })).filter((x) => x.c != null && Math.abs(x.c) >= 0.4).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 5);
  $('tieRows').innerHTML = cs.map((x) => `<div class="cr"><span class="n">${esc(LBL[x.L.a])} ↔ ${esc(LBL[x.L.b])}</span><span class="v" style="color:${x.c > 0 ? 'var(--tie)' : 'var(--opp)'}">${x.c > 0 ? 'together' : 'opposite'} ${Math.abs(x.c).toFixed(2)}</span></div>`).join('') || '<div class="empty">Nothing strongly linked right now.</div>';
  // drivers
  const lanes = D.lanes.filter((l) => l.group === S.lanesSet || (S.lanesSet === 'us' && l.group === 'us'));
  const DRV = REGION === 'kr' ? ['krrate', 'kr10', 'krcpi', 'usdkrw', 'kospi', 'ff', 'y10', 'oilp'] : ['cpi', 'ff', 'y10', 'credit', 'oilp', 'dxy', 'usdkrw', 'krrate'];
  $('drv').innerHTML = DRV.map((id) => D.lanes.find((l) => l.id === id)).filter(Boolean)
    .map((l) => { const v = l.v[i], v1 = yearAgo(l.v, i); const d = v != null && v1 != null ? v - v1 : null;
      return `<dt title="${esc(l.label)}">${esc(laneName(l))}</dt><dd>${v == null ? '—' : fmtLane(l, v)} <span class="mute">${d == null ? '' : (d >= 0 ? '▲' : '▼') + fmtLane(l, Math.abs(d), true)}</span></dd>`; }).join('');
  // pool labels content
  for (const n of Object.values(S.nodes)) {
    if (!n.p) continue;
    let html;
    if (n.isPrice) {
      const lane = D.lanes.find((l) => l.id === (n.p.lane || (n.p.id === 'oil' ? 'oilp' : 'kospi')));
      const v = lane?.v[i], v1 = lane ? yearAgo(lane.v, i) : null, d = v != null && v1 ? (v / v1 - 1) * 100 : null;
      html = `<div class="k">${esc(n.p.label)}</div><div class="v">${v == null ? '—' : fmtLane(lane, v)}<small class="${d == null ? 'mute' : d >= 0 ? 'up' : 'dn'}">${fmtPct(d)}</small></div>`;
    } else {
      const v = n.p.v[i], v1 = yearAgo(n.p.v, i), d = v != null && v1 ? (v / v1 - 1) * 100 : null, est = n.p.est && n.p.est[i];
      html = `<div class="k">${esc(n.p.label)}</div><div class="v">${est ? '<span class="e" title="estimate">~</span>' : ''}${fmtB(v)}<small class="${d == null ? 'mute' : d >= 0 ? 'up' : 'dn'}">${fmtPct(d)}</small></div>`;
    }
    if (n.lab._h !== html) { n.lab.innerHTML = html; n.lab._h = html; n.lab._w = 0; n.lab._h2 = 0; }
  }
  // chapter card when passing a big move
  const ev = D.events.find((e) => Math.abs(e.t - t) < 3.5 * 86400e3);
  if (ev && S.playing && S.lastEv !== ev.t) { S.lastEv = ev.t; showChapter(ev); }
}
const big = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : null);
const fmtLane = (l, v, delta = false) => (l.unit === '%' || l.unit === 'pp' ? `${v.toFixed(2)}${delta ? 'pp' : '%'}`
  : l.unit === '$' ? `$${big(v) ?? v.toFixed(0)}` : l.unit === '₩' ? `₩${Math.round(v).toLocaleString('en-US')}`
  : l.unit === '$T' ? `$${v.toFixed(2)}T` : big(v) ?? v.toFixed(1));
let chapTimer = 0;
function showChapter(ev) {
  const el = $('chapter');
  const mv = ev.moves.map((m) => `${esc(m.k)} <b class="${m.pct >= 0 ? 'up' : 'dn'}">${fmtPct(m.pct)}</b>`).join(' · ');
  const RL = S.D.meta.rate_labels || { ff: 'Fed rate', y10: '10y yield' };
  const rt = ev.rates?.ff ? ` · ${esc(RL.ff)} ${ev.rates.ff >= 0 ? '+' : '−'}${Math.abs(ev.rates.ff).toFixed(2)}pp` : '';
  el.innerHTML = `<div class="t">Big move · 4 weeks to ${fmtDate(ev.t)}</div>${mv}${rt}`;
  el.hidden = false; clearTimeout(chapTimer); chapTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

// ------------------------------------------------------------------ timeline canvas
const tl = $('tl'), tctx = tl.getContext('2d');
let tlGeom = null;
function drawTimeline() {
  const D = S.D; if (!D) return;
  const r = tl.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (tl.width !== Math.round(r.width * dpr) || tl.height !== Math.round(r.height * dpr)) { tl.width = Math.round(r.width * dpr); tl.height = Math.round(r.height * dpr); tlGeom = null; }
  const W = r.width, H = r.height, ctx = tctx;
  if (W < 50 || H < 50) return;
  if (!tlGeom) tlGeom = renderTimelineBase(W, H, dpr);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, tl.width, tl.height); ctx.drawImage(tlGeom.img, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = tlGeom.x0 + (S.T / (D.weeks.length - 1)) * tlGeom.w;
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - 14); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, 4, 3, 0, 7); ctx.fill();
  // lane values at playhead
  ctx.font = '500 10.5px "JetBrains Mono", monospace'; ctx.textAlign = 'right';
  const i = Math.round(S.T);
  tlGeom.lanes.forEach(({ l, y0, h }) => { const v = l.v[i]; ctx.fillStyle = 'rgba(238,241,251,.9)'; ctx.fillText(v == null ? '—' : fmtLane(l, v), W - 4, y0 + h * 0.62); });
}
function renderTimelineBase(W, H, dpr) {
  const D = S.D, off = document.createElement('canvas'); off.width = Math.round(W * dpr); off.height = Math.round(H * dpr);
  const ctx = off.getContext('2d'); ctx.scale(dpr, dpr);
  const narrow = W < 600, x0 = narrow ? 84 : 132, w = W - x0 - (narrow ? 50 : 64), n = D.weeks.length, X = (k) => x0 + (k / (n - 1)) * w;
  const stackH = W < 600 ? 52 : 70, y0 = 6;
  // stacked pool sizes (absolute $), groups in risk order
  const pools = GROUPS.flatMap((g) => D.pools.filter((p) => p.group === g.id && p.kind !== 'price').map((p) => ({ p, hue: g.hue })));
  const tot = new Float64Array(n); for (const { p } of pools) for (let k = 0; k < n; k++) tot[k] += p.v[k] || 0;
  const mxT = Math.max(...tot);
  const base = new Float64Array(n);
  for (const { p, hue } of pools) {
    ctx.beginPath();
    for (let k = 0; k < n; k++) { const yy = y0 + stackH - ((base[k] + (p.v[k] || 0)) / mxT) * stackH; k ? ctx.lineTo(X(k), yy) : ctx.moveTo(X(k), yy); }
    for (let k = n - 1; k >= 0; k--) ctx.lineTo(X(k), y0 + stackH - (base[k] / mxT) * stackH);
    ctx.closePath(); ctx.fillStyle = hue + '55'; ctx.fill(); ctx.strokeStyle = hue + 'aa'; ctx.lineWidth = 0.6; ctx.stroke();
    for (let k = 0; k < n; k++) base[k] += p.v[k] || 0;
  }
  ctx.font = '600 10px Inter, sans-serif'; ctx.fillStyle = 'rgba(163,171,196,.9)'; ctx.textAlign = 'left';
  ctx.fillText('MONEY HELD', 8, y0 + 12);
  ctx.font = '500 10px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(107,115,144,1)';
  ctx.fillText(`total ${fmtB(tot[n - 1])}`, 8, y0 + 26);
  if (!narrow) ctx.fillText(`(${fmtB(tot[0])} in ${new Date(D.weeks[0]).getFullYear()})`, 8, y0 + 39);
  // events
  for (const e of D.events) {
    const k = D.weeks.findIndex((t) => t >= e.t); if (k < 0) continue;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.arc(X(k), y0 + 2, 2.4, 0, 7); ctx.fill();
  }
  // lanes
  const sel = S.lanesSet === 'us' ? ['cpi', 'ff', 'y10', 'credit', 'oilp', 'dxy'] : ['krrate', 'kr10', 'krcpi', 'usdkrw', 'kospi', 'ff'];
  const lanes = sel.slice(0, narrow ? 3 : 6).map((id) => D.lanes.find((l) => l.id === id)).filter(Boolean);
  const top = y0 + stackH + 8, lh = (H - top - 16) / lanes.length;
  const out = [];
  lanes.forEach((l, q) => {
    const yA = top + q * lh, vals = l.v.filter((v) => v != null); if (!vals.length) return;
    const lo = Math.min(...vals), hi = Math.max(...vals), rr = hi - lo || 1;
    ctx.strokeStyle = 'rgba(160,172,255,.08)'; ctx.beginPath(); ctx.moveTo(x0, yA + lh - 0.5); ctx.lineTo(x0 + w, yA + lh - 0.5); ctx.stroke();
    ctx.beginPath(); let pen = false;
    for (let k = 0; k < n; k++) { const v = l.v[k]; if (v == null) { pen = false; continue; } const yy = yA + lh - 3 - ((v - lo) / rr) * (lh - 6); pen ? ctx.lineTo(X(k), yy) : ctx.moveTo(X(k), yy); pen = true; }
    ctx.strokeStyle = 'rgba(222,228,255,.75)'; ctx.lineWidth = 1; ctx.stroke();
    if (l.unit === '%' && lo < 0 && hi > 0) { const yz = yA + lh - 3 - ((0 - lo) / rr) * (lh - 6); ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x0, yz); ctx.lineTo(x0 + w, yz); ctx.stroke(); ctx.setLineDash([]); }
    ctx.font = '500 10.5px Inter, sans-serif'; ctx.fillStyle = 'rgba(163,171,196,.95)'; ctx.textAlign = 'left';
    ctx.fillText(laneName(l), 8, yA + lh * 0.62);
    out.push({ l, y0: yA, h: lh });
  });
  // year ticks
  ctx.font = '500 10px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(107,115,144,1)'; ctx.textAlign = 'center';
  let lastY = null;
  D.weeks.forEach((t, k) => { const y = new Date(t).getFullYear(); if (y !== lastY) { lastY = y; if (y % (narrow ? 5 : 2) === 0) { ctx.fillText(String(y), X(k), H - 3); ctx.fillStyle = 'rgba(160,172,255,.06)'; ctx.fillRect(X(k), y0, 1, H - y0 - 14); ctx.fillStyle = 'rgba(107,115,144,1)'; } } });
  return { img: off, x0, w, lanes: out };
}
function scrubTo(clientX) {
  const r = tl.getBoundingClientRect(); if (!tlGeom) return;
  const f = clamp((clientX - r.left - tlGeom.x0) / tlGeom.w, 0, 1);
  S.T = f * (S.D.weeks.length - 1); S.userTouched = true;
}
let drag = false;
tl.addEventListener('pointerdown', (e) => { drag = true; tl.setPointerCapture(e.pointerId); S.playing = false; updatePlay(); scrubTo(e.clientX); });
tl.addEventListener('pointermove', (e) => {
  if (drag) { scrubTo(e.clientX); return; }
  if (!tlGeom) return;
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const D = S.D, n = D.weeks.length;
  const ev = D.events.find((ev) => { const k = D.weeks.findIndex((t) => t >= ev.t); return Math.abs(tlGeom.x0 + (k / (n - 1)) * tlGeom.w - x) < 6 && y < 16; });
  if (ev) showTip(`<h4>Big move · ${fmtDate(ev.t)}</h4><div class="sub">4-week change, largest vs each series' own history</div><table>${ev.moves.map((m) => `<tr><td>${esc(m.k)}</td><td class="${m.pct >= 0 ? 'up' : 'dn'}">${fmtPct(m.pct)}</td></tr>`).join('')}<tr><td>${esc((D.meta.rate_labels || {}).ff || 'Fed rate')}</td><td>${ev.rates?.ff == null ? '—' : (ev.rates.ff >= 0 ? '+' : '−') + Math.abs(ev.rates.ff).toFixed(2) + 'pp'}</td></tr><tr><td>${esc((D.meta.rate_labels || {}).y10 || '10y yield')}</td><td>${ev.rates?.y10 == null ? '—' : (ev.rates.y10 >= 0 ? '+' : '−') + Math.abs(ev.rates.y10).toFixed(2) + 'pp'}</td></tr></table>`, e.clientX, e.clientY - 150);
  else hideTip();
});
tl.addEventListener('pointerup', () => { drag = false; });
tl.addEventListener('pointerleave', () => hideTip());

// ------------------------------------------------------------------ controls
function updatePlay() {
  $('playIco').setAttribute('d', S.playing ? 'M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z' : 'M5 3.5v9l7-4.5z');
  for (const b of document.querySelectorAll('[data-sp]')) b.classList.toggle('on', +b.dataset.sp === S.speed);
}
$('bPlay').onclick = () => { if (S.T >= S.D.weeks.length - 1.01) S.T = 0; S.playing = !S.playing; S.userTouched = true; updatePlay(); };
for (const b of document.querySelectorAll('[data-sp]')) b.onclick = () => { S.speed = +b.dataset.sp; S.playing = true; updatePlay(); };
function jumpEvent(dir) {
  const D = S.D, t = D.weeks[Math.round(S.T)];
  const evs = dir > 0 ? D.events.filter((e) => e.t > t + 86400e3) : D.events.filter((e) => e.t < t - 86400e3).reverse();
  const e = evs[0]; if (!e) return;
  S.T = Math.max(0, D.weeks.findIndex((w) => w >= e.t)); S.playing = false; updatePlay(); S.lastEv = null; showChapter(e); S.lastEv = e.t;
}
$('bPrev').onclick = () => jumpEvent(-1); $('bNext').onclick = () => jumpEvent(1);
$('lUS').onclick = () => { S.lanesSet = 'us'; $('lUS').classList.add('on'); $('lKR').classList.remove('on'); tlGeom = null; };
$('lKR').onclick = () => { S.lanesSet = 'kr'; $('lKR').classList.add('on'); $('lUS').classList.remove('on'); tlGeom = null; };
$('helpBtn').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = (e) => { if (e.target === $('help')) $('help').hidden = true; };
addEventListener('keydown', (e) => {
  if (!S.D) return;
  if (e.key === ' ') { e.preventDefault(); $('bPlay').click(); }
  else if (e.key === 'ArrowRight') { e.shiftKey ? jumpEvent(1) : (S.T = Math.min(S.D.weeks.length - 1, Math.round(S.T) + 1), S.playing = false, updatePlay()); }
  else if (e.key === 'ArrowLeft') { e.shiftKey ? jumpEvent(-1) : (S.T = Math.max(0, Math.round(S.T) - 1), S.playing = false, updatePlay()); }
  else if (e.key === '?') $('help').hidden = !$('help').hidden;
  else if (e.key === 'Escape') $('help').hidden = true;
});

// ------------------------------------------------------------------ hover tooltip on pools
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let mpos = null;
canvas.addEventListener('pointermove', (e) => { mpos = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerleave', () => { mpos = null; hideTip(); });
canvas.addEventListener('pointerdown', (e) => { S.userTouched = true; mpos = [e.clientX, e.clientY]; });   // tap shows the tooltip on touch screens
function showTip(html, x, y) { const t = $('tip'); t.innerHTML = html; t.style.display = 'block'; const w = t.offsetWidth, h = t.offsetHeight; t.style.left = clamp(x + 16, 8, innerWidth - w - 8) + 'px'; t.style.top = clamp(y + 16, 8, innerHeight - h - 8) + 'px'; }
function hideTip() { $('tip').style.display = 'none'; }
function poolTip(n) {
  const D = S.D, i = Math.round(S.T), p = n.p;
  const ins = D.flows.filter((f) => f.to === p.id || f.from === p.id).map((f) => ({ f, q: f.q[i] == null ? null : f.q[i] * (f.from === p.id ? -1 : 1) }));
  const v = p.v[i], v1 = yearAgo(p.v, i);
  const rows = n.isPrice ? [] : [['Held', fmtB(v)], ['vs 1 year ago', v != null && v1 ? `${fmtSB(v - v1)} (${fmtPct((v / v1 - 1) * 100)})` : '—']];
  for (const x of ins) rows.push([x.f.label, x.q == null ? 'not published' : `<span class="${x.q >= 0 ? 'up' : 'dn'}">${fmtSB(x.q)}</span> / qtr`]);
  const net = ins.filter((x) => x.f.per !== 'm' && !hubs[x.f.to]);   // investor-type trades and loans to a hub are not money in/out of the pool
  if (ins.some((x) => x.f.per === 'm')) rows.push(['', '<span class="mute">KRX: one group\'s net buying is another\'s net selling — this shows who buys, not new money</span>']);
  if (!n.isPrice && v != null && v1 && net.length) {
    const flow4 = net.reduce((s, x) => { let a = 0; for (let k = i - 51; k <= i; k++) { const w = x.f.w[k]; if (w != null) a += w * (x.f.from === p.id ? -1 : 1); } return s + a; }, 0);
    rows.push(['Last 12 months: money in', `<span class="${flow4 >= 0 ? 'up' : 'dn'}">${fmtSB(flow4)}</span>`]);
    rows.push(['Last 12 months: price & other', fmtSB(v - v1 - flow4)]);
  }
  const est = p.est && p.est[i];
  return `<h4>${esc(p.label)}</h4><div class="sub">${esc(GH[p.group].label)}${est ? ' · this week is an estimate' : ''}</div><table>${rows.map(([k, x]) => `<tr><td>${esc(k)}</td><td>${x}</td></tr>`).join('')}</table><div class="src">${esc(p.src)}${p.note ? '<br>' + esc(p.note) : ''}</div>`;
}

// ------------------------------------------------------------------ labels
const proj = new THREE.Vector3();
function scr(x, y, z) { proj.set(x, y, z).project(cam); return proj.z < 1 ? [(proj.x + 1) / 2 * innerWidth, (1 - proj.y) / 2 * innerHeight] : null; }
// labels never overlap: hubs first, then pools by size (largest wins), then group names; anything colliding is hidden
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
function placeLabels() {
  const tlTop = $('timeline').getBoundingClientRect().top, taken = [];
  const put = (el, p, anchorBottom = true) => {
    if (!p || p[1] < 96 || p[1] > tlTop - 4 || p[0] < 0 || p[0] > innerWidth) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    const w = el._w || (el._w = el.offsetWidth), h = el._h2 || (el._h2 = el.offsetHeight);
    const r = anchorBottom ? [p[0] - w / 2 - 2, p[1] - h - 2, p[0] + w / 2 + 2, p[1] + 2] : [p[0] - w / 2, p[1], p[0] + w / 2, p[1] + h];
    if (taken.some((t) => overlaps(t, r))) { el.style.display = 'none'; return; }
    taken.push(r); el.style.left = p[0] + 'px'; el.style.top = p[1] + 'px';
  };
  for (const h of Object.values(hubs)) put(h.lab, scr(h.pos.x, h.pos.y + 4.5, h.pos.z));
  const pools = Object.values(S.nodes).filter((n) => n.p).sort((a, b) => (b.isPrice ? -1 : b.v ?? 0) - (a.isPrice ? -1 : a.v ?? 0));
  for (const n of pools) put(n.lab, n.mesh.visible && scr(n.x, n.mesh.position.y + n.r + 1.2, n.z));
  for (const n of Object.values(S.nodes)) if (n.gl) put(n.gl, scr(n.x, 0, n.z), false);
}

// ------------------------------------------------------------------ loop
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); composer.setSize(w, h); bloom.setSize(w * DPR, h * DPR);
  cam.aspect = w / h;
  // keep the five groups in view: push the camera back on narrow screens, shift the view up above the timeline
  const narrow = w < 900;
  const sideW = w >= 1100 ? 356 : 0;                    // side panel on the right: centre the map in the free space
  cam.setViewOffset(w, h, sideW / 2, narrow ? h * 0.08 : h * 0.1, w, h);
  cam.updateProjectionMatrix();
  if (!S.userTouched) { const k = clamp(1.6 / cam.aspect, 1, 2.6); cam.position.set(0, 92 * k * 0.92, 168 * k); }
  tlGeom = null;
}
addEventListener('resize', resize);

let last = performance.now(), flowT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1); last = now;
  if (!S.D) return;
  const N = S.D.weeks.length - 1;
  if (S.playing) { S.T += S.speed * dt; if (S.T >= N) { S.T = N; S.playing = false; updatePlay(); } }
  const i = Math.round(S.T);
  applyFrame(Math.min(S.T, N));
  if (i !== S.lastI) { S.lastI = i; updateHud(i); }
  flowT += REDUCED ? 0 : dt;
  for (const F of S.flows) if (F.mat) F.mat.uniforms.uT.value = flowT;
  for (const h of Object.values(hubs)) h.m.rotation.z += REDUCED ? 0 : dt * 0.3;
  controls.update();
  placeLabels();
  // hover
  if (mpos && !drag) {
    mouse.set(mpos[0] / innerWidth * 2 - 1, -(mpos[1] / innerHeight) * 2 + 1);
    ray.setFromCamera(mouse, cam);
    const hit = ray.intersectObjects(Object.values(S.nodes).filter((n) => n.mesh && n.mesh.visible).map((n) => n.mesh))[0];
    if (hit) { const n = S.nodes[hit.object.userData.id]; showTip(poolTip(n), mpos[0], mpos[1]); canvas.style.cursor = 'help'; }
    else if (!$('tip').innerHTML.startsWith('<h4>Big move')) { hideTip(); canvas.style.cursor = ''; }
  }
  drawTimeline();
  composer.render();
}

// ------------------------------------------------------------------ boot
async function main() {
  boot('Loading 20 years of data', 0.2);
  for (const [id, on] of [['rUS', REGION === 'us'], ['rKR', REGION === 'kr']]) $(id).classList.toggle('on', on);
  $('lUS').classList.toggle('on', REGION === 'us'); $('lKR').classList.toggle('on', REGION === 'kr');
  const r = await fetch(REGION === 'kr' ? 'data_kr.json' : 'data.json', { cache: 'no-cache' });
  if (!r.ok) {
    boot(REGION === 'kr' ? 'Korea view not built yet: it needs a Bank of Korea ECOS key (ECOS_API_KEY) and python tools/build_money.py' : 'data.json missing — run python tools/build_money.py', 0.2);
    return;
  }
  if (REGION === 'us') fetch('data_kr.json', { method: 'HEAD', cache: 'no-cache' }).then((x) => { if (!x.ok) { $('rKR').classList.add('off'); $('rKR').title = 'Korea view needs a Bank of Korea ECOS key'; } }).catch(() => {});
  S.D = await r.json();
  boot('Building the map', 0.7);
  const D = S.D;
  $('span').textContent = `${new Date(D.meta.from).getFullYear()}–${new Date(D.meta.to).getFullYear()}`;
  $('cur').textContent = REGION === 'kr' ? 'Korea · ₩ (조 = trillion won)' : 'US · US$';
  if (REGION === 'kr') document.title = 'Money Map · Korea';
  // per-quarter amount for every flow: Z.1 rates are already quarterly (w·13); weekly-measured flows sum their last 13 weeks
  for (const f of D.flows) {
    f.per ||= /weekly/.test(f.note || '') ? 'w' : 'q';
    f.q = f.w.map((w, k) => { if (w == null) return null; if (f.per === 'q') return w * 13; let a = 0; for (let j = Math.max(0, k - 12); j <= k; j++) a += f.w[j] || 0; return a; });
  }
  makeNodes(); makeFlows(); makeLinks();
  resize();
  S.T = 0; updatePlay();
  applyFrame(0); updateHud(0);
  requestAnimationFrame(() => { document.body.classList.remove('booting'); });
  requestAnimationFrame(frame);
}
main();

// test hooks (headless screenshots)
window.__money = S;
window.__seek = (date, play = false) => { const t = new Date(date).getTime(); S.T = Math.max(0, S.D.weeks.findIndex((w) => w >= t)); S.playing = play; S.userTouched = true; updatePlay(); return fmtDate(S.D.weeks[Math.round(S.T)]); };
