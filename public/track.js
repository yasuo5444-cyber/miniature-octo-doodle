import * as THREE from 'three';
import { MAPS } from './maps.js';

export const TRACK_WIDTH = 9;       // 중앙선 → 도로 가장자리
export const WALL_OFFSET = 1.0;     // 가장자리 → 벽
export const WALL_H = 1.1;
export const EMB_BASE = 3;          // 둑(경사면) 최소 폭
export const EMB_SLOPE = 1.4;       // 고도 1m 당 둑 폭

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  return t;
}
const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const shade = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

/** 맵 id + 시드 → 모든 클라이언트에서 동일한 트랙(고도 포함) */
export class Track {
  constructor(mapId, seed) {
    this.mapId = MAPS[mapId] ? mapId : 'sunset';
    this.def = MAPS[this.mapId];
    this.seed = seed >>> 0;
    const rnd = mulberry32(this.seed);
    this.pads = [];
    if (this.mapId === 'random') {
      let ok = false;
      for (let k = 0; k < 80 && !ok; k++) ok = this._build(this._randomPoints(rnd), [], true);
      if (!ok) this._build(MAPS.sunset.pts, [], false);
      this._padsAt([0.28 + rnd() * 0.1, 0.55 + rnd() * 0.1, 0.8 + rnd() * 0.1]);
    } else {
      const s = this.def.scale || 1;
      this._build(this.def.pts.map(p => [p[0] * s, p[1] * s, p[2]]), this.def.jumps || [], false);
      this._padsAt(this.def.pads || []);
    }
    this._computeBounds();
  }

  _randomPoints(rnd) {
    const n = 9 + Math.floor(rnd() * 5), R = 150 + rnd() * 50;
    const amp = 3 + rnd() * 7, ph = rnd() * Math.PI * 2, pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + (rnd() - 0.5) * (Math.PI * 2 / n) * 0.5;
      const r = R * (0.6 + rnd() * 0.4);
      pts.push([Math.cos(ang) * r, Math.sin(ang) * r, amp * (0.5 + 0.5 * Math.sin(ang * 2 + ph))]);
    }
    if (rnd() < 0.5) pts.reverse();
    return pts;
  }

  _build(pts, jumps, validate) {
    const vec = pts.map(p => new THREE.Vector3(p[0], p[2], p[1]));
    const curve = new THREE.CatmullRomCurve3(vec, true, 'centripetal');
    const S = this.S = Math.max(600, Math.min(2400, Math.round(curve.getLength() / 1.2)));
    const sp = curve.getSpacedPoints(S);
    const px = this.px = new Float32Array(S), pz = this.pz = new Float32Array(S), py = this.py = new Float32Array(S);
    const dx = this.dx = new Float32Array(S), dz = this.dz = new Float32Array(S), rx = this.rx = new Float32Array(S), rz = this.rz = new Float32Array(S);
    for (let i = 0; i < S; i++) { px[i] = sp[i].x; py[i] = Math.max(0, sp[i].y); pz[i] = sp[i].z; }
    let total = 0;
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S, ddx = px[j] - px[i], ddz = pz[j] - pz[i], l = Math.hypot(ddx, ddz) || 1;
      total += l; dx[i] = ddx / l; dz[i] = ddz / l; rx[i] = -dz[i]; rz[i] = dx[i];   // r = 진행방향 기준 오른쪽
    }
    this.length = total; this.segLen = total / S;
    if (validate) {
      const maxTurn = this.segLen / (TRACK_WIDTH + WALL_OFFSET + 3);
      for (let i = 0; i < S; i++) { const j = (i + 1) % S; const d = Math.max(-1, Math.min(1, dx[i] * dx[j] + dz[i] * dz[j])); if (Math.acos(d) > maxTurn) return false; }
      const minGap = (TRACK_WIDTH + WALL_OFFSET) * 2 + 8, mg2 = minGap * minGap, skip = Math.floor(S * 0.07);
      for (let i = 0; i < S; i += 3) for (let k = skip; k <= S - skip; k += 3) { const j = (i + k) % S, a = px[i] - px[j], b = pz[i] - pz[j]; if (a * a + b * b < mg2) return false; }
    }
    // 점프 램프: 제어점 위치에서 끝나는 상승 램프 (끝에서 도로가 뚝 떨어짐)
    this.jumps = [];
    for (const jp of jumps) {
      const p = vec[jp.pt]; let best = 0, bd = Infinity;
      for (let i = 0; i < S; i++) { const a = px[i] - p.x, b = pz[i] - p.z, d = a * a + b * b; if (d < bd) { bd = d; best = i; } }
      const n = Math.max(3, Math.round(jp.len / this.segLen));
      for (let m = 0; m <= n; m++) { const i = ((best - n + m) % S + S) % S, f = m / n; py[i] += jp.h * (0.5 * f + 0.5 * f * f); }
      this.jumps.push({ i: best, h: jp.h, n });
    }
    this.slope = new Float32Array(S);
    for (let i = 0; i < S; i++) { const j = (i + 1) % S; this.slope[i] = Math.max(-0.4, Math.min(0.4, (py[j] - py[i]) / this.segLen)); }
    for (const jp of this.jumps) this.slope[jp.i] = this.slope[(jp.i - 1 + S) % S];   // 램프 끝은 이륙각 유지
    this.maxY = 0; for (let i = 0; i < S; i++) this.maxY = Math.max(this.maxY, py[i]);
    return true;
  }

  _padsAt(ts) {
    const lats = [-3, 3, 0, -3, 3, 0];
    ts.forEach((t, k) => { const i0 = Math.floor(t * this.S) % this.S, len = Math.max(6, Math.round(9 / this.segLen)); this.pads.push({ i0, len, lat: lats[k % lats.length], halfW: 2.6 }); });
  }
  padAt(i, lat) {
    for (const p of this.pads) { const d = ((i - p.i0) % this.S + this.S) % this.S; if (d <= p.len && Math.abs(lat - p.lat) < p.halfW) return p; }
    return null;
  }
  _computeBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.S; i++) { minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]); minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]); }
    this.bounds = { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
  }

  /** 가장 가까운 중앙선 지점 (hint 주변 우선 탐색). gy = 그 지점의 도로 높이 */
  nearest(x, z, hint = 0) {
    const S = this.S; let best = -1, bestD = Infinity;
    const search = (from, to) => { for (let k = from; k <= to; k++) { const i = ((k % S) + S) % S, a = x - this.px[i], b = z - this.pz[i], d = a * a + b * b; if (d < bestD) { bestD = d; best = i; } } };
    search(hint - 40, hint + 40);
    if (bestD > 40 * 40) { bestD = Infinity; search(0, S - 1); }
    let res = null;
    for (const i of [best, (best - 1 + S) % S]) {
      const j = (i + 1) % S, sx = this.px[j] - this.px[i], sz = this.pz[j] - this.pz[i], l2 = sx * sx + sz * sz || 1;
      let s = ((x - this.px[i]) * sx + (z - this.pz[i]) * sz) / l2; s = Math.max(0, Math.min(1, s));
      const cx = this.px[i] + sx * s, cz = this.pz[i] + sz * s, ex = x - cx, ez = z - cz, d2 = ex * ex + ez * ez;
      if (!res || d2 < res.d2) res = { i, s, d2, cx, cz, t: ((i + s) / S) % 1, lat: ex * this.rx[i] + ez * this.rz[i], gy: this.py[i] + (this.py[j] - this.py[i]) * s, slope: this.slope[i], dx: this.dx[i], dz: this.dz[i], rx: this.rx[i], rz: this.rz[i] };
    }
    res.dist = Math.sqrt(res.d2);
    return res;
  }
  /** 도로·둑·지면을 포함한 지표 높이 */
  groundY(n) {
    const W = TRACK_WIDTH + WALL_OFFSET + 0.3, a = Math.abs(n.lat);
    if (a <= W) return n.gy;
    const f = (a - W) / (n.gy * EMB_SLOPE + EMB_BASE);
    return f >= 1 ? 0 : n.gy * (1 - f);
  }
  heightAt(x, z, hint = 0) { return this.groundY(this.nearest(x, z, hint)); }
  distToTrack(x, z) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < this.S; i += 3) { const a = x - this.px[i], b = z - this.pz[i], d = a * a + b * b; if (d < best) { best = d; bi = i; } }
    return { d: Math.sqrt(best), i: bi };
  }
  /** 출발 그리드 2열×2행 (출발선 살짝 앞) */
  spawn(slot) {
    const row = Math.floor(slot / 2), col = slot % 2, i = 8 + row * 7, lat = col ? 3.2 : -3.2;
    return { x: this.px[i] + this.rx[i] * lat, y: this.py[i], z: this.pz[i] + this.rz[i] * lat, a: Math.atan2(this.dx[i], this.dz[i]), i };
  }

  // ---------- 지오메트리 ----------
  _strip(fa, fb, colorFn, i0 = 0, count = this.S, closed = true) {
    const n = count, pos = new Float32Array(n * 6), c = new Float32Array(n * 6), idx = [];
    for (let k = 0; k < n; k++) {
      const i = (i0 + k) % this.S, A = fa(i), B = fb(i), cc = colorFn(i);
      pos.set([A[0], A[1], A[2], B[0], B[1], B[2]], k * 6); c.set([cc[0], cc[1], cc[2], cc[0], cc[1], cc[2]], k * 6);
    }
    const segs = closed ? n : n - 1;
    for (let k = 0; k < segs; k++) { const a = k * 2, b = a + 1, cI = ((k + 1) % n) * 2, d = cI + 1; idx.push(a, cI, b, b, cI, d); }
    return { pos, col: c, idx };
  }
  _merge(parts) {
    let nv = 0, ni = 0; for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
    const pos = new Float32Array(nv * 3), c = new Float32Array(nv * 3), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const p of parts) { pos.set(p.pos, vo * 3); c.set(p.col, vo * 3); for (let k = 0; k < p.idx.length; k++) idx[io + k] = p.idx[k] + vo; vo += p.pos.length / 3; io += p.idx.length; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals(); return g;
  }
  _uvStrip(la, lb, dy, i0, len) {
    const n = len + 1, pos = new Float32Array(n * 6), uv = new Float32Array(n * 4), idx = [];
    for (let k = 0; k < n; k++) {
      const i = (i0 + k) % this.S;
      pos.set([this.px[i] + this.rx[i] * la, this.py[i] + dy, this.pz[i] + this.rz[i] * la, this.px[i] + this.rx[i] * lb, this.py[i] + dy, this.pz[i] + this.rz[i] * lb], k * 6);
      uv.set([0, k / len, 1, k / len], k * 4);
    }
    for (let k = 0; k < len; k++) { const a = k * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); return g;
  }

  /** 트랙 전체(도로·연석·벽·둑·패드·아치·관중석·장식) → Group. quality 0 = 저사양 */
  build(quality = 1) {
    const g = new THREE.Group(), pal = this.def.palette, S = this.S;
    const W = TRACK_WIDTH, WO = TRACK_WIDTH + WALL_OFFSET;
    const P = (i, lat, dy) => [this.px[i] + this.rx[i] * lat, this.py[i] + dy, this.pz[i] + this.rz[i] * lat];
    const road = col(pal.road), curbA = col(pal.curbA), curbB = col(pal.curbB), wall = col(pal.wall), emb = col(pal.emb);
    const rnd = mulberry32(this.seed ^ 0x9e3779b9);
    const noise = new Float32Array(S); for (let i = 0; i < S; i++) noise[i] = 0.92 + rnd() * 0.16;
    const parts = [];
    parts.push(this._strip(i => P(i, -W, 0.04), i => P(i, W, 0.04), i => shade(road, noise[i])));
    parts.push(this._strip(i => P(i, -0.2, 0.06), i => P(i, 0.2, 0.06), i => (Math.floor(i / 6) % 3 === 0 ? [0.95, 0.95, 0.95] : shade(road, noise[i]))));
    const curbCol = i => (Math.floor(i / 5) % 2 ? curbA : curbB);
    parts.push(this._strip(i => P(i, -(W + 0.9), 0.05), i => P(i, -W, 0.05), curbCol));
    parts.push(this._strip(i => P(i, W, 0.05), i => P(i, W + 0.9, 0.05), curbCol));
    for (const s of [-1, 1]) {
      parts.push(this._strip(i => P(i, s * WO, 0), i => P(i, s * WO, WALL_H), i => (Math.floor(i / 12) % 2 ? wall : shade(wall, 0.8))));
      parts.push(this._strip(i => P(i, s * (WO + 0.3), 0), i => { const p = P(i, s * (WO + 0.3 + this.py[i] * EMB_SLOPE + EMB_BASE), 0); p[1] = 0; return p; }, i => shade(emb, 0.9 + (i % 7) * 0.02)));
    }
    // 점프 램프 끝 경고 줄무늬
    for (const jp of this.jumps) parts.push(this._strip(i => P(i, -W, 0.08), i => P(i, W, 0.08), i => (i % 4 < 2 ? [1, 0.85, 0.1] : [0.1, 0.1, 0.1]), (jp.i - 6 + S) % S, 7, false));
    g.add(new THREE.Mesh(this._merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    // 지면
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(5000, 5000), new THREE.MeshLambertMaterial({ color: pal.ground }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(this.bounds.cx, -0.05, this.bounds.cz); g.add(ground);
    // 출발선
    const checker = canvasTex(16, 4, (ctx, w, h) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { ctx.fillStyle = (x + y) % 2 ? '#111' : '#eee'; ctx.fillRect(x, y, 1, 1); } });
    g.add(new THREE.Mesh(this._uvStrip(-W, W, 0.07, 0, 3), new THREE.MeshBasicMaterial({ map: checker })));
    // 부스트 패드
    if (this.pads.length) {
      const pp = this.pads.map(p => this._strip(i => P(i, p.lat - p.halfW, 0.07), i => P(i, p.lat + p.halfW, 0.07), i => ((((i - p.i0) % S + S) % S) % 4 < 2 ? [0.25, 0.95, 1] : [0.05, 0.4, 0.6]), p.i0, p.len + 1, false));
      this.padMat = new THREE.MeshBasicMaterial({ vertexColors: true });
      g.add(new THREE.Mesh(this._merge(pp), this.padMat));
    }
    // FINISH 아치
    const ai = 2, arch = new THREE.Group(), postM = new THREE.MeshLambertMaterial({ color: 0xeeeeee });
    const postG = new THREE.BoxGeometry(0.7, 7, 0.7);
    for (const s of [-1, 1]) { const m = new THREE.Mesh(postG, postM); m.position.set(s * (WO + 0.6), 3.5, 0); arch.add(m); }
    const banner = canvasTex(256, 32, (ctx, w, h) => {
      ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y += 8) if (((x + y) / 8) % 2) { ctx.fillStyle = '#eee'; ctx.fillRect(x, y, 8, 8); }
      ctx.fillStyle = '#e63232'; ctx.fillRect(56, 4, 144, 24);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('FINISH', 128, 17);
    });
    const bannerM = new THREE.MeshBasicMaterial({ map: banner });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(WO * 2 + 2, 1.4, 0.6), [postM, postM, postM, postM, bannerM, bannerM]);
    beam.position.y = 6.3; arch.add(beam);
    arch.position.set(this.px[ai], this.py[ai], this.pz[ai]); arch.rotation.y = Math.atan2(-this.rz[ai], this.rx[ai]); g.add(arch);
      // 관중석 (출발선 우측)
      const gi = 40, gs = new THREE.Group(), off = WO + 0.3 + this.py[gi] * EMB_SLOPE + EMB_BASE + 9;
      const stand = new THREE.Mesh(new THREE.BoxGeometry(44, 5, 9), new THREE.MeshLambertMaterial({ color: 0x8a8f99 })); stand.position.y = 2.5; gs.add(stand);
      const crowd = canvasTex(88, 12, (ctx, w, h) => { for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)},70%,${45 + rnd() * 30}%)`; ctx.fillRect(x, y, 1, 1); } });
      const seats = new THREE.Mesh(new THREE.BoxGeometry(44, 0.6, 9.2), new THREE.MeshBasicMaterial({ map: crowd })); seats.position.y = 5.3; gs.add(seats);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(46, 0.4, 10), new THREE.MeshLambertMaterial({ color: 0xdddddd })); roof.position.y = 9.5; gs.add(roof);
      for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), postM); m.position.set(s * 21, 7.5, -4); gs.add(m); }

      // 👇 바로 아랫줄의 뒷부분 Math.atan2 괄호 안의 값이 수정되었습니다!
      gs.position.set(this.px[gi] + this.rx[gi] * off, 0, this.pz[gi] + this.rz[gi] * off); gs.rotation.y = Math.atan2(-this.rx[gi], -this.rz[gi]); g.add(gs);

      this._decor(g, quality, rnd);
      return g;
  }

  _decor(g, quality, rnd) {
    const d = this.def.decor || {}, q = quality === 0 ? 0.45 : 1, b = this.bounds, m = 160;
    const clearance = (x, z, size) => { const { d: dist, i } = this.distToTrack(x, z); return dist - (TRACK_WIDTH + WALL_OFFSET + 0.3 + this.py[i] * EMB_SLOPE + EMB_BASE) - size; };
    const place = (count, size, minC, maxC) => {
      const out = []; let tries = 0;
      while (out.length < count && tries++ < count * 40) { const x = b.minX - m + rnd() * (b.w + 2 * m), z = b.minZ - m + rnd() * (b.h + 2 * m); const c = clearance(x, z, size); if (c >= minC && c <= maxC) out.push([x, z]); }
      return out;
    };
    const inst = (geo, list, fn) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ flatShading: true }), list.length);
      const o = new THREE.Object3D(), cc = new THREE.Color();
      list.forEach((p, k) => { o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1); fn(o, cc, p, k); o.updateMatrix(); im.setMatrixAt(k, o.matrix); im.setColorAt(k, cc); });
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      g.add(im);
    };
    if (d.tree) {
      const list = place(Math.round(d.tree * q), 2, 2, 140), sc = list.map(() => 0.8 + rnd() * 0.6);
      inst(new THREE.CylinderGeometry(0.25, 0.4, 2.4, 5), list, (o, c, p) => { o.position.set(p[0], 1.2, p[1]); c.setHex(0x6b4a2b); });
      inst(new THREE.DodecahedronGeometry(2.2, 0), list, (o, c, p, k) => { const s = sc[k]; o.position.set(p[0], 2.2 + 2.2 * s, p[1]); o.scale.set(s, s * 1.15, s); o.rotation.y = rnd() * 3; c.setHSL(0.28 + rnd() * 0.08, 0.5, 0.3 + rnd() * 0.15); });
    }
    if (d.pine) inst(new THREE.ConeGeometry(2, 7, 6), place(Math.round(d.pine * q), 2, 1, 170), (o, c, p) => { const s = 0.7 + rnd() * 0.8; o.position.set(p[0], 3.5 * s, p[1]); o.scale.set(s, s, s); o.rotation.y = rnd() * 3; c.setHSL(0.33 + rnd() * 0.05, 0.45, 0.2 + rnd() * 0.12); });
    if (d.building) inst(new THREE.BoxGeometry(1, 1, 1), place(Math.round(d.building * q), 8, 6, 110), (o, c, p) => { const w = 8 + rnd() * 10, h = 8 + rnd() * 26, dd = 8 + rnd() * 10; o.position.set(p[0], h / 2, p[1]); o.scale.set(w, h, dd); o.rotation.y = Math.floor(rnd() * 4) * Math.PI / 2 + (rnd() - 0.5) * 0.4; c.setHSL(0.55 + rnd() * 0.1, 0.15 + rnd() * 0.2, 0.45 + rnd() * 0.3); });
    if (d.container) inst(new THREE.BoxGeometry(6.1, 2.6, 2.45), place(Math.round(d.container * q), 4, 3, 90), (o, c, p) => { o.position.set(p[0], 1.3 + (rnd() < 0.3 ? 2.6 : 0), p[1]); o.rotation.y = Math.floor(rnd() * 2) * Math.PI / 2 + (rnd() - 0.5) * 0.2; c.setHSL(rnd(), 0.65, 0.45); });
    if (d.crane) {
      const list = place(d.crane, 6, 20, 130);
      inst(new THREE.BoxGeometry(2, 30, 2), list, (o, c, p) => { o.position.set(p[0], 15, p[1]); c.setHex(0xd9534f); });
      inst(new THREE.BoxGeometry(28, 1.5, 1.5), list, (o, c, p) => { o.position.set(p[0] + 8, 30, p[1]); c.setHex(0xd9534f); });
    }
    if (d.rock) inst(new THREE.DodecahedronGeometry(1.6, 0), place(Math.round(d.rock * q), 2, 1, 160), (o, c, p) => { const s = 0.6 + rnd() * 1.8; o.position.set(p[0], s * 0.8, p[1]); o.scale.set(s, s * 0.7, s); o.rotation.set(rnd(), rnd() * 3, rnd()); c.setHSL(0.08, 0.15 + rnd() * 0.1, 0.35 + rnd() * 0.2); });
    if (d.mesa) inst(new THREE.CylinderGeometry(0.7, 1, 1, 7), place(Math.round(d.mesa * q), 14, 12, 170), (o, c, p) => { const s = 12 + rnd() * 16, h = 10 + rnd() * 20; o.position.set(p[0], h / 2, p[1]); o.scale.set(s, h, s); o.rotation.y = rnd() * 3; c.setHSL(0.06 + rnd() * 0.03, 0.5, 0.35 + rnd() * 0.15); });
    if (d.cactus) inst(new THREE.CylinderGeometry(0.5, 0.6, 4, 6), place(Math.round(d.cactus * q), 1, 1, 100), (o, c, p) => { const s = 0.6 + rnd() * 0.8; o.position.set(p[0], 2 * s, p[1]); o.scale.set(s, s, s); c.setHSL(0.3, 0.45, 0.32); });
  }

  /** 2D 미니맵/미리보기 (고도에 따라 색 변화). 반환: 좌표 변환 함수 */
  drawMap(ctx, w, h, pad = 10) {
    const b = this.bounds, sc = Math.min((w - 2 * pad) / b.w, (h - 2 * pad) / b.h);
    const tx = (x) => (x - b.cx) * sc + w / 2, tz = (z) => (z - b.cz) * sc + h / 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < this.S; i += 2) {
      const j = (i + 2) % this.S;
      ctx.beginPath(); ctx.moveTo(tx(this.px[i]), tz(this.pz[i])); ctx.lineTo(tx(this.px[j]), tz(this.pz[j]));
      if (pass === 0) { ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 7; }
      else { const k = this.maxY > 0 ? this.py[i] / this.maxY : 0; ctx.strokeStyle = `hsl(${200 - k * 170},85%,${58 + k * 25}%)`; ctx.lineWidth = 4; }
      ctx.stroke();
    }
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(tx(this.px[0] + this.rx[0] * 12), tz(this.pz[0] + this.rz[0] * 12)); ctx.lineTo(tx(this.px[0] - this.rx[0] * 12), tz(this.pz[0] - this.rz[0] * 12)); ctx.stroke();
    for (const jp of this.jumps) { ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(tx(this.px[jp.i]), tz(this.pz[jp.i]), 4, 0, Math.PI * 2); ctx.fill(); }
    return { tx, tz };
  }
}
