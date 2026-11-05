// Builds the manifold mesh off the render thread.
import { buildMesh } from './field.js';

onmessage = (e) => {
  const { id, L, res } = e.data;
  const t0 = performance.now();
  const m = buildMesh(L, res);
  postMessage({ id, pos: m.pos, nrm: m.nrm, idx: m.idx, nv: m.nv, nt: m.nt, ms: performance.now() - t0 }, [m.pos.buffer, m.nrm.buffer, m.idx.buffer]);
};
