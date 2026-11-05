// Market Organism — 3D renderer.
// One smooth multi-handle manifold: every sector is a handle (a hole through the surface), assets are cells
// sitting on the handle rims, correlations are flows running over the surface, the market aggregate sits in
// the central funnel. Everything comes from the SSE snapshot/diffs (live), /api/replay (stored history) or —
// on a static host — exported JSON files, through the same render path.
//
// Data encodings                                      Ambient motion (never data; never size, colour or glow)
//   hole size      = sector energy share              surface breathing ripple (shape only, constant amplitude)
//   hole order     = sector correlation (seriation)   flow / stream pulses travel (speed = |ρ| / market burst)
//   lift           = sector Δ                          camera auto-orbit, core rings turn
//   rim glow       = sector Hawkes burst, white = phase-lock
//   cell size      = energy, colour = Δ, flare = burst, flash = a real sample arrived, ring = source coverage
//   flows          = correlation ρ (cyan +, amber −), opacity/width = |ρ|
//   core           = market Δ (colour), market burst (glow); axis bead = market Δ / cross-sectional σ
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { MAXS, layoutRing, field2, topY, sheet, tubePoint } from './field.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (f) => f * f * (3 - 2 * f);
const sq = (x) => x * x;
const TAU = Math.PI * 2;
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const GRAIN_S = { '1m': 60, '1h': 3600, '1d': 86400 };
const HUES = ['#b46cff', '#38e8ff', '#ff9a3c', '#ff4fd8', '#4dffa6', '#5b8cff', '#ffd34d', '#ff6b8b', '#3cffd9', '#c0ff4d', '#ff7ac6', '#7ae0ff', '#e0a0ff', '#9effc7'];
const MOBILE = matchMedia('(max-width: 1060px)').matches;

// ------------------------------------------------------------------ state
const S = {
  market: new URLSearchParams(location.search).get('market'),
  meta: null, ents: [], idx: new Map(), sectors: [], sidx: new Map(), secState: {},
  edges: [], sedges: [], edgeInfo: null, status: [], sources: [], dataTs: null, recvAt: null, nObs: 0, nPersisted: 0,
  deltaMode: null, conv: store.get('mo.conv', 'kr'), layers: {},
  connected: false, es: null, frames: 0, fps: 60, msgs: 0, spin: store.get('mo.spin', '1') === '1',
  L: null, order: null, orderFromEdges: false, layoutR: null, lastLayout: 0, secH: [], phaseSeen: {},
};
const RP = { on: false, playing: false, speed: 86400, data: null, T: null, grain: null, loading: false, avail: null, reason: '' };
window.__organism = S; window.__replayState = RP;

// ------------------------------------------------------------------ data API: live server or static export
const API = {
  static: false, exported: null,
  async init() {
    try { const r = await fetch('static.json', { cache: 'no-cache' }); if (r.ok) { this.exported = await r.json(); this.static = true; } } catch {}
    document.body.classList.toggle('static', this.static);
  },
  async markets() { return (await fetch(this.static ? 'data/markets.json' : '/api/markets')).json(); },
  async replay(m, grain, maxFrames) {
    if (this.static) {
      const r = await fetch(grain ? `data/${m}/replay_${grain}.json` : `data/${m}/replay_info.json`);
      return r.ok ? r.json() : { available: false, reason: 'not included in this static export' };
    }
    const q = grain ? `grain=${grain}&max_frames=${maxFrames}` : 'max_frames=1';
    return (await fetch(`/api/replay/${encodeURIComponent(m)}?${q}`)).json();
  },
  stream(m, onMsg, onOpen, onErr) {
    if (this.static) {
      let dead = false;
      fetch(`data/${m}/snapshot.json`).then((r) => r.json()).then((j) => { if (!dead) { onOpen(); onMsg(j); } }).catch(onErr);
      return { close() { dead = true; } };
    }
    const es = new EventSource(`/api/stream/${encodeURIComponent(m)}`);
    es.onopen = onOpen; es.onerror = onErr; es.onmessage = (ev) => onMsg(JSON.parse(ev.data));
    return es;
  },
};

// ------------------------------------------------------------------ boot progress
const boot = { set(step, p) { $('ldStep').textContent = step; $('ldBar').style.width = `${Math.round(p * 100)}%`; }, done() { document.body.classList.remove('booting'); } };

// ------------------------------------------------------------------ renderer / camera / bloom
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
let DPR = Math.min(devicePixelRatio, MOBILE ? 1.5 : 1.75);
renderer.setPixelRatio(DPR);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020309);
const cam = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 12000);
cam.position.set(0, 160, 300);
const controls = new OrbitControls(cam, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.06; controls.rotateSpeed = 0.6; controls.zoomSpeed = 0.8;
controls.autoRotate = S.spin && !matchMedia('(prefers-reduced-motion: reduce)').matches; controls.autoRotateSpeed = 0.22;
controls.maxPolarAngle = Math.PI * 0.62; controls.minDistance = 8; controls.maxDistance = 3000;
let lastUser = 0, flyTo = null;
controls.addEventListener('start', () => { lastUser = performance.now(); controls.autoRotate = false; flyTo = null; });

const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, cam));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.75, 0.55, 0.16);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// shared uniforms (one object per uniform, referenced by every material)
const U = {
  uTime: { value: 0 }, uFlowT: { value: 0 }, uPx: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) },
  uHoles: { value: Array.from({ length: MAXS }, () => new THREE.Vector4()) },
  uSec: { value: Array.from({ length: MAXS }, () => new THREE.Vector4()) },
  uHue: { value: Array.from({ length: MAXS }, () => new THREE.Vector3()) },
  uNS: { value: 0 }, uRing: { value: 100 }, uGain: { value: 1 },
};
let lastSize = '';
function applyViewOffset() {          // keep the manifold centred in the part of the screen the panels leave free
  const w = Math.max(innerWidth, 2), h = Math.max(innerHeight, 2);
  let oy = w > 1060 ? Math.round(h * 0.035) : Math.round(h * 0.03);
  if (w <= 1060 && document.body.dataset.sheet) oy = Math.round(h * 0.2);
  cam.setViewOffset(w, h, 0, oy, w, h); cam.updateProjectionMatrix();
}
function resize() {
  const w = Math.max(innerWidth, 2), h = Math.max(innerHeight, 2);
  const key = `${w}x${h}@${DPR}`;
  if (lastSize === key) return;
  lastSize = key;
  renderer.setPixelRatio(DPR); renderer.setSize(w, h, false); composer.setPixelRatio?.(DPR); composer.setSize(w, h);
  cam.aspect = w / h; applyViewOffset();
  U.uPx.value = h * DPR / (2 * Math.tan(cam.fov * Math.PI / 360));
  U.uRes.value.set(w * DPR, h * DPR);
  if (S.L) fit(true);
}
addEventListener('resize', resize); resize();

// GLSL shared by every layer that sits on the manifold: sector lift (data) + breathing ripple (ambient, shape only)
const GL_COMMON = /* glsl */`
  #define MAXS ${MAXS}
  uniform vec4 uHoles[MAXS]; uniform vec4 uSec[MAXS]; uniform int uNS; uniform float uTime, uRing;
  float sq(float x){ return x*x; }
  float secLift(vec2 xz){
    float h = 0.0;
    for (int i = 0; i < MAXS; i++) { if (i >= uNS) break; vec4 H = uHoles[i];
      float q = length(xz - H.xy); h += uSec[i].x * exp(-sq(q / (H.z + 2.4*H.w)) * 1.3); }
    return h;
  }
  vec3 displace(vec3 p){
    float r = length(p.xz);
    p.y += secLift(p.xz) + 0.5*sin(r*(6.2832/(uRing*0.42)) - uTime*0.55) * smoothstep(uRing*0.12, uRing*0.45, r);
    return p;
  }`;

// ------------------------------------------------------------------ backdrop (decorative — no data)
const space = new THREE.Group(); scene.add(space);
const starMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uTime: U.uTime },
  vertexShader: /* glsl */`attribute vec3 aC; attribute float aS; uniform float uTime; varying vec3 vC;
    void main(){ vC = aC; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = aS; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: /* glsl */`varying vec3 vC; void main(){ float L = length(gl_PointCoord*2.0-1.0); float a = exp(-L*L*5.0); if(a<0.02) discard; gl_FragColor = vec4(vC*a, a); }`,
});
{
  const neb = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: /* glsl */`varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */`
      varying vec3 vD;
      float h(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
      float n(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*n(p); p*=2.03; a*=0.5; } return s; }
      void main(){
        vec3 d = vD; float band = exp(-(d.y*2.0 + 0.3*sin(d.x*3.0))*(d.y*2.0 + 0.3*sin(d.x*3.0)));
        float c1 = fbm(d*2.6 + 1.7), c2 = fbm(d*5.0 - 3.1), c3 = fbm(d*9.0 + 7.0);
        vec3 col = vec3(0.26,0.10,0.52)*pow(c1,3.0)*1.3 + vec3(0.04,0.22,0.42)*pow(c2,4.0)*1.4 + vec3(0.30,0.08,0.22)*pow(c3,5.0)*0.8;
        col *= 0.3 + 0.7*band;
        gl_FragColor = vec4(col*0.36 + vec3(0.004,0.005,0.014), 1.0);
      }`,
  }));
  space.add(neb);
  const N = 11000, p = new Float32Array(N * 3), c = new Float32Array(N * 3), s = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * TAU, r = 2400 + Math.random() * 3000, q = Math.sqrt(1 - u * u);
    p.set([Math.cos(a) * q * r, u * r * 0.8, Math.sin(a) * q * r], 3 * i);
    const t = Math.random(); const col = t < 0.15 ? [1, 0.85, 0.7] : t < 0.4 ? [0.7, 0.85, 1] : [1, 1, 1];
    const b = 0.3 + Math.pow(Math.random(), 6) * 2.2;
    c.set(col.map((x) => x * b), 3 * i); s[i] = 1.1 + Math.pow(Math.random(), 8) * 5;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aC', new THREE.BufferAttribute(c, 3)); g.setAttribute('aS', new THREE.BufferAttribute(s, 1));
  space.add(new THREE.Points(g, starMat));
  const gal = (pos, tilt, hueA, hueB, R, n) => {
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), Sz = new Float32Array(n);
    const ca = new THREE.Color(hueA), cb = new THREE.Color(hueB);
    for (let i = 0; i < n; i++) {
      const arm = i % 2, r = Math.pow(Math.random(), 1.6) * R, th = r / R * 7 + arm * Math.PI + (Math.random() - 0.5) * 0.7 * (1 - r / R * 0.5);
      const sp = (Math.random() - 0.5) * R * 0.08;
      P.set([Math.cos(th) * r + sp, (Math.random() - 0.5) * R * 0.04, Math.sin(th) * r + sp], 3 * i);
      const k = r / R, cc = ca.clone().lerp(cb, k), b = (1.4 - k) * 0.8;
      C.set([cc.r * b, cc.g * b, cc.b * b], 3 * i); Sz[i] = 1.2 + (1 - k) * 2.2;
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.BufferAttribute(P, 3)); gg.setAttribute('aC', new THREE.BufferAttribute(C, 3)); gg.setAttribute('aS', new THREE.BufferAttribute(Sz, 1));
    const m = new THREE.Points(gg, starMat);
    m.position.copy(pos); m.rotation.set(tilt[0], tilt[1], tilt[2]);
    space.add(m); return m;
  };
  S.galaxies = [
    gal(new THREE.Vector3(-2300, 700, -2700), [1.1, 0.2, 0.3], '#fff1d6', '#7a5cff', 330, 6000),
    gal(new THREE.Vector3(2600, 380, -1900), [0.5, 0.6, -0.4], '#ffe0f0', '#ff4fd8', 220, 3500),
    gal(new THREE.Vector3(1300, -560, 3000), [1.3, -0.4, 0.2], '#e0f6ff', '#38c8ff', 260, 4000),
    gal(new THREE.Vector3(-2900, -300, 1400), [0.9, 0.1, -0.6], '#fff6e0', '#ffad5c', 180, 2600),
  ];
}
// decorative orbit ellipses around the manifold (no data)
const orbits = new THREE.Group(); space.add(orbits);
const orbitMat = new THREE.LineDashedMaterial({ color: 0x8fb4ff, transparent: true, opacity: 0.16, dashSize: 3, gapSize: 4, blending: THREE.AdditiveBlending, depthWrite: false });
function buildOrbits(R) {
  for (const o of [...orbits.children]) { orbits.remove(o); o.geometry.dispose(); }
  [[1.35, 0.18, 0.2], [1.6, -0.12, 1.4], [1.9, 0.08, 2.4]].forEach(([k, tilt, rot]) => {
    const pts = []; for (let i = 0; i <= 256; i++) { const a = i / 256 * TAU; pts.push(new THREE.Vector3(Math.cos(a) * R * k, 0, Math.sin(a) * R * k * 0.82)); }
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat);
    l.computeLineDistances(); l.rotation.set(tilt, rot, tilt * 0.5); orbitMat.dashSize = R * 0.02; orbitMat.gapSize = R * 0.028;
    orbits.add(l);
  });
}

// ------------------------------------------------------------------ manifold surface
const manGroup = new THREE.Group(); scene.add(manGroup);
const coreU = { uCoreCol: { value: new THREE.Color(1, 0.8, 0.55) }, uCoreGlow: { value: 0.3 }, uRc: { value: 8 } };
function makeManifoldMat() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    extensions: { derivatives: true },
    uniforms: { ...U, ...coreU, uGain: U.uGain, uAlpha: { value: 0 } },
    vertexShader: GL_COMMON + /* glsl */`
      varying vec3 vW; varying vec3 vN; varying vec3 vV;
      void main(){
        vec3 p = displace(position);
        vW = vec3(position.x, p.y, position.z);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: GL_COMMON + /* glsl */`
      uniform vec3 uHue[MAXS]; uniform float uAlpha, uCoreGlow, uRc, uGain; uniform vec3 uCoreCol;
      varying vec3 vW; varying vec3 vN; varying vec3 vV;
      float gl1(float x, float w){ float fw = fwidth(x); float f = fract(x); float d = min(f, 1.0-f);
        return (1.0 - smoothstep(0.0, w*fw + 1e-5, d)) * clamp(0.55/(fw + 1e-5) - 0.55, 0.0, 1.0); }
      void main(){
        vec2 xz = vW.xz; float r = length(xz);
        vec3 hue = vec3(0.0); float ws = 0.0, glow = 0.0, phase = 0.0, hov = 0.0;
        float bq = 1e9; vec4 bH = vec4(0.0, 0.0, 1.0, 1.0);
        for (int i = 0; i < MAXS; i++) { if (i >= uNS) break; vec4 H = uHoles[i];
          float q = length(xz - H.xy);
          float e = max(q - H.z, 0.0) / (H.w * 2.8); float w = exp(-e*e*2.0); float wh = w*w*w*w*w*w + 1e-6;
          hue += uHue[i]*wh; ws += wh; glow += uSec[i].y*wh; phase += uSec[i].z*wh; hov += uSec[i].w*wh;
          float qe = (q - H.z) / H.w; if (qe < bq) { bq = qe; bH = H; } }
        float wc = exp(-sq(r / (uRing*0.5))*6.0);
        hue = (hue + vec3(1.0, 0.6, 0.26)*wc + vec3(0.55, 0.36, 1.0)*0.002) / (ws + wc + 0.002);
        float dn = ws + 0.002; glow /= dn; phase /= dn; hov /= dn;
        vec2 dq = xz - bH.xy; float q = length(dq);
        float nsp = floor(6.2832*(bH.z + bH.w) / (bH.w*0.8));
        float spokes = gl1(atan(dq.y, dq.x)/6.2832*nsp, 1.0);
        float rings = gl1((q - bH.z)/(bH.w*0.34), 1.0);
        float hw = exp(-sq(max(bq - 1.2, 0.0)/1.5));
        float thc = atan(xz.y, xz.x);
        float cr = gl1(r/(uRing*0.06), 1.0), cs = gl1(thc/6.2832*64.0, 0.9);
        float lines = mix(max(cr, cs*0.75), max(rings, spokes*0.8), hw);
        float nodes = mix(cr*cs, rings*spokes, hw);
        vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
        float fres = 1.0 - abs(dot(N, normalize(vV)));
        float rim = fres*fres*sqrt(fres);
        vec3 irid = 0.5 + 0.5*cos(6.2832*(vec3(0.0, 0.33, 0.67) + fres*0.7 + vW.y*0.01 + thc*0.159));
        vec3 col = mix(hue, irid, 0.2); col = max(col - vec3(0.1)*(1.0 - dot(col, vec3(0.333))), 0.0) * 1.1;
        float g = (0.72 + 0.85*glow)*uGain;
        vec3 c = col*(0.010 + 0.05*rim) + col*lines*0.27*g + mix(col, vec3(1.0), 0.35)*nodes*0.8*g + mix(col, vec3(1.0), 0.1)*rim*0.17*g;
        c += vec3(1.0)*phase*(lines*0.16 + nodes*0.3 + rim*0.08) + col*hov*0.35*(lines + rim);
        c += uCoreCol*uCoreGlow*exp(-r/(uRc*1.5))*(0.18 + lines*0.8);
        gl_FragColor = vec4(c, uAlpha);
      }`,
  });
}
let meshes = [];             // {mesh, mat, target}
let layoutId = 0;
const mworker = new Worker(new URL('./manifold.worker.js', import.meta.url), { type: 'module' });
mworker.onmessage = (e) => {
  const d = e.data; if (d.id !== layoutId) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3));
  g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  g.computeBoundingSphere();
  const mat = makeManifoldMat(), mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 1;
  for (const m of meshes) m.target = 0;
  meshes.push({ mesh, mat, target: 1 }); manGroup.add(mesh);
  S.meshInfo = { verts: d.nv, tris: d.nt, ms: Math.round(d.ms) };
  if (document.body.classList.contains('booting')) { boot.set('Ready', 1); setTimeout(boot.done, 120); if (API.static) setTimeout(autoReplay, 1400); }
};

// ------------------------------------------------------------------ core (market aggregate) + σ axis
const core = new THREE.Group(); scene.add(core);
const coreGlowMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...U, ...coreU, uSize: { value: 30 } },
  vertexShader: /* glsl */`uniform float uPx, uSize; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(uSize*uPx/-mv.z, 4.0, 900.0); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: /* glsl */`uniform vec3 uCoreCol; uniform float uCoreGlow;
    void main(){ float L = length(gl_PointCoord*2.0-1.0); if (L > 1.0) discard;
      float core = exp(-L*L*60.0), halo = exp(-L*L*7.0)*(0.25 + 0.9*uCoreGlow), wide = exp(-L*3.2)*0.18*(0.4 + uCoreGlow);
      vec3 c = mix(uCoreCol, vec3(1.0), core*0.8)*(core*2.2 + halo + wide);
      gl_FragColor = vec4(c, 1.0); }`,
});
const coreGlow = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)), coreGlowMat);
coreGlow.frustumCulled = false; coreGlow.renderOrder = 5; core.add(coreGlow);
const coreRings = [];
const ringMat = (o) => new THREE.MeshBasicMaterial({ color: 0xffc58a, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
for (const [k, o] of [[1.0, 0.55], [1.5, 0.28], [2.2, 0.14]]) { const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 6, 180).rotateX(Math.PI / 2), ringMat(o)); m.userData.k = k; core.add(m); coreRings.push(m); }
const axisMat = new THREE.LineBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
const axis = new THREE.LineSegments(new THREE.BufferGeometry(), axisMat); core.add(axis);
const beadMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...U, ...coreU },
  vertexShader: /* glsl */`uniform float uPx; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = clamp(5.0*uPx/-mv.z, 6.0, 40.0); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: /* glsl */`uniform vec3 uCoreCol; void main(){ float L = length(gl_PointCoord*2.0-1.0); float a = exp(-L*L*7.0); if (a < 0.02) discard; gl_FragColor = vec4(mix(uCoreCol, vec3(1.0), 0.5)*a*1.6, a); }`,
});
const bead = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3)), beadMat);
bead.frustumCulled = false; core.add(bead);
const AX = { y0: 0, step: 10, top: 0, bot: 0 };
function buildAxis(L) {
  const yT = field2(L, 0.01, 0.01, [0, 0, 0])[2];
  AX.throat = yT; AX.y0 = yT + L.D * 1.25; AX.step = L.D * 0.3; AX.bot = yT; AX.top = AX.y0 + AX.step * 3.2;
  const P = [0, AX.bot, 0, 0, AX.top, 0];
  for (let k = -2; k <= 2; k++) { const y = AX.y0 + k * AX.step, w = k === 0 ? L.R * 0.05 : L.R * 0.025; P.push(-w, y, 0, w, y, 0); }
  axis.geometry.dispose(); axis.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
  coreGlow.position.set(0, yT, 0); coreGlowMat.uniforms.uSize.value = L.rc * 3.4;
  coreRings.forEach((m) => { m.scale.setScalar(L.rc * 1.25 * m.userData.k); m.position.y = yT; });
  coreU.uRc.value = L.rc;
}

// ------------------------------------------------------------------ cells (entities)
const MAXE = 4000;
const cellGeo = new THREE.BufferGeometry();
for (const [k, n] of [['position', 3], ['aColor', 3], ['aSize', 1], ['aP', 4], ['aCov', 2], ['aSeed', 1]])
  cellGeo.setAttribute(k, new THREE.BufferAttribute(new Float32Array(MAXE * n), n).setUsage(THREE.DynamicDrawUsage));
const cellMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { ...U },
  vertexShader: GL_COMMON + /* glsl */`
    attribute vec3 aColor; attribute float aSize; attribute vec4 aP; attribute vec2 aCov; attribute float aSeed;
    uniform float uPx; varying vec3 vC; varying vec4 vP; varying vec2 vCov; varying float vSeed, vK;
    void main(){
      vC = aColor; vP = aP; vCov = aCov; vSeed = aSeed;
      vec4 mv = modelViewMatrix * vec4(displace(position) + vec3(0.0, 0.35, 0.0), 1.0);
      float grow = 1.0 + 1.1*aP.x;                    // sprite grows to fit the burst flare (core size stays = energy)
      vK = 1.0 / grow;
      gl_PointSize = clamp(aSize * 3.2 * grow * uPx / -mv.z, 3.0, 260.0);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime; varying vec3 vC; varying vec4 vP; varying vec2 vCov; varying float vSeed, vK;
    float sq(float x){ return x*x; }
    void main(){
      vec2 p = gl_PointCoord*2.0 - 1.0; float L = length(p); if (L > 1.0) discard;
      float burst = vP.x, flash = vP.y, miss = vP.z, hov = vP.w;
      float rc = 0.36 * vK;
      float a01 = fract(atan(p.y, p.x)/6.2832 + 0.25);
      if (miss > 0.5) {                               // empty: source missing -> hollow dashed ring, no fill
        float dash = step(0.5, fract(a01*12.0));
        float rim = exp(-sq((L - rc*1.15)/0.05)) * dash;
        if (rim < 0.03) discard;
        gl_FragColor = vec4(vec3(0.6,0.65,0.8)*rim*0.7, rim*0.7); return;
      }
      float core = smoothstep(rc, rc*0.6, L);
      float hot = smoothstep(rc*0.55, 0.0, L);
      float stale = (miss > 0.2) ? 1.0 : 0.0;
      float sRing = stale * exp(-sq((L - rc*1.25)/0.04)) * step(0.5, fract(a01*10.0));
      float halo = exp(-sq(L/(rc*1.6))) * (0.28 + 1.2*burst);
      float rr = fract(uTime*0.75 + vSeed);
      float ring = burst * exp(-sq((L - (rc*1.2 + rr*(0.98 - rc*1.2)))/0.035)) * (1.0 - rr);
      float nexp = max(vCov.y, 1.0), seg = floor(a01*nexp), sf = fract(a01*nexp);
      float covRim = (vCov.y > 1.5 ? 1.0 : 0.0) * exp(-sq((L - rc*1.5)/0.04)) * step(0.07, sf) * step(sf, 0.93);
      float filled = step(seg + 0.5, vCov.x);
      vec3 col = vC*(core*1.6 + halo) + vec3(1.0)*hot*0.22 + vec3(1.0)*flash*core*1.4 + vec3(1.0,0.95,0.88)*ring*0.9
               + mix(vec3(0.25,0.28,0.36), vec3(0.7,0.95,1.0), filled)*covRim*(0.35 + 0.5*filled) + vec3(1.0)*hov*(halo*0.6 + core*0.4);
      col = col * (1.0 - 0.6*stale) + vec3(1.0, 0.75, 0.3)*sRing*0.8;
      float a = clamp(core + halo*0.75 + ring + covRim*0.6 + sRing, 0.0, 1.0);
      if (a < 0.01) discard;
      gl_FragColor = vec4(col, a);
    }`,
});
const cells = new THREE.Points(cellGeo, cellMat);
cells.frustumCulled = false; cells.renderOrder = 6; scene.add(cells);

// ------------------------------------------------------------------ ribbons: screen-space lines with travelling pulses
function makeRibbons(maxSeg, { lift = 0.5, order = 3 } = {}) {
  const g = new THREE.BufferGeometry(), nV = maxSeg * 4;
  const at = (n) => new THREE.BufferAttribute(new Float32Array(nV * n), n).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', at(3)); g.setAttribute('aB', at(3)); g.setAttribute('aSide', at(2)); g.setAttribute('aCol', at(4)); g.setAttribute('aU', at(1)); g.setAttribute('aP', at(4));
  const idx = new Uint32Array(maxSeg * 6);
  for (let s = 0; s < maxSeg; s++) idx.set([4 * s, 4 * s + 1, 4 * s + 2, 4 * s + 2, 4 * s + 1, 4 * s + 3], 6 * s);
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { ...U, uLift: { value: lift } },
    vertexShader: GL_COMMON + /* glsl */`
      attribute vec3 aB; attribute vec2 aSide; attribute vec4 aCol; attribute float aU; attribute vec4 aP;
      uniform vec2 uRes; uniform float uLift;
      varying vec4 vC; varying float vS, vU; varying vec4 vP;
      void main(){
        vec3 A = displace(position) + vec3(0.0, uLift, 0.0), B = displace(aB) + vec3(0.0, uLift, 0.0);
        vec4 ca = projectionMatrix*modelViewMatrix*vec4(A, 1.0), cb = projectionMatrix*modelViewMatrix*vec4(B, 1.0);
        vec2 sa = ca.xy/ca.w*uRes*0.5, sb = cb.xy/cb.w*uRes*0.5;
        vec2 d = sb - sa; float L = length(d); d = L > 1e-4 ? d/L : vec2(1.0, 0.0);
        vec2 n = vec2(-d.y, d.x);
        vec4 c = aSide.y < 0.5 ? ca : cb;
        c.xy += n * aSide.x * (aP.w*0.5 + 1.0) / (uRes*0.5) * c.w;
        vC = aCol; vS = aSide.x; vU = aU; vP = aP;
        gl_Position = c;
      }`,
    fragmentShader: /* glsl */`
      uniform float uFlowT; varying vec4 vC; varying float vS, vU; varying vec4 vP;
      void main(){
        float e = 1.0 - vS*vS; float a = vC.a * e*e;
        float ph = fract(vU*vP.z - uFlowT*vP.x + vP.y);
        float head = smoothstep(0.0, 1.0, ph); head = head*head*head*head*(1.0 - smoothstep(0.93, 1.0, ph));
        vec3 col = vC.rgb*(0.6 + 1.7*head) + vec3(1.0)*head*head*0.25;
        gl_FragColor = vec4(col, a*(0.55 + 0.75*head));
      }`,
  });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = order;
  let n = 0;
  return {
    mesh, mat,
    reset() { n = 0; },
    // pts: flat [x,y,z,...]; col: [r,g,b,a]; P: [speed, seed, pulses per unit length, width px]
    add(pts, col, P, cols) {
      const m = pts.length / 3 - 1; if (m < 1 || n + m > maxSeg) return -1;
      const A = g.attributes.position.array, B = g.attributes.aB.array, SD = g.attributes.aSide.array, C = g.attributes.aCol.array, UU = g.attributes.aU.array, PP = g.attributes.aP.array;
      let len = 0; const start = n;
      for (let s = 0; s < m; s++) {
        const i0 = 3 * s, i1 = 3 * s + 3;
        const sl = Math.hypot(pts[i1] - pts[i0], pts[i1 + 1] - pts[i0 + 1], pts[i1 + 2] - pts[i0 + 2]);
        for (let v = 0; v < 4; v++) {
          const q = 4 * n + v;
          A.set([pts[i0], pts[i0 + 1], pts[i0 + 2]], 3 * q); B.set([pts[i1], pts[i1 + 1], pts[i1 + 2]], 3 * q);
          SD[2 * q] = v % 2 ? 1 : -1; SD[2 * q + 1] = v < 2 ? 0 : 1;
          const cc = cols ? cols[v < 2 ? s : s + 1] : col;
          C.set(cc, 4 * q); UU[q] = v < 2 ? len : len + sl; PP.set(P, 4 * q);
        }
        len += sl; n++;
      }
      return start;
    },
    setAlpha(start, count, alpha) {
      const C = g.attributes.aCol.array;
      for (let s = start; s < start + count; s++) for (let v = 0; v < 4; v++) C[4 * (4 * s + v) + 3] = alpha;
    },
    commit() {
      g.setDrawRange(0, n * 6);
      for (const k of ['position', 'aB', 'aSide', 'aCol', 'aU', 'aP']) g.attributes[k].needsUpdate = true;
    },
    touchCol() { g.attributes.aCol.needsUpdate = true; },
    get n() { return n; },
  };
}
const flows = makeRibbons(MOBILE ? 30000 : 52000, { lift: 0.55, order: 4 });     // data: correlations
const streams = makeRibbons(MOBILE ? 9000 : 16000, { lift: 0.3, order: 2 });    // decorative circulation
scene.add(flows.mesh); scene.add(streams.mesh);

// ------------------------------------------------------------------ encodings
const COL = { kr: { up: [1.0, 0.24, 0.34], dn: [0.22, 0.55, 1.0] }, us: { up: [0.16, 0.95, 0.56], dn: [1.0, 0.26, 0.3] }, mid: [0.42, 0.46, 0.62] };
const rgb = (a) => `rgb(${a.map((x) => Math.round(clamp(x, 0, 1) * 255)).join(',')})`;
function deltaOf(s) { if (!s) return null; return S.deltaMode === 'win' ? (s.dw ?? s.dr) : (s.dr ?? s.dw); }
function deltaKind(e) {
  const L = S.meta?.labels || {};
  if (RP.on) return e?.meta?.delta_kind || L.delta_kind || 'pct';
  if (S.deltaMode === 'win' && L.delta_win_kind) return L.delta_win_kind;
  return e?.meta?.delta_kind || L.delta_kind || 'pct';
}
function clip() { const c = S.meta?.view?.delta_clip || {}; return RP.on ? (c.ref ?? 0.05) : S.deltaMode === 'win' ? (c.win ?? 0.01) : (c.ref ?? 0.05); }
function colorFor(d, out) {
  const c = COL[S.conv];
  if (d == null) { out[0] = COL.mid[0] * 0.7; out[1] = COL.mid[1] * 0.7; out[2] = COL.mid[2] * 0.7; return out; }
  const t = clamp(d / clip(), -1, 1), k = Math.pow(Math.abs(t), 0.6), to = t >= 0 ? c.up : c.dn;
  for (let i = 0; i < 3; i++) out[i] = COL.mid[i] + (to[i] - COL.mid[i]) * k;
  return out;
}
function coreColor(d, out) {           // neutral = warm white; tinted toward the Δ colour by |Δ|
  const warm = [1.0, 0.8, 0.56];
  if (d == null) { out[0] = warm[0]; out[1] = warm[1]; out[2] = warm[2]; return out; }
  const t = clamp(d / clip(), -1, 1), k = Math.pow(Math.abs(t), 0.6), to = t >= 0 ? COL[S.conv].up : COL[S.conv].dn;
  for (let i = 0; i < 3; i++) out[i] = warm[i] + (to[i] - warm[i]) * k;
  return out;
}
const burstNorm = (b) => (b == null ? 0 : clamp((b - 1.3) / 4, 0, 1));
function fmtDelta(d, kind) {
  if (d == null) return '—';
  if (kind === 'abs') return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(2);
  return (d >= 0 ? '+' : '−') + Math.abs(d * 100).toFixed(Math.abs(d) < 0.01 ? 2 : 1) + '%';
}
function fmtNum(x) {
  if (x == null) return '—';
  const a = Math.abs(x);
  if (a >= 1e12) return (x / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(1) + 'k';
  if (a >= 100) return x.toFixed(2);
  if (a >= 1) return x.toFixed(4);
  return x.toPrecision(4);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(ms) { const s = Math.max(0, ms) / 1000; if (s < 90) return s.toFixed(s < 10 ? 1 : 0) + 's'; if (s < 5400) return (s / 60).toFixed(0) + 'm'; if (s < 172800) return (s / 3600).toFixed(1) + 'h'; return (s / 86400).toFixed(1) + 'd'; }
const fmtDate = (ts, withSec) => { if (!ts) return '—'; const d = new Date(ts); const s = d.toLocaleString('sv-SE', { hour12: false }); return withSec ? s : s.slice(0, 16); };
const st = (e) => (RP.on ? e.rs || { m: 'no stored sample before this time', sc: [0, 1] } : e.s);
const secSt = (id) => (RP.on ? RP.sec?.[id] : S.secState[id]) || {};
const secDelta = (x) => (RP.on ? x.dr : (S.deltaMode === 'win' ? (x.dw ?? x.dr) : (x.dr ?? x.dw)));

function sizes() {
  const n = S.ents.length, k = clamp(Math.sqrt(60 / Math.max(n, 1)), 0.32, 1);
  const es = S.ents.map((e) => { const s = st(e); return s.m == null && s.e > 0 ? s.e : null; });
  const vals = es.filter((x) => x != null), log = S.meta?.view?.size_scale === 'log';
  const emax = Math.max(...vals, 1e-9), lmin = log ? Math.min(...vals.map((x) => Math.log10(x + 1)), 0) : 0, lmax = log ? Math.log10(emax + 1) : 1;
  S.ents.forEach((e, i) => {
    const x = es[i];
    const t = x == null ? 0.25 : log ? (Math.log10(x + 1) - lmin) / Math.max(lmax - lmin, 1e-6) : Math.sqrt(x / emax);
    e.szT = (1.3 + 4.4 * t) * k;
  });
}
// hole radius from sector energy share (fallback: member count) — live values only
function holeRadii() {
  const E = S.sectors.map((s) => { let x = 0; for (const id of s.members) { const v = S.ents[S.idx.get(id)]?.s; if (v && v.m == null && v.e > 0) x += v.e; } return x; });
  const emax = Math.max(...E, 0), nmax = Math.max(...S.sectors.map((s) => s.members.length), 1);
  return S.sectors.map((s, i) => {
    const share = emax > 0 ? E[i] / emax : s.members.length / nmax;
    return 10 + 12 * Math.pow(share, 0.45) + 1.1 * Math.sqrt(s.members.length);
  });
}
// ring order: greedy seriation of sector correlations, so correlated handles sit next to each other
function seriate() {
  const n = S.sectors.length, E = S.sectors.map((s) => secSt(s.id).e || 0);
  const W = Array.from({ length: n }, () => new Float32Array(n));
  for (const [a, b, w] of S.sedges) { const i = S.sidx.get(a), j = S.sidx.get(b); if (i != null && j != null) { W[i][j] = W[j][i] = w; } }
  const left = new Set([...Array(n).keys()]);
  let cur = [...left].sort((a, b) => E[b] - E[a])[0] ?? 0;
  const out = [cur]; left.delete(cur);
  while (left.size) {
    let best = null, bw = -Infinity;
    for (const j of left) { const w = W[cur][j] + 1e-6 * E[j]; if (w > bw) { bw = w; best = j; } }
    out.push(best); left.delete(best); cur = best;
  }
  return out;
}

// ------------------------------------------------------------------ layout: manifold + nodes + flows + streams
function relayout(force) {
  if (!S.sectors.length) return;
  const radii = holeRadii();
  if (!force && S.layoutR && radii.every((r, i) => Math.abs(r - S.layoutR[i]) / S.layoutR[i] < 0.12)) return;
  S.layoutR = radii; S.lastLayout = performance.now();
  const L = layoutRing(radii, S.order || [...S.sectors.keys()]);
  L.holes.forEach((h, s) => { h.thOut = Math.atan2(h.z, h.x); });
  S.L = L;
  const ns = Math.min(L.holes.length, MAXS);
  for (let s = 0; s < ns; s++) {
    const h = L.holes[s]; U.uHoles.value[s].set(h.x, h.z, h.r, h.a);
    const c = new THREE.Color(HUES[s % HUES.length]); U.uHue.value[s].set(c.r, c.g, c.b);
  }
  U.uNS.value = ns; U.uRing.value = L.R; U.uGain.value = clamp(Math.sqrt(6 / ns), 0.62, 1.1);
  layoutId++;
  boot.set('Building manifold', 0.8);
  mworker.postMessage({ id: layoutId, L, res: MOBILE ? 170 : S.ents.length > 600 ? 200 : 236 });
  if (S.secH.length !== S.sectors.length) S.secH = S.sectors.map(() => 0);
  placeNodes(); buildAxis(L); buildOrbits(L.R); buildStreams(); S.flowDirty = true;
  if (!S.fitted) { S.fitted = true; fit(true); }
}
function placeNodes() {
  const L = S.L, tmp = [0, 0, 0];
  S.sectors.forEach((sec, s) => {
    const h = L.holes[s];
    const mem = [...sec.members].sort((a, b) => ((S.ents[S.idx.get(b)]?.s?.e || 0) - (S.ents[S.idx.get(a)]?.s?.e || 0)));
    const n = mem.length;
    mem.forEach((id, k) => {
      const e = S.ents[S.idx.get(id)]; if (!e) return;
      const th = h.thOut + Math.PI + TAU * (k + 0.5) / n;            // biggest asset faces the core
      const phi = n <= 18 ? [1.2, 0.62, 1.75][k % 3] : 0.35 + 1.75 * ((k * 0.618034) % 1);
      tubePoint(L, h, th, phi, tmp);
      e.g = s; e.th = th; e.phi = phi; e.tgt = [tmp[0], tmp[1], tmp[2]];
      if (!e.p) e.p = [...e.tgt];
    });
  });
}
// path over the surface between two cells
function surfacePath(ea, eb) {
  const L = S.L, out = [];
  if (ea.g === eb.g) {                                  // same handle: arc over the tube
    const h = L.holes[ea.g];
    let d = (eb.th - ea.th) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU;
    const n = Math.max(8, Math.ceil(Math.abs(d) / TAU * 48)), tmp = [0, 0, 0];
    for (let q = 0; q <= n; q++) {
      const u = q / n, phi = ea.phi + (eb.phi - ea.phi) * u + (1.55 - (ea.phi + eb.phi) / 2) * Math.sin(Math.PI * u) * 0.8;
      tubePoint(L, h, ea.th + d * u, phi, tmp); out.push(tmp[0], tmp[1] + 0.25, tmp[2]);
    }
    return out;
  }
  const [ax, ay, az] = ea.tgt, [bx, by, bz] = eb.tgt;
  const mx = (ax + bx) / 2 * 0.78, mz = (az + bz) / 2 * 0.78;
  const n = 34, P = [];
  for (let q = 0; q <= n; q++) {
    const u = q / n, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    let x = a * ax + b * mx + c * bx, z = a * az + b * mz + c * bz;
    if (q > 0 && q < n) for (const h of L.holes) {
      const dx = x - h.x, dz = z - h.z, d = Math.hypot(dx, dz), lim = h.r + h.a * 1.05;
      if (d < lim) { x = h.x + dx / (d || 1) * lim; z = h.z + dz / (d || 1) * lim; }
    }
    const y = q === 0 ? ay : q === n ? by : topY(L, x, z);
    P.push([x, y, z]);
  }
  for (let q = 1; q < n; q++) if (P[q][1] == null) P[q][1] = P[q - 1][1];
  for (let it = 0; it < 3; it++) for (let q = 1; q < n; q++) P[q][1] = (P[q - 1][1] + 2 * P[q][1] + P[q + 1][1]) / 4;
  for (const p of P) out.push(p[0], p[1], p[2]);
  return out;
}
let flowIdx = [];   // per edge: {start, count, i, j, alpha}
const POS = [0.38, 0.92, 1.0], NEG = [1.0, 0.64, 0.24];
function buildFlows() {
  S.flowDirty = false; flows.reset(); flowIdx = [];
  if (!S.L) { flows.commit(); return; }
  const n = S.ents.length;
  for (const [i, j, w] of S.edgeI || []) {
    const ea = S.ents[i], eb = S.ents[j]; if (!ea?.tgt || !eb?.tgt || i >= n || j >= n) continue;
    const pts = surfacePath(ea, eb), aw = Math.abs(w), col = w >= 0 ? POS : NEG;
    const alpha = clamp(aw, 0.2, 1) * 0.42;
    const start = flows.add(pts, [col[0], col[1], col[2], alpha], [0.12 + aw * 0.35, (i * 0.37 + j * 0.11) % 1, 1 / (S.L.R * 0.55), 0.9 + aw * 1.6]);
    if (start >= 0) flowIdx.push({ start, count: pts.length / 3 - 1, i, j, alpha });
  }
  // sector-level flows between handles (thicker, slower)
  for (const [a, b, w] of S.sedges) {
    const i = S.sidx.get(a), j = S.sidx.get(b); if (i == null || j == null) continue;
    const ha = S.L.holes[i], hb = S.L.holes[j], tmp = [0, 0, 0];
    const tha = Math.atan2(hb.z - ha.z, hb.x - ha.x), thb = Math.atan2(ha.z - hb.z, ha.x - hb.x);
    tubePoint(S.L, ha, tha, 1.7, tmp); const pa = { g: -1, tgt: [...tmp] };
    tubePoint(S.L, hb, thb, 1.7, tmp); const pb = { g: -2, tgt: [...tmp] };
    const pts = surfacePath(pa, pb), aw = Math.abs(w), col = w >= 0 ? POS : NEG;
    const start = flows.add(pts, [col[0], col[1], col[2], clamp(aw, 0.25, 1) * 0.4], [0.06 + aw * 0.12, (i * 0.53) % 1, 1 / (S.L.R * 0.9), 2.0 + aw * 2.5]);
    if (start >= 0) flowIdx.push({ start, count: pts.length / 3 - 1, i: -1, j: -1, alpha: clamp(aw, 0.25, 1) * 0.4, sector: [i, j] });
  }
  flows.commit(); S.flowHover = null;
}
function hueAt(x, z, out) {                     // mirrors the manifold shader's hue blend (decor colour)
  const L = S.L; let r = 0, g = 0, b = 0, ws = 0;
  L.holes.forEach((h, s) => {
    const e = Math.max(Math.hypot(x - h.x, z - h.z) - h.r, 0) / (h.a * 2.8), w = Math.pow(Math.exp(-e * e * 2), 6) + 1e-6;
    const u = U.uHue.value[s]; r += u.x * w; g += u.y * w; b += u.z * w; ws += w;
  });
  const wc = Math.exp(-sq(Math.hypot(x, z) / (L.R * 0.5)) * 6);
  out[0] = (r + wc) / (ws + wc + 1e-6); out[1] = (g + 0.6 * wc) / (ws + wc + 1e-6); out[2] = (b + 0.26 * wc) / (ws + wc + 1e-6);
  return out;
}
function buildStreams() {
  const L = S.L; streams.reset();
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const o = [0, 0, 0];
  const vel = (x, z) => {
    const r = Math.hypot(x, z) || 1;
    let vx = -z / r, vz = x / r;                               // rotational flow around the core
    vx -= x / r * 0.22; vz -= z / r * 0.22;                     // weak pull toward the equilibrium
    L.holes.forEach((h, s) => {                                 // circulation around each handle
      const dx = x - h.x, dz = z - h.z, q = Math.hypot(dx, dz) || 1, w = 2.2 * Math.exp(-sq((q - h.r - h.a) / (1.3 * h.a))) * (s % 2 ? 1 : -1);
      vx += -dz / q * w; vz += dx / q * w;
    });
    const m = Math.hypot(vx, vz) || 1; return [vx / m, vz / m];
  };
  const inside = (x, z) => { field2(L, x, z, o); return o[0] + o[1] < -0.15 * o[1]; };
  const NSEED = MOBILE ? 80 : S.ents.length > 600 ? 110 : 170, step = L.R * 0.018;
  for (let k = 0, tries = 0; k < NSEED && tries < NSEED * 20; tries++) {
    const ang = rnd() * TAU, rr = Math.sqrt(rnd()) * L.ext, x0 = Math.cos(ang) * rr, z0 = Math.sin(ang) * rr;
    if (!inside(x0, z0)) continue;
    k++;
    const upper = rnd() > 0.22;
    const line = [[x0, z0]];
    for (const dir of [1, -1]) {
      let x = x0, z = z0;
      for (let q = 0; q < 46; q++) {
        let [vx, vz] = vel(x, z); const mx = x + vx * step * 0.5 * dir, mz = z + vz * step * 0.5 * dir; [vx, vz] = vel(mx, mz);
        x += vx * step * dir; z += vz * step * dir;
        if (!inside(x, z)) break;
        if (dir > 0) line.push([x, z]); else line.unshift([x, z]);
      }
    }
    if (line.length < 10) continue;
    const pts = [], cols = [], c = [0, 0, 0];
    for (let q = 0; q < line.length; q++) {
      const [x, z] = line[q]; const y = sheet(L, x, z, upper); if (y == null) break;
      pts.push(x, y + (upper ? 0.35 : -0.35), z);
      hueAt(x, z, c); const fade = Math.sin(Math.PI * q / (line.length - 1));
      cols.push([c[0], c[1], c[2], (upper ? 0.11 : 0.06) * (0.2 + 0.8 * fade)]);
    }
    if (pts.length < 30) continue;
    streams.add(pts, null, [0.35 + rnd() * 0.4, rnd(), 1 / (L.R * 0.7), upper ? 1.1 : 0.9], cols);
  }
  streams.commit();
}

// ------------------------------------------------------------------ data stream
function connect(market) {
  if (S.es) S.es.close();
  if (RP.on) stopReplay(true);
  S.market = market; RP.data = null; RP.avail = null; S.spark = null;
  history.replaceState(null, '', `?market=${encodeURIComponent(market)}`);
  S.fitted = false; S.edges = []; S.sedges = []; S.order = null; S.orderFromEdges = false; S.layoutR = null; S.phaseSeen = {};
  $('badgeText').textContent = 'Connecting';
  if (document.body.classList.contains('booting')) boot.set(API.static ? 'Loading recorded snapshot' : 'Connecting to data stream', 0.45);
  S.es = API.stream(market, (m) => {
    S.msgs++; S.recvAt = Date.now();
    if (m.type === 'snapshot') onSnapshot(m);
    else if (m.type === 'diff') onDiff(m);
    else if (m.type === 'edges') onEdges(m);
  }, () => { S.connected = true; }, () => { if (S.connected) toast('Stream interrupted — reconnecting…', 'var(--warn)'); S.connected = false; });
}
function onSnapshot(m) {
  S.meta = m.meta;
  S.sectors = m.sectors.slice(0, MAXS); S.sidx = new Map(S.sectors.map((s, i) => [s.id, i]));
  S.ents = m.entities.filter((e) => S.sidx.has(e.sector)).map((e, i) => ({ ...e, seed: (i * 0.618034) % 1, tick: 0, sz: null, col: null }));
  S.idx = new Map(S.ents.map((e, i) => [e.id, i]));
  S.secState = m.sector_state || {};
  S.status = m.status || []; S.sources = m.sources || []; S.dataTs = m.data_ts; S.nObs = m.n_obs; S.nPersisted = m.n_persisted || 0;
  S.edges = m.edges || []; S.sedges = m.sector_edges || []; S.edgeInfo = m.edge_info;
  for (const [id, x] of Object.entries(S.secState)) S.phaseSeen[id] = !!x.phase;
  indexEdges();
  S.deltaMode = S.deltaMode && S.prevMarket === S.market ? S.deltaMode : (m.meta.view?.default_delta || 'ref');
  S.prevMarket = S.market;
  document.body.classList.remove('live', 'delayed', 'daily', 'simulated'); document.body.classList.add(m.meta.mode);
  $('simbanner').hidden = m.meta.mode !== 'simulated';
  S.order = seriate(); S.orderFromEdges = S.sedges.length > 0;
  sizes(); S.secH = S.sectors.map(() => 0);
  for (const e of S.ents) e.p = null;
  relayout(true);
  buildLabels(); updateChrome(); updateVitals(); updateSources(); updateModel(); updateManifold();
  loadReplayInfo();
}
function onDiff(m) {
  if (!S.meta) return;
  for (const [id, s] of Object.entries(m.ents || {})) {
    const i = S.idx.get(id); if (i == null) continue;
    const e = S.ents[i];
    if (s.ts != null && e.s.ts !== s.ts && !RP.on) e.tick = 1;     // a real sample arrived -> flash
    e.s = s;
  }
  Object.assign(S.secState, m.sectors || {});
  if (m.status) S.status = m.status;
  if (m.sources) S.sources = m.sources;
  S.dataTs = m.data_ts; S.nObs = m.n_obs; S.nPersisted = m.n_persisted ?? S.nPersisted;
  phaseToasts();
  if (!RP.on) {
    sizes(); updateVitals(); updateModel(); updateManifold();
    if (performance.now() - S.lastLayout > 30000) relayout(false);
  }
  updateSources();
}
function phaseToasts() {
  if (RP.on) return;
  for (const s of S.sectors) {
    const x = S.secState[s.id]; if (!x) continue;
    const was = S.phaseSeen[s.id];
    if (x.phase && !was) toast(`${s.label} · phase-lock  |M| ${Math.abs(x.M ?? 0).toFixed(2)} · B ×${(x.b ?? 0).toFixed(1)}`, '#fff');
    else if (!x.phase && was) toast(`${s.label} · phase-lock released`, 'var(--ink3)');
    S.phaseSeen[s.id] = !!x.phase;
  }
}
function indexEdges() {
  S.edgeI = S.edges.map(([a, b, w]) => [S.idx.get(a), S.idx.get(b), w]).filter(([i, j]) => i != null && j != null)
    .sort((p, q) => Math.abs(q[2]) - Math.abs(p[2])).slice(0, 1600);
}
function onEdges(m) {
  S.edges = m.edges || []; S.sedges = m.sector_edges || []; S.edgeInfo = m.edge_info;
  indexEdges();
  if (!S.orderFromEdges && S.sedges.length) {         // first correlation estimate: order the ring once
    S.orderFromEdges = true; const o = seriate();
    if (o.join() !== (S.order || []).join()) { S.order = o; relayout(true); }
  }
  S.flowDirty = true;
  updateModel(); updateStatus(); updateManifold();
}

// ------------------------------------------------------------------ sources: freshness + coverage
function freshness(s, now) {
  if (s.planned) return 'planned';
  if (s.state === 'skip') return 'skip';
  if (API.static) return s.last_ok ? 'snapshot' : (s.state === 'error' ? 'error' : 'waiting');
  if (!s.last_ok) return s.state === 'error' ? 'error' : 'waiting';
  const age = now - s.last_ok;
  if (age > s.stale_after_s * 1000) return s.state === 'error' ? 'error' : 'stale';
  if (age > (s.cadence_s * 1.5 + 5) * 1000 || s.state === 'error') return 'late';
  return 'fresh';
}
const cadTxt = (c) => (c < 90 ? `${c}s` : c < 5400 ? `${Math.round(c / 60)}m` : c < 172800 ? `${Math.round(c / 3600)}h` : `${Math.round(c / 86400)}d`);
const FTXT = { fresh: 'Fresh', late: 'Late', stale: 'Stale', error: 'Error', skip: 'Skipped', planned: 'Planned', waiting: 'Waiting', snapshot: 'Recorded' };
function updateSources() {
  const now = Date.now(), rows = [], bad = [];
  for (const s of S.sources || []) {
    const f = freshness(s, now);
    if (f === 'stale' || f === 'error') bad.push(`${s.id} ${f}`);
    const age = s.last_ok ? (API.static ? fmtDate(s.last_ok).slice(5) : `${ago(now - s.last_ok)} ago`) : '';
    rows.push(`<div class="src"><span class="st st-${f}"></span><span class="nm" title="${esc(s.label)}">${esc(s.id)}<small>every ${cadTxt(s.cadence_s)}</small></span>
      <span class="ag t-${f}">${FTXT[f] || f}${age ? ` · ${age}` : ''}</span><span class="ms">${esc(s.label)}${s.msg ? ' — ' + esc(s.msg) : ''}</span></div>`);
  }
  const html = rows.join('') || '<div class="src"><span></span><span class="nm">No sources declared</span></div>';
  if ($('srcs')._h !== html) { $('srcs').innerHTML = html; $('srcs')._h = html; }
  const real = (S.sources || []).filter((s) => !s.planned);
  $('srcsum').textContent = API.static ? `${real.filter((s) => s.last_ok).length}/${real.length} recorded` : `${real.filter((s) => freshness(s, now) === 'fresh').length}/${real.length} fresh`;
  const chip = $('stale');
  if (bad.length && !RP.on && !API.static) { chip.hidden = false; chip.textContent = `${bad.length} source${bad.length > 1 ? 's' : ''} stale`; chip.title = bad.join(', '); }
  else chip.hidden = true;
}

// ------------------------------------------------------------------ replay (stored history, same render path)
async function loadReplayInfo() {
  const m = S.market;
  try {
    const r = await API.replay(m);
    if (m !== S.market) return;
    RP.avail = r.available ? r : null; RP.reason = r.reason || r.detail || '';
    updateTimeline();
    if (r.available) loadSpark(r.grains);
  } catch (err) { RP.avail = null; RP.reason = 'history API unavailable'; updateTimeline(); }
}
async function fetchFrames(grain, maxFrames) {
  const m = S.market;
  const r = await API.replay(m, grain, maxFrames);
  if (m !== S.market || !r.available) return null;
  const n = S.ents.length, per = Array.from({ length: n }, () => ({ t: [], v: [], x: [] }));
  const { e, t, v, x } = r.cols;
  for (let k = 0; k < e.length; k++) { const p = per[e[k]]; if (!p) continue; p.t.push(r.times[t[k]]); p.v.push(v[k]); p.x.push(x[k] ?? 0); }
  for (const p of per) { p.c = new Float64Array(p.x.length + 1); for (let k = 0; k < p.x.length; k++) p.c[k + 1] = p.c[k] + (p.x[k] || 0); }
  return { ...r, per, gms: GRAIN_S[r.grain] * 1000 };
}
function pickGrain(speed, grains) {
  const gs = [...grains].sort((a, b) => GRAIN_S[a] - GRAIN_S[b]);
  return gs.find((g) => GRAIN_S[g] >= speed / 40) || gs[gs.length - 1];
}
async function startReplay(speed, frac) {
  if (!RP.avail) return;
  RP.speed = speed ?? RP.speed;
  const g = pickGrain(RP.speed, RP.avail.grains);
  if (!RP.data || RP.data.grain !== g) {
    RP.loading = true; updateTimeline();
    const keepT = RP.T;
    RP.data = await fetchFrames(g, 5000);
    RP.loading = false;
    if (!RP.data) { updateTimeline(); return; }
    RP.T = keepT != null ? clamp(keepT, RP.data.from, RP.data.to) : RP.data.from;
  }
  if (frac != null) RP.T = RP.data.from + (RP.data.to - RP.data.from) * frac;
  if (RP.T == null || RP.T >= RP.data.to) RP.T = RP.data.from;
  RP.on = true; RP.playing = true;
  for (const e of S.ents) { e.rk = -1; e.tick = 0; }
  document.body.classList.add('replaying'); $('bigtime').hidden = false;
  updateChrome(); updateTimeline();
}
function stopReplay(silent) {
  RP.on = false; RP.playing = false;
  document.body.classList.remove('replaying'); $('bigtime').hidden = true;
  for (const e of S.ents) e.rs = null;
  if (!silent) { sizes(); updateChrome(); updateVitals(); updateModel(); updateTimeline(); updateSources(); updateManifold(); }
}
function autoReplay() {     // static host: start the recorded time-lapse so the organism moves on arrival
  if (RP.on || !RP.avail || S.userTouched) return;
  const sp = RP.avail.grains.includes('1h') ? 3600 : 86400;
  startReplay(sp);
}
function windowMs(g) { return { '1m': 3600e3, '1h': 86400e3, '1d': 7 * 86400e3 }[g] || 86400e3; }
function ub(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
function valAt(p, T, gms) {
  const k = ub(p.t, T) - 1; if (k < 0) return [null, -1, false];
  if (k + 1 < p.t.length && p.t[k + 1] - p.t[k] <= 12 * gms) {
    const f = (T - p.t[k]) / (p.t[k + 1] - p.t[k]);
    return [p.v[k] + (p.v[k + 1] - p.v[k]) * sstep(f), k, false];        // smooth interpolation between real samples
  }
  return [p.v[k], k, T - p.t[k] > 12 * gms];                              // gap (market closed / no reviews): hold, don't invent
}
function replayStep(dt) {
  const D = RP.data; if (!D) return;
  if (RP.playing) { RP.T += RP.speed * dt * 1000; if (RP.T >= D.to) { RP.T = D.to; RP.playing = false; updateTimeline(); } }
  const T = RP.T, W = windowMs(D.grain), gms = D.gms;
  S.ents.forEach((e, i) => {
    const p = D.per[i];
    if (!p || !p.t.length) { e.rs = { m: `no stored ${D.source} history`, sc: [0, 1] }; return; }
    const [v, k, held] = valAt(p, T, gms);
    if (v == null) { e.rs = { m: 'no stored sample before this time', sc: [0, 1] }; return; }
    if (k !== e.rk) { if (e.rk >= 0) e.tick = 1; e.rk = k; }              // crossed a real sample instant -> flash
    const [v0, k0] = valAt(p, T - W, gms);
    const base = v0 ?? p.v[0];
    const d = deltaKind(e) === 'abs' ? v - base : (base ? v / base - 1 : null);
    const kk = Math.max(k0, -1);
    const en = p.c[k + 1] - p.c[kk + 1], nwin = Math.max(1, k - kk);
    const b = en > 0 ? (p.x[k] || 0) / (en / nwin) : null;
    e.rs = { v, e: en, dr: d, dw: d, b, ts: p.t[k], m: null, held, sc: [1, 1], rk: k };
  });
  const sec = {};
  S.sectors.forEach((s) => {
    let E = 0, wr = 0, Er = 0, bs = 0, nb = 0, live = 0, su = 0, nu = 0; const spins = [];
    for (const id of s.members) {
      const r = S.ents[S.idx.get(id)]?.rs; if (!r || r.m) continue; live++;
      const e = r.e || 0; E += e; if (r.dr != null) { wr += e * r.dr; Er += e; su += r.dr; nu++; if (r.dr) spins.push(r.dr > 0 ? 1 : -1); }
      if (r.b != null) { bs += r.b; nb++; }
    }
    const M = spins.length ? spins.reduce((a, b) => a + b, 0) / spins.length : null;
    const dd = Er ? wr / Er : nu ? su / nu : null;   // no volume in the window (market closed): plain mean
    sec[s.id] = { e: E, dr: dd, dw: dd, M, b: nb ? bs / nb : null, phase: false, n: live, N: s.members.length, cov: [live, s.members.length] };
  });
  RP.sec = sec;
}
async function loadSpark(grains) {
  const g = grains.includes('1h') ? '1h' : grains.includes('1d') ? '1d' : grains[grains.length - 1];
  const D = await fetchFrames(g, 400); if (!D) return;
  const T0 = D.times, stepK = Math.max(1, Math.floor(T0.length / 120)), T = T0.filter((_, i) => i % stepK === 0 || i === T0.length - 1), out = {};
  S.sectors.forEach((s) => {
    const mem = s.members.map((id) => D.per[S.idx.get(id)]).filter((p) => p && p.t.length);
    if (!mem.length) return;
    out[s.id] = T.map((t) => { let a = 0, n = 0; for (const p of mem) { const k = ub(p.t, t) - 1; if (k >= 0 && p.v[0]) { a += p.v[k] / p.v[0] - 1; n++; } } return n ? a / n : null; });
  });
  S.spark = { g, out, from: T[0], to: T[T.length - 1], n: T.length };
  updateVitals();
}
function sparkSvg(ys, hue) {
  if (!ys) return '<svg></svg>';
  const v = ys.filter((y) => y != null); if (v.length < 2) return '<svg></svg>';
  const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1e-9;
  let d = ''; ys.forEach((y, i) => { if (y == null) return; d += `${d ? 'L' : 'M'}${(i / (ys.length - 1) * 56).toFixed(1)},${(20 - (y - lo) / r * 18).toFixed(1)}`; });
  const last = d.split(/[ML]/).pop().split(',');
  return `<svg viewBox="0 0 56 22"><path d="${d}" fill="none" stroke="${hue}" stroke-width="1.25" stroke-linejoin="round" opacity=".9"/><circle cx="${last[0]}" cy="${last[1]}" r="1.8" fill="${hue}"/></svg>`;
}

// ------------------------------------------------------------------ chrome (DOM)
async function loadTabs() {
  const ms = await API.markets();
  S.marketList = ms;
  $('tabs').innerHTML = '';
  ms.forEach((mk, k) => {
    const b = document.createElement('button');
    b.dataset.id = mk.id; b.title = `${mk.title}  (${k + 1})`;
    b.innerHTML = `<span class="mdot m-${mk.mode}"></span>${esc(shortTitle(mk.title))}`;
    b.onclick = () => { S.userTouched = true; connect(mk.id); markTabs(); };
    $('tabs').appendChild(b);
  });
  S.historyError = ms[0]?.history_error;
  if (!S.market || !ms.find((x) => x.id === S.market)) S.market = ms[0]?.id;
  connect(S.market); markTabs();
}
const shortTitle = (t) => String(t).split('·')[0].trim();
function markTabs() { for (const b of $('tabs').children) { b.classList.toggle('on', b.dataset.id === S.market); if (b.dataset.id === S.market) b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } }

const MODE_TEXT = { live: 'Live', delayed: 'Delayed', daily: 'Daily', simulated: 'Simulated' };
function updateChrome() {
  const M = S.meta; if (!M) return;
  const b = $('badge');
  b.className = 'badge ' + (RP.on ? 'replay' : API.static ? 'snapshot' : M.mode);
  $('badgeText').textContent = RP.on ? 'Replay · recorded' : API.static ? 'Snapshot' : (MODE_TEXT[M.mode] || M.mode);
  $('source').textContent = RP.on && RP.data ? `Stored history · ${RP.data.source} · ${RP.data.grain} buckets` : M.source;
  $('tagline').textContent = M.title;
  $('note').textContent = M.note || '';
  const L = M.labels || {};
  $('lgSize').textContent = `size = ${RP.on ? (RP.data?.energy === 'count' ? 'samples in window' : 'volume in window') : (L.energy || 'energy')} · colour = Δ · flare = burst`;
  $('lgEdge').textContent = (L.edges || 'correlation') + (RP.on ? ' · live edges, not replayed' : API.static ? ' · as recorded' : '');
  $('bRef').textContent = 'Δ ' + (L.delta_ref || 'ref'); $('bWin').textContent = 'Δ ' + (L.delta_win || 'window');
  $('bRef').title = $('bRef').textContent; $('bWin').title = $('bWin').textContent;
  for (const el of document.querySelectorAll('.layer')) el.title = el.querySelector('small').textContent;
  $('bRef').classList.toggle('on', S.deltaMode !== 'win'); $('bWin').classList.toggle('on', S.deltaMode === 'win');
  $('bKR').classList.toggle('on', S.conv === 'kr'); $('bUS').classList.toggle('on', S.conv === 'us');
  $('bSpin').classList.toggle('on', S.spin);
  const c = COL[S.conv];
  $('scale').style.background = `linear-gradient(90deg, ${rgb(c.dn)}, ${rgb(COL.mid)}, ${rgb(c.up)})`;
  const kind = deltaKind(null);
  $('smin').textContent = fmtDelta(-clip(), kind); $('smax').textContent = fmtDelta(clip(), kind);
  $('tLiveTxt').textContent = API.static ? 'Snapshot' : 'Live';
  $('tLive').classList.toggle('snap', API.static);
  updateStatus();
}
$('bRef').onclick = () => { S.deltaMode = 'ref'; updateChrome(); updateVitals(); updateManifold(); };
$('bWin').onclick = () => { S.deltaMode = 'win'; updateChrome(); updateVitals(); updateManifold(); };
$('bKR').onclick = () => { S.conv = 'kr'; store.set('mo.conv', 'kr'); updateChrome(); updateVitals(); updateManifold(); };
$('bUS').onclick = () => { S.conv = 'us'; store.set('mo.conv', 'us'); updateChrome(); updateVitals(); updateManifold(); };
$('bFit').onclick = () => fit(false);
$('bSpin').onclick = () => toggleSpin();
function toggleSpin() { S.spin = !S.spin; store.set('mo.spin', S.spin ? '1' : '0'); controls.autoRotate = S.spin; updateChrome(); }
for (const el of document.querySelectorAll('.layer')) {
  const k = el.dataset.k, cb = el.querySelector('input');
  S.layers[k] = store.get('mo.layer.' + k, '1') === '1'; cb.checked = S.layers[k]; el.classList.toggle('off', !S.layers[k]);
  cb.onchange = () => { S.layers[k] = cb.checked; store.set('mo.layer.' + k, cb.checked ? '1' : '0'); el.classList.toggle('off', !cb.checked); };
}
// mobile sheet
{
  let sheet0 = store.get('mo.sheet', 'sectors');
  const setSheet = (k) => { document.body.dataset.sheet = k; for (const b of $('sheetTabs').children) b.classList.toggle('on', b.dataset.sheet === k); store.set('mo.sheet', k); applyViewOffset(); };
  for (const b of $('sheetTabs').children) b.onclick = () => setSheet(document.body.dataset.sheet === b.dataset.sheet ? '' : b.dataset.sheet);
  setSheet(MOBILE ? '' : sheet0);
}
// help
$('helpBtn').onclick = () => { $('help').hidden = false; };
$('helpClose').onclick = () => { $('help').hidden = true; };
$('help').onclick = (e) => { if (e.target === $('help')) $('help').hidden = true; };

// timeline
$('tLive').onclick = () => { S.userTouched = true; if (RP.on) stopReplay(false); };
$('tPlay').onclick = () => { S.userTouched = true; togglePlay(); };
for (const b of document.querySelectorAll('#timeline .sp')) b.onclick = () => { S.userTouched = true; startReplay(+b.dataset.sp); };
const scrub = $('scrub');
scrub.oninput = () => {
  S.userTouched = true;
  if (!RP.avail) return;
  const f = scrub.value / 1000;
  if (!RP.on || !RP.data) { startReplay(RP.speed, f).then(() => { RP.playing = false; updateTimeline(); }); return; }
  RP.T = RP.data.from + (RP.data.to - RP.data.from) * f; RP.playing = false; updateTimeline();
};
function togglePlay() {
  if (!RP.avail) return;
  if (!RP.on) { startReplay(RP.speed); return; }
  if (RP.T >= RP.data.to) RP.T = RP.data.from;
  RP.playing = !RP.playing; updateTimeline();
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'f' || k === 'F') fit(false);
  else if (k === 'r' || k === 'R') toggleSpin();
  else if (k === 'l' || k === 'L') { if (RP.on) stopReplay(false); }
  else if (k === '?') $('help').hidden = !$('help').hidden;
  else if (k === 'Escape') { if (!$('help').hidden) $('help').hidden = true; else if (RP.on) stopReplay(false); else fit(false); }
  else if (k === ' ') { e.preventDefault(); S.userTouched = true; togglePlay(); }
  else if (/^[1-9]$/.test(k) && S.marketList?.[+k - 1]) { S.userTouched = true; connect(S.marketList[+k - 1].id); markTabs(); }
});
const SPTXT = { 86400: '1 day / s', 3600: '1 hour / s', 60: '1 minute / s' };
function updateTimeline() {
  const A = RP.avail;
  $('tLive').classList.toggle('on', !RP.on);
  $('tPlayIco').setAttribute('d', RP.on && RP.playing ? 'M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z' : 'M5 3.5v9l7-4.5z');
  for (const b of document.querySelectorAll('#timeline .sp')) b.classList.toggle('on', RP.on && +b.dataset.sp === RP.speed);
  const dis = !A;
  for (const b of document.querySelectorAll('#timeline .sp, #tPlay')) b.disabled = dis;
  scrub.disabled = dis;
  if (!A) {
    $('tlinfo').textContent = S.meta?.history === false ? 'History disabled for this market' : `No replay — ${RP.reason || '—'}`;
    $('tlFrom').textContent = ''; $('tlTo').textContent = ''; scrub.style.setProperty('--p', '100%'); return;
  }
  const D = RP.data;
  const from = D?.from ?? Math.min(...Object.values(A.range).map((r) => r.from)), to = D?.to ?? Math.max(...Object.values(A.range).map((r) => r.to));
  $('tlFrom').textContent = fmtDate(from); $('tlTo').textContent = fmtDate(to);
  const rows = Object.values(A.range).reduce((s, r) => s + r.rows, 0);
  $('tlinfo').textContent = RP.loading ? 'Loading history…' : `${A.source} · ${rows.toLocaleString()} stored rows`;
  scrub.value = RP.on && D ? Math.round((RP.T - D.from) / Math.max(D.to - D.from, 1) * 1000) : 1000;
  scrub.style.setProperty('--p', `${scrub.value / 10}%`);
}
function updateBigTime() {
  if (!RP.on || !RP.data) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('btT').textContent = fmtDate(RP.T, RP.data.grain === '1m').replace(' ', '  ');
  $('btR').textContent = `Replay · ${SPTXT[RP.speed] || RP.speed + ' s/s'}${RP.playing ? '' : ' · paused'}`;
  const W = { '1m': 'T−1h', '1h': 'T−24h', '1d': 'T−7d' }[RP.data.grain];
  $('btN').textContent = `${tz} · stored ${RP.data.grain} buckets of ${RP.data.source} · colour = Δ vs ${W} · size = ${RP.data.energy === 'count' ? 'samples' : 'volume'} in window · flows = ${API.static ? 'recorded' : 'live'} edges`;
}
function updateClock() {
  if (!S.meta) return;
  const now = Date.now();
  let html;
  if (RP.on) html = `${fmtDate(RP.T, true)} <span class="age">· recorded</span>`;
  else if (API.static) html = `${fmtDate(S.dataTs, true)} <span class="age">· snapshot, not live</span>`;
  else html = `${fmtDate(S.dataTs, true)} <span class="age">· age ${S.dataTs ? ago(now - S.dataTs) : '—'}${S.connected ? '' : ' · <span class="lv-error">stream down</span>'}</span>`;
  if ($('clock')._h !== html) { $('clock').innerHTML = html; $('clock')._h = html; }
}
function updateStatus() {
  const lines = (S.status || []).map((s) => `<div class="lv-${s.level}">● ${esc(s.msg)}</div>`);
  const ei = S.edgeInfo;
  lines.push(ei && ei.n_obs ? `<div>flows ${S.edges.length} (${ei.n_included} entities × ${ei.n_obs} returns) · sector flows ${S.sedges.length}</div>`
    : `<div class="lv-info">flows: warming up (need ≥${S.meta?.engine?.corr_min ?? '?'} returns of ${esc(S.meta?.corr_source || '?')})</div>`);
  if (API.static) lines.push(`<div>static export · recorded ${fmtDate(API.exported?.exported_at, true)} · no server</div>`);
  else lines.push(`<div>history: ${S.meta?.history ? `${S.nPersisted.toLocaleString()} rows written this run` : '<span class="lv-error">not recorded</span>'}</div>`);
  lines.push(`<div id="perf"></div>`);
  $('stlines').innerHTML = lines.join('');
}
function updateVitals() {
  if (!S.meta) return;
  const rows = S.sectors.map((s, i) => ({ s, i, st: secSt(s.id) })).sort((a, b) => (b.st.e || 0) - (a.st.e || 0));
  const out = [];
  for (const { s, i, st: x } of rows) {
    const d = secDelta(x), col = rgb(colorFor(d, [0, 0, 0])), hue = HUES[i % HUES.length];
    const cov = x.cov && x.cov[1] > (x.N ?? 0) ? ` · src ${x.cov[0]}/${x.cov[1]}` : '';
    out.push(`<div class="vrow${hovSec === i ? ' hl' : ''}" role="listitem" data-s="${s.id}" data-i="${i}"><span class="sw" style="background:${hue};box-shadow:0 0 8px ${hue}"></span>
      <div class="nm">${esc(s.label)}${x.phase ? '<span class="tag">LOCK</span>' : ''}<small>${x.n ?? 0}/${x.N ?? s.members.length} live${cov}</small></div>
      <div class="d" style="color:${col}">${fmtDelta(d, deltaKind(S.ents[S.idx.get(s.members[0])]))}<small>${x.b == null ? '—' : '×' + x.b.toFixed(2)}</small></div>
      ${sparkSvg(S.spark?.out?.[s.id], hue)}</div>`);
  }
  const html = out.join('');
  if ($('vrows')._h !== html) {
    $('vrows').innerHTML = html; $('vrows')._h = html;
    for (const el of $('vrows').children) {
      el.onclick = () => flyToSector(+el.dataset.i);
      el.onmouseenter = () => { hovSecList = +el.dataset.i; }; el.onmouseleave = () => { hovSecList = null; };
    }
  }
  $('vhint').textContent = S.spark ? `${S.spark.g} spark · ${fmtDate(S.spark.from).slice(5, 10)} → ${fmtDate(S.spark.to).slice(5, 10)}` : `${S.sectors.length} handles`;
}
function marketAgg() {
  let wr = 0, Er = 0, bs = 0, nb = 0, Et = 0, su = 0, nu = 0;
  S.sectors.forEach((s) => { const x = secSt(s.id); Et += x.e || 0; const d = secDelta(x); if (d != null) { su += d; nu++; if (x.e) { wr += x.e * d; Er += x.e; } } if (x.b != null) { bs += x.b; nb++; } });
  const ds = S.ents.map((e) => { const s = st(e); return s.m ? null : deltaOf(s); }).filter((d) => d != null && isFinite(d));
  const mu = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : null;
  const sd = ds.length > 2 ? Math.sqrt(ds.reduce((a, b) => a + sq(b - mu), 0) / (ds.length - 1)) : null;
  return { d: Er ? wr / Er : nu ? su / nu : null, b: nb ? bs / nb : null, E: Et, ds, sd, mu };
}
function updateManifold() {
  if (!S.meta) return;
  const A = marketAgg(); S.agg = A;
  const secs = S.sectors.map((s) => secSt(s.id));
  const live = S.ents.filter((e) => !st(e).m).length;
  const rhos = S.edges.map((x) => Math.abs(x[2])), mr = rhos.length ? rhos.reduce((a, b) => a + b, 0) / rhos.length : null;
  const kind = deltaKind(S.ents[0]);
  const rows = [
    ['g', 'Handles · sectors', `${S.sectors.length}`],
    ['n', 'Cells live', `${live} / ${S.ents.length}`],
    ['ρ', 'Flows · ⟨|ρ|⟩', `${S.edges.length} · ${mr == null ? '—' : mr.toFixed(2)}`],
    ['B', RP.on ? 'Market volume ratio' : 'Market burst', A.b == null ? '—' : `×${A.b.toFixed(2)}`],
    ['M', 'Phase-locked', `${secs.filter((x) => x.phase).length} / ${S.sectors.length}`],
    ['σ', 'Δ dispersion', A.sd == null ? '—' : fmtDelta(A.sd, kind).replace('+', '')],
    ['E', 'Total energy', fmtNum(A.E)],
  ];
  const html = rows.map(([s, k, v]) => `<dt><i>${s}</i>${k}</dt><dd>${v}</dd>`).join('');
  if ($('mstats')._h !== html) { $('mstats').innerHTML = html; $('mstats')._h = html; }
  $('mhint').textContent = RP.on ? 'replay values' : API.static ? 'recorded values' : 'live values';
  // Δ histogram
  const NB = 28, lim = clip(), bins = new Array(NB).fill(0);
  for (const d of A.ds) bins[clamp(Math.floor((d / lim + 1) / 2 * NB), 0, NB - 1)]++;
  const mx = Math.max(...bins, 1), tmp = [0, 0, 0];
  const hh = bins.map((n, i) => `<i style="height:${Math.max(n / mx * 100, 3)}%;background:${rgb(colorFor(((i + 0.5) / NB * 2 - 1) * lim, tmp))};opacity:${n ? 0.95 : 0.25}"></i>`).join('');
  if ($('hist')._h !== hh) { $('hist').innerHTML = hh; $('hist')._h = hh; }
  $('histRange').textContent = `${fmtDelta(-lim, kind)} … ${fmtDelta(lim, kind)}`;
}
function updateModel() {
  if (!S.meta) return;
  const E = S.meta.engine || {}, hk = E.hawkes || {}, ph = E.phase || {};
  const tS = cadTxt(hk.tau_short_s || 0), tL = cadTxt(hk.tau_long_s || 0);
  $('eqMain').innerHTML = `B<sub>i</sub> = λ<sub>i</sub><sup>(${tS})</sup> ⁄ λ<sub>i</sub><sup>(${tL})</sup> <span class="up">,</span>&nbsp; λ(t) = μ + α Σ<sub>k</sub> e<sup>−(t−t<sub>k</sub>)/τ</sup>`;
  const secs = S.sectors.map((s) => secSt(s.id));
  const Ms = secs.map((x) => x.M).filter((m) => m != null), mM = Ms.length ? Ms.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : null;
  const mode = E.edge_mode === 'residual' ? 'ε' : 'r';
  $('eqs').innerHTML = [
    `ρ<sub>ij</sub> = corr(${mode}<sub>i</sub>, ${mode}<sub>j</sub>) · <b>${S.edges.length}</b> flows`,
    `M = ⟨sgn Δ⟩ · max |M| <b>${mM == null ? '—' : Math.abs(mM).toFixed(2)}</b>`,
    `lock: |M| ≥ ${ph.M_on ?? '—'} ∧ B ≥ ${ph.B_on ?? '—'} · <b>${secs.filter((x) => x.phase).length}</b>`,
  ].map((s) => `<span>${s}</span>`).join('');
}

// ------------------------------------------------------------------ toasts
function toast(msg, color) {
  const el = document.createElement('div'); el.className = 'toast'; el.style.setProperty('--c', color || 'var(--cy)');
  el.innerHTML = `<i></i>${esc(msg)}`; $('toasts').appendChild(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, 4200);
}

// ------------------------------------------------------------------ labels
let entLabels = [], secLabels = [], leaders = [], axisTicks = [];
const SVGNS = 'http://www.w3.org/2000/svg';
function buildLabels() {
  const root = $('labels'), svg = $('leaders');
  for (const el of [...root.querySelectorAll('.lab, .slab')]) el.remove();
  svg.innerHTML = '';
  secLabels = S.sectors.map((s, i) => { const d = document.createElement('div'); d.className = 'slab'; d.style.setProperty('--hue', HUES[i % HUES.length]); root.appendChild(d); return d; });
  leaders = S.sectors.map((s, i) => {
    const g = document.createElementNS(SVGNS, 'g'), p = document.createElementNS(SVGNS, 'path'), c = document.createElementNS(SVGNS, 'circle');
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', HUES[i % HUES.length]); p.setAttribute('stroke-width', '1'); p.setAttribute('stroke-opacity', '.55');
    c.setAttribute('r', '2.6'); c.setAttribute('fill', '#fff');
    g.appendChild(p); g.appendChild(c); svg.appendChild(g); return { g, p, c };
  });
  entLabels = [];
  for (let i = 0; i < Math.min(S.ents.length, 80); i++) { const d = document.createElement('div'); d.className = 'lab'; d.style.display = 'none'; root.appendChild(d); entLabels.push(d); }
  $('axis').innerHTML = ['+2σ', '+σ', '0', '−σ', '−2σ'].map((t, k) => `<div class="tk${k === 2 ? ' z' : ''}">${t}</div>`).join('') + '<div class="ax">Δ̄ ⁄ σ</div>';
  axisTicks = [...$('axis').children];
}

// ------------------------------------------------------------------ camera fit / fly
let fitDist = 300;
function fit(instant) {
  if (!S.L) return;
  const E = S.L.ext;
  const vfov = cam.fov * Math.PI / 180, wide = innerWidth > 1060, hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect * (wide ? 0.62 : 1.0));
  fitDist = Math.max(E / Math.tan(Math.min(vfov * (wide ? 0.95 : 0.92), hfov) / 2) * (wide ? 1.0 : 1.0), 60);
  const el0 = wide ? 0.62 : 0.95, dir = new THREE.Vector3(0.0, Math.sin(el0), Math.cos(el0));
  if (!instant) { const cur = new THREE.Vector3().subVectors(cam.position, controls.target).normalize(); if (cur.y > 0.15 && isFinite(cur.x)) dir.copy(cur); }
  const tgt = new THREE.Vector3(0, -S.L.D * 0.05, 0), pos = tgt.clone().addScaledVector(dir, fitDist);
  if (instant) { controls.target.copy(tgt); cam.position.copy(pos); controls.update(); flyTo = null; }
  else flyTo = { tgt, pos };
}
function flyToSector(s) {
  if (s == null || !S.L?.holes[s]) return;
  const h = S.L.holes[s], y = topY(S.L, h.x + h.r + h.a, h.z) ?? 0;
  const c = new THREE.Vector3(h.x, y, h.z);
  const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize();
  if (dir.y < 0.3) { dir.y = 0.45; dir.normalize(); }
  flyTo = { tgt: c, pos: c.clone().addScaledVector(dir, (h.r + 2 * h.a) * 4.4) };
  controls.autoRotate = false; lastUser = performance.now();
}

// ------------------------------------------------------------------ picking / tooltip
const proj = new THREE.Vector3();
let spos = new Float32Array(MAXE * 3), hovered = null, mouse = null, down = null, hovSec = null, hovSecList = null;
let hoverFollow = null;
canvas.addEventListener('pointermove', (e) => { hoverFollow = null; mouse = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerleave', () => { mouse = null; });
canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; S.userTouched = true; });
canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) {
    const h = pick(e.clientX, e.clientY);
    if (h) flyToSector(h.kind === 'sector' ? h.i : S.ents[h.i].g);
  }
  down = null;
});
function pick(x, y) {
  let best = null, bd = Infinity;
  for (let i = 0; i < S.ents.length; i++) {
    if (spos[3 * i + 2] <= 0) continue;
    const d = Math.hypot(spos[3 * i] - x, spos[3 * i + 1] - y), r = Math.max(8, spos[3 * i + 2] * 0.42);
    if (d < r && d < bd) { bd = d; best = { kind: 'ent', i }; }
  }
  if (best || !S.L) return best;
  for (let s = 0; s < S.sectors.length; s++) {
    const h = S.L.holes[s], y = (topY(S.L, h.x + h.r + h.a, h.z) ?? 0) + (S.secH[s] || 0);
    proj.set(h.x, y, h.z).project(cam); if (proj.z > 1) continue;
    const sx = (proj.x + 1) / 2 * innerWidth, sy = (1 - proj.y) / 2 * innerHeight;
    const rpx = (h.r + h.a * 1.5) * U.uPx.value / DPR / cam.position.distanceTo(tmpV.set(h.x, y, h.z));
    if (Math.hypot(sx - x, sy - y) < rpx) return { kind: 'sector', i: s };
  }
  return null;
}
function tipHtml(h) {
  const L = S.meta.labels || {};
  if (h.kind === 'ent') {
    const e = S.ents[h.i], s = st(e), sec = S.sectors[e.g];
    const head = `<h4>${esc(e.label)}</h4><div class="sub">${esc(sec.label)} · ${esc(e.id)}${RP.on ? ' · replay' : API.static ? ' · snapshot' : ''}</div>`;
    const srcs = srcRows(e);
    if (s.m) return `${head}<div class="miss">Empty — ${esc(s.m)}</div>${srcs}`;
    const rows = [];
    rows.push([L.value || 'value', fmtNum(s.v) + (s.held ? ' (held: gap)' : '')]);
    rows.push([RP.on ? 'volume in window' : (L.energy || 'energy'), fmtNum(s.e)]);
    if (RP.on) rows.push([`Δ vs ${{ '1m': 'T−1h', '1h': 'T−24h', '1d': 'T−7d' }[RP.data.grain]}`, fmtDelta(s.dr, deltaKind(e))]);
    else {
      rows.push([L.delta_ref || 'Δ ref', fmtDelta(s.dr, e.meta?.delta_kind || L.delta_kind)]);
      rows.push([L.delta_win || 'Δ window', fmtDelta(s.dw, L.delta_win_kind || L.delta_kind) + (s.dwp ? ' (partial)' : '')]);
    }
    rows.push([RP.on ? 'burst (volume ratio)' : 'burst (Hawkes)', s.b == null ? '— (no events yet)' : `×${s.b.toFixed(2)}${RP.on ? '' : ` · ${fmtNum(s.x)}/s`}`]);
    rows.push([RP.on ? 'stored sample' : 'source time', (s.ts ? fmtDate(s.ts, true) : '—') + (e.stale ? ` <span class="t-stale">stale — ${ago(S.dataTs - s.ts)} behind</span>` : '')]);
    if (!RP.on) {
      const nb = S.edges.filter((x) => x[0] === e.id || x[1] === e.id).sort((a, b) => Math.abs(b[2]) - Math.abs(a[2])).slice(0, 4)
        .map((x) => `${esc(S.ents[S.idx.get(x[0] === e.id ? x[1] : x[0])]?.label)} <span style="color:${x[2] >= 0 ? '#7fe8ff' : '#ffb366'}">${x[2] >= 0 ? '+' : '−'}${Math.abs(x[2]).toFixed(2)}</span>`);
      rows.push(['flows ρ', nb.length ? nb.join('<br>') : '—']);
      for (const [k, v] of Object.entries(s.xt || {})) if (v != null && v !== '') rows.push([k, esc(typeof v === 'number' ? fmtNum(v) : v)]);
    }
    return `${head}<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>${srcs}`;
  }
  const sec = S.sectors[h.i], x = secSt(sec.id), kind = deltaKind(S.ents[S.idx.get(sec.members[0])]);
  const links = S.sedges.filter((y) => y[0] === sec.id || y[1] === sec.id).map((y) => `${esc(S.sectors[S.sidx.get(y[0] === sec.id ? y[1] : y[0])]?.label)} ${y[2] >= 0 ? '+' : '−'}${Math.abs(y[2]).toFixed(2)}`);
  const rows = [
    ['members live', `${x.n ?? 0} / ${x.N ?? sec.members.length}`],
    ['source coverage', x.cov ? `${x.cov[0]} / ${x.cov[1]} entity·sources` : '—'],
    [L.energy || 'energy', fmtNum(x.e)], ['Δ (energy-weighted)', fmtDelta(secDelta(x), kind)],
    ['magnetisation M', x.M == null ? '—' : x.M.toFixed(2)], ['sector burst', x.b == null ? '—' : '×' + x.b.toFixed(2)],
    ['phase-lock', x.phase ? 'yes — |M| and burst over threshold' : 'no'], ['sector flows', links.length ? links.join('<br>') : '—'],
  ];
  return `<h4>${esc(sec.label)}</h4><div class="sub">Handle · click to fly in</div><table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
}
function srcRows(e) {
  if (RP.on) return `<div class="srcs sub">replay source: ${esc(RP.data?.source)} only</div>`;
  const s = e.s, now = Date.now();
  const exp = Object.keys(s.sx || {});
  if (exp.length <= 1 && !s.sm) return '';
  const rows = exp.map((sid) => {
    const src = S.sources.find((x) => x.id === sid) || {};
    const miss = s.sm?.[sid], rx = s.sx[sid], sv = s.sv?.[sid];
    let txt;
    if (src.planned) txt = '<span class="t-planned">planned</span>';
    else if (src.state === 'skip') txt = `<span class="t-skip">skipped — ${esc(src.msg || '')}</span>`;
    else if (miss) txt = `<span class="t-skip">${esc(miss)}</span>`;
    else if (rx) txt = `<span class="t-fresh">${API.static ? fmtDate(rx).slice(5) : ago(now - rx) + ' ago'}</span>${sv ? ' · ' + Object.entries(sv).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' ') : ''}`;
    else txt = '<span class="t-waiting">no data yet</span>';
    return `<tr><td>${esc(sid)}</td><td>${txt}</td></tr>`;
  });
  return `<div class="srcs"><div class="sub">Sources ${s.sc?.[0] ?? 0}/${s.sc?.[1] ?? exp.length} delivering</div><table>${rows.join('')}</table></div>`;
}

// ------------------------------------------------------------------ frame loop
const tmpV = new THREE.Vector3(), tmpC = [0, 0, 0];
let lastT = performance.now(), fpsAcc = 0, fpsN = 0, lastUi = 0, lowFps = 0;
function jsLift(x, z) {
  const L = S.L; let h = 0;
  L.holes.forEach((H, s) => { h += (S.secH[s] || 0) * Math.exp(-sq(Math.hypot(x - H.x, z - H.z) / (H.r + 2.4 * H.a)) * 1.3); });
  return h;
}
function frame(now) {
  requestAnimationFrame(frame);
  resize();
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    S.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
    // adaptive resolution: keep the frame rate up on weaker GPUs (visible page only)
    if (document.visibilityState === 'visible' && S.L) { lowFps = S.fps < 38 ? lowFps + 1 : 0; if (lowFps >= 4 && DPR > 1.0) { DPR = Math.max(1.0, DPR - 0.25); lowFps = 0; } }
  }
  const t = now / 1000; U.uTime.value = t;
  if (S.spin && !controls.autoRotate && now - lastUser > 15000 && !flyTo) controls.autoRotate = true;
  if (flyTo) {
    const k = 1 - Math.pow(0.025, dt);
    controls.target.lerp(flyTo.tgt, k); cam.position.lerp(flyTo.pos, k);
    if (cam.position.distanceTo(flyTo.pos) < 0.3) flyTo = null;
  }
  controls.update();
  if (RP.on) replayStep(dt);
  for (const g of S.galaxies) g.rotation.y += dt * 0.004;
  space.visible = S.layers.stars !== false; core.visible = S.layers.core !== false;
  manGroup.visible = S.layers.manifold !== false; cells.visible = S.layers.cells !== false;
  flows.mesh.visible = S.layers.arcs !== false; streams.mesh.visible = S.layers.streams !== false;
  // mesh crossfade
  for (const m of meshes) { const a = m.mat.uniforms.uAlpha; a.value += (m.target - a.value) * (1 - Math.pow(0.004, dt)); }
  for (const m of [...meshes]) if (m.target === 0 && m.mat.uniforms.uAlpha.value < 0.01) { manGroup.remove(m.mesh); m.mesh.geometry.dispose(); m.mat.dispose(); meshes.splice(meshes.indexOf(m), 1); }

  const n = S.ents.length;
  if (S.meta && S.L) {
    if (RP.on && now - lastUi > 250) sizes();
    if (S.flowDirty) { try { buildFlows(); } catch (err) { console.error("buildFlows", err); } }
    const k = 1 - Math.pow(0.03, dt);   // data-change easing (~0.5 s)
    const A = S.agg || marketAgg();
    // ---- sectors -> uniforms
    hovSec = hovered?.kind === 'sector' ? hovered.i : hovered?.kind === 'ent' ? S.ents[hovered.i].g : hovSecList;
    S.sectors.forEach((sec, s) => {
      if (s >= MAXS) return;
      const x = secSt(sec.id), d = secDelta(x);
      const ht = d == null ? 0 : clamp(d / clip(), -1, 1) * S.L.R * 0.16;      // lift = sector Δ (data)
      S.secH[s] = (S.secH[s] || 0) + (ht - (S.secH[s] || 0)) * k;
      const v = U.uSec.value[s];
      v.x = S.secH[s];
      v.y += (burstNorm(x.b) - v.y) * k;
      v.z += ((x.phase ? 1 : 0) - v.z) * k;
      v.w += ((hovSec === s ? 1 : 0) - v.w) * (1 - Math.pow(0.001, dt));
    });
    // ---- core
    coreColor(A.d, tmpC); coreU.uCoreCol.value.setRGB(tmpC[0], tmpC[1], tmpC[2]);
    coreU.uCoreGlow.value += (burstNorm(A.b) * 0.85 + 0.25 - coreU.uCoreGlow.value) * k;
    coreRings.forEach((r, q) => { r.rotation.y = t * (0.08 + q * 0.04) * (q % 2 ? -1 : 1); });
    const z = A.sd ? clamp((A.mu ?? 0) / A.sd, -2.6, 2.6) : 0;
    S.beadZ = (S.beadZ ?? z) + (z - (S.beadZ ?? z)) * k;
    bead.geometry.attributes.position.array[1] = AX.y0 + S.beadZ * AX.step; bead.geometry.attributes.position.needsUpdate = true;
    // ---- cells
    const P = cellGeo.attributes.position.array, C = cellGeo.attributes.aColor.array, Z = cellGeo.attributes.aSize.array,
      AP = cellGeo.attributes.aP.array, V = cellGeo.attributes.aCov.array, SD = cellGeo.attributes.aSeed.array;
    const hovI = hovered?.kind === 'ent' ? hovered.i : -1;
    const kp = 1 - Math.pow(0.02, dt);
    for (let i = 0; i < n; i++) {
      const e = S.ents[i]; if (!e.tgt) continue;
      const s = st(e), miss = !!s.m;
      for (let c = 0; c < 3; c++) e.p[c] += (e.tgt[c] - e.p[c]) * kp;
      P[3 * i] = e.p[0]; P[3 * i + 1] = e.p[1]; P[3 * i + 2] = e.p[2];
      e.sz = e.sz == null ? e.szT : e.sz + (e.szT - e.sz) * k;
      colorFor(miss ? null : deltaOf(s), tmpC);
      if (!e.col) e.col = [...tmpC]; for (let c = 0; c < 3; c++) e.col[c] += (tmpC[c] - e.col[c]) * k;
      C[3 * i] = e.col[0]; C[3 * i + 1] = e.col[1]; C[3 * i + 2] = e.col[2];
      Z[i] = miss ? 1.5 * clamp(Math.sqrt(60 / Math.max(n, 1)), 0.32, 1) : e.sz;
      e.tick = Math.max(0, e.tick - dt * 1.8);
      e.bn = (e.bn ?? 0) + ((miss ? 0 : burstNorm(s.b)) - (e.bn ?? 0)) * k;
      e.stale = !RP.on && !miss && s.ts && S.dataTs && S.dataTs - s.ts > 86400e3;
      AP[4 * i] = e.bn; AP[4 * i + 1] = e.tick; AP[4 * i + 2] = miss ? 1 : e.stale ? 0.3 : 0; AP[4 * i + 3] = i === hovI ? 1 : 0;
      V[2 * i] = s.sc?.[0] ?? 0; V[2 * i + 1] = s.sc?.[1] ?? 1; SD[i] = e.seed;
      tmpV.set(e.p[0], e.p[1] + jsLift(e.p[0], e.p[2]) + 0.35, e.p[2]);
      proj.copy(tmpV).project(cam);
      if (proj.z < 1) { spos[3 * i] = (proj.x + 1) / 2 * innerWidth; spos[3 * i + 1] = (1 - proj.y) / 2 * innerHeight; spos[3 * i + 2] = Z[i] * U.uPx.value / DPR / cam.position.distanceTo(tmpV); }
      else spos[3 * i + 2] = 0;
    }
    cellGeo.setDrawRange(0, n);
    for (const a of ['position', 'aColor', 'aSize', 'aP', 'aCov', 'aSeed']) cellGeo.attributes[a].needsUpdate = true;
    // ---- flows: hover focus (alpha only), pulse clock (speed = data)
    const fh = hovI >= 0 ? `e${hovI}` : hovSec != null ? `s${hovSec}` : '';
    if (fh !== S.flowHover) {
      S.flowHover = fh;
      for (const f of flowIdx) {
        let m = 1;
        if (hovI >= 0) m = f.i === hovI || f.j === hovI ? 1.6 : 0.18;
        else if (hovSec != null) m = (f.sector ? f.sector.includes(hovSec) : S.ents[f.i]?.g === hovSec || S.ents[f.j]?.g === hovSec) ? 1.4 : 0.3;
        flows.setAlpha(f.start, f.count, clamp(f.alpha * m, 0, 1));
      }
      flows.touchCol();
    }
    U.uFlowT.value += dt * (0.6 + 0.8 * clamp((A.b ?? 1) - 1, 0, 3));     // stream pulse speed = market burst
    S.market_core = A;
    placeLabels();
  }
  // hover
  if (hoverFollow != null && spos[3 * hoverFollow + 2] > 0) mouse = [spos[3 * hoverFollow], spos[3 * hoverFollow + 1]];
  if (mouse && S.meta && now - (S.lastPick || 0) > 50) {
    S.lastPick = now;
    hovered = pick(mouse[0], mouse[1]);
    const tip = $('tip');
    canvas.style.cursor = hovered ? 'pointer' : '';
    if (hovered) {
      const html = tipHtml(hovered);
      if (tip._h !== html) { tip.innerHTML = html; tip._h = html; }
      tip.style.display = 'block';
      const w = tip.offsetWidth, hh = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(mouse[0] + 18, innerWidth - w - 8)) + 'px'; tip.style.top = Math.max(8, Math.min(mouse[1] + 18, innerHeight - hh - 8)) + 'px';
    } else tip.style.display = 'none';
  } else if (!mouse) { hovered = null; $('tip').style.display = 'none'; }
  if (now - lastUi > 250) {
    lastUi = now;
    updateClock(); updateBigTime();
    if (RP.on) { updateVitals(); updateModel(); updateTimeline(); updateManifold(); }
    if (Math.floor(now / 1000) !== Math.floor((now - 250) / 1000)) updateSources();
    fitPanels();
    const pf = $('perf'); if (pf) pf.textContent = `${S.fps.toFixed(0)} fps · ${n} cells · ${(S.edgeI || []).length} flows · mesh ${S.meshInfo ? `${(S.meshInfo.tris / 1000).toFixed(0)}k tris / ${S.meshInfo.ms} ms` : '…'} · ${S.nObs.toLocaleString()} obs`;
  }
  composer.render();
  S.frames++;
}

let panelRects = [], panelAt = 0;
function panels() {
  const now = performance.now(); if (now - panelAt < 1000) return panelRects; panelAt = now;
  panelRects = [...document.querySelectorAll('.panel, header#top > *')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  return panelRects;
}
const hits = (x, y, w, h) => panels().some((r) => x < r.right + 6 && x + w > r.left - 6 && y < r.bottom + 4 && y + h > r.top - 4);
function fitPanels() {
  if (innerWidth <= 1060) { $('pSources').style.maxHeight = ''; $('pSectors').style.maxHeight = ''; return; }
  const br = $('pLayers').getBoundingClientRect(), tl = $('pManifold').getBoundingClientRect();
  $('pSources').style.maxHeight = Math.max(120, br.top - 92 - 12) + 'px';
  $('pSectors').style.maxHeight = Math.max(140, innerHeight - tl.bottom - 12 - 16) + 'px';
}
function scr(v) { proj.copy(v).project(cam); return proj.z < 1 ? [(proj.x + 1) / 2 * innerWidth, (1 - proj.y) / 2 * innerHeight] : null; }
function placeLabels() {
  const L = S.L, dist = cam.position.distanceTo(controls.target), lodU = dist / fitDist;
  $('lod').textContent = lodU > 0.8 ? 'MACRO · HANDLES' : lodU < 0.45 ? 'MICRO · CELLS' : 'MESO';
  const c0 = scr(tmpV.set(0, 0, 0)) || [innerWidth / 2, innerHeight / 2];
  const tmp = [0, 0, 0], show = manGroup.visible, secRects = [];
  S.sectors.forEach((sec, s) => {
    const el = secLabels[s], ld = leaders[s]; if (!el) return;
    const h = L.holes[s], x = secSt(sec.id);
    tubePoint(L, h, h.thOut, Math.PI * 0.55, tmp);
    const a = scr(tmpV.set(tmp[0], tmp[1] + jsLift(tmp[0], tmp[2]) + 0.6, tmp[2]));
    const off = a && (a[0] < 24 || a[0] > innerWidth - 24 || a[1] < 80 || a[1] > innerHeight - 24);   // anchor off-screen: no callout
    if (!a || off || !show || lodU < 0.32) { el.style.display = 'none'; ld.g.style.display = 'none'; return; }
    let dx = a[0] - c0[0], dy = a[1] - c0[1]; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const ex = a[0] + dx * 34, ey = a[1] + dy * 34 - 10, right = dx >= 0;
    const lx = ex + (right ? 22 : -22);
    ld.p.setAttribute('d', `M${a[0].toFixed(1)},${a[1].toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)} L${lx.toFixed(1)},${ey.toFixed(1)}`);
    ld.c.setAttribute('cx', a[0].toFixed(1)); ld.c.setAttribute('cy', a[1].toFixed(1));
    ld.g.style.display = ''; ld.g.style.opacity = hovSec === s ? 1 : 0.85;
    el.style.display = 'block';
    el.className = 'slab ' + (right ? 'right' : 'left');
    const d = secDelta(x), kind = deltaKind(S.ents[S.idx.get(sec.members[0])]);
    const html = `<div class="k">${esc(sec.label)}${x.phase ? '<span class="ph">LOCK</span>' : ''}</div><div class="v"><span style="color:${rgb(colorFor(d, [0, 0, 0]))}">${fmtDelta(d, kind)}</span> <span class="m">·</span> ×${x.b == null ? '—' : x.b.toFixed(1)} <span class="m">· ${x.n ?? 0}/${x.N ?? sec.members.length}</span></div>`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
    const w = el.offsetWidth, hgt = el.offsetHeight || 32;
    let left = right ? lx + 6 : lx - 6 - w, top = ey - 9;
    if (hits(left, top, w, hgt)) {                       // would sit under a panel: tuck it above the elbow instead
      left = right ? ex - w : ex; top = ey - hgt - 6;
      ld.p.setAttribute('d', `M${a[0].toFixed(1)},${a[1].toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`);
    }
    left = clamp(left, 6, innerWidth - w - 6);
    if (hits(left, top, w, hgt)) { el.style.display = 'none'; ld.g.style.display = 'none'; return; }   // still under a panel: drop it
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.opacity = lodU < 0.45 ? 0.55 : 1;
    secRects.push([left, top, w, hgt]);
  });
  // core label + σ axis
  const cl = $('corelab');
  const cp = core.visible && lodU > 0.5 ? scr(tmpV.set(0, AX.throat ?? 0, 0)) : null;   // micro zoom: cell labels take over
  if (cp && S.market_core) {
    const mc = S.market_core, kind = deltaKind(S.ents[0]);
    cl.style.display = 'block'; cl.style.left = cp[0] + 'px'; cl.style.top = (cp[1] + 14) + 'px';
    const html = `<div class="k">MARKET CORE</div><div class="m">Δ̄ = <span style="color:${rgb(coreColor(mc.d, [0, 0, 0]))};font-style:normal">${fmtDelta(mc.d, kind)}</span></div><div class="v">${RP.on ? 'volume ratio' : 'burst'} ${mc.b == null ? '—' : '×' + mc.b.toFixed(2)} · E ${fmtNum(mc.E)}</div>`;
    if (cl._h !== html) { cl.innerHTML = html; cl._h = html; }
  } else cl.style.display = 'none';
  const axOn = core.visible && lodU > 0.45;
  axisTicks.forEach((el, q) => {
    if (q < 5) {
      const p = axOn && scr(tmpV.set(0, AX.y0 + (2 - q) * AX.step, 0));
      el.style.display = p ? 'block' : 'none'; if (p) { el.style.left = p[0] + 'px'; el.style.top = p[1] + 'px'; }
    } else {
      const p = axOn && scr(tmpV.set(0, AX.top, 0));
      el.style.display = p ? 'block' : 'none'; if (p) { el.style.left = p[0] + 'px'; el.style.top = p[1] + 'px'; }
    }
  });
  // entity labels (zoomed in): biggest on-screen cells first
  const cand = [];
  if (lodU < 0.8 && cells.visible) {
    for (let i = 0; i < S.ents.length; i++) {
      const pr = spos[3 * i + 2]; if (pr < 14) continue;
      const x = spos[3 * i], y = spos[3 * i + 1];
      if (x < 40 || y < 80 || x > innerWidth - 40 || y > innerHeight - 20) continue;
      const ly = y - pr * 0.15 - 28;                                   // label box (approx.): skip if a panel or callout covers it
      if (hits(x - 50, ly, 100, 22) || secRects.some(([l, t, w, h]) => x + 50 > l && x - 50 < l + w && ly + 22 > t && ly < t + h)) continue;
      cand.push([pr, i, x, y]);
    }
    cand.sort((p, q) => q[0] - p[0]);
  }
  const placed = [];
  let q2 = 0;
  for (let q = 0; q < entLabels.length; q++) {
    const el = entLabels[q];
    let c = null;
    while (q2 < cand.length) { const cc = cand[q2++]; if (placed.every(([x, y]) => Math.abs(x - cc[2]) > 70 || Math.abs(y - cc[3]) > 16)) { c = cc; break; } }
    if (!c) { el.style.display = 'none'; continue; }
    placed.push([c[2], c[3]]);
    const [pr, i, x, y] = c, e = S.ents[i], s = st(e);
    const cov = s.sc && s.sc[1] > 1 ? `<span class="cov">${s.sc[0]}/${s.sc[1]}</span>` : '';
    const html = s.m ? `<span style="opacity:.6">${esc(e.label)}</span>${cov}` : e.stale ? `<span style="opacity:.7">${esc(e.label)}</span><small class="t-stale">stale ${ago(S.dataTs - s.ts)}</small>` : `${esc(e.label)}<small style="color:${rgb((e.col || COL.mid).map((c) => 0.35 + 0.75 * c))}">${fmtDelta(deltaOf(s), deltaKind(e))}</small>${cov}`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
    el.style.display = 'block'; el.style.left = x + 'px'; el.style.top = (y - pr * 0.15) + 'px';
    el.style.opacity = clamp((0.8 - lodU) * 4, 0, 1);
  }
}

// ------------------------------------------------------------------ test hooks (tools/screenshot.py)
window.__zoom = (k) => { const dir = new THREE.Vector3().subVectors(cam.position, controls.target).normalize(); flyTo = { tgt: controls.target.clone(), pos: controls.target.clone().addScaledVector(dir, fitDist / k) }; };
window.__dive = (id) => flyToSector(S.sidx.get(id));
window.__orbit = (azDeg, elDeg, k = 1) => {
  S.spin = false; controls.autoRotate = false;
  const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180, d = fitDist / k, ty = S.L ? -S.L.D * 0.18 : 0;
  cam.position.set(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d + ty, Math.cos(az) * Math.cos(el) * d); controls.target.set(0, ty, 0); flyTo = null; controls.update();
};
window.__replay = (speed, frac, play) => startReplay(speed, frac).then(() => { RP.playing = !!play; updateTimeline(); return RP.data ? { grain: RP.data.grain, rows: RP.data.n_rows, T: RP.T } : null; });
window.__hover = (id) => { const i = S.idx.get(id); if (i == null) return null; hoverFollow = i; return [spos[3 * i], spos[3 * i + 1]]; };
window.__noAuto = () => { S.userTouched = true; };

(async () => {
  boot.set('Loading', 0.15);
  await API.init();
  boot.set(API.static ? 'Loading recorded data' : 'Loading markets', 0.3);
  try { await loadTabs(); }
  catch (err) { boot.set('Could not reach the data server — run  python run.py', 0.3); console.error(err); }
})();
requestAnimationFrame(frame);
