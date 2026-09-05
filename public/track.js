import * as THREE from 'three';

export const CHECKPOINTS = 12;      // server.js 와 동일해야 함
export const TRACK_WIDTH = 9;       // 중앙선 → 도로 가장자리
export const WALL_OFFSET = 1.0;     // 가장자리 → 벽
export const SAMPLES = 720;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(w, h, draw, nearest = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; }
  return t;
}

/** 시드 기반 절차적 서킷. 같은 시드 → 모든 클라이언트에서 같은 트랙 */
export class Track {
  constructor(seed) {
    this.seed = seed;
    const rnd = mulberry32(seed);
    for (let attempt = 0; attempt < 40; attempt++) if (this._generate(rnd)) break;
    this._placePads(rnd);
    this._computeBounds();
  }

  _generate(rnd) {
    const n = 8 + Math.floor(rnd() * 5);            // 제어점 8~12개
    const R = 140 + rnd() * 40;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + (rnd() - 0.5) * (Math.PI * 2 / n) * 0.5;
      const r = R * (0.62 + rnd() * 0.38);
      pts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
    }
    if (rnd() < 0.5) pts.reverse();                  // 시계/반시계 무작위
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const spaced = curve.getSpacedPoints(SAMPLES);
    const S = SAMPLES;
    this.px = new Float32Array(S); this.pz = new Float32Array(S);
    this.dx = new Float32Array(S); this.dz = new Float32Array(S);
    this.rx = new Float32Array(S); this.rz = new Float32Array(S);
    for (let i = 0; i < S; i++) { this.px[i] = spaced[i].x; this.pz[i] = spaced[i].z; }
    let total = 0;
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const ddx = this.px[j] - this.px[i], ddz = this.pz[j] - this.pz[i];
      const l = Math.hypot(ddx, ddz) || 1; total += l;
      this.dx[i] = ddx / l; this.dz[i] = ddz / l;
      this.rx[i] = -this.dz[i]; this.rz[i] = this.dx[i];   // 진행방향 기준 오른쪽
    }
    this.length = total; this.segLen = total / S;
    // 검증 1: 너무 급한 코너 (안쪽 벽 반경 확보)
    const maxTurn = this.segLen / (TRACK_WIDTH + WALL_OFFSET + 2.5);
    for (let i = 0; i < S; i++) {
      const j = (i + 1) % S;
      const dot = Math.max(-1, Math.min(1, this.dx[i] * this.dx[j] + this.dz[i] * this.dz[j]));
      if (Math.acos(dot) > maxTurn) return false;
    }
    // 검증 2: 자기 교차 / 근접
    const minGap = (TRACK_WIDTH + WALL_OFFSET) * 2 + 6, mg2 = minGap * minGap;
    const skip = Math.floor(S * 0.07);
    for (let i = 0; i < S; i += 2) {
      for (let k = skip; k <= S - skip; k += 2) {
        const j = (i + k) % S;
        const ddx = this.px[i] - this.px[j], ddz = this.pz[i] - this.pz[j];
        if (ddx * ddx + ddz * ddz < mg2) return false;
      }
    }
    return true;
  }

  _placePads(rnd) {
    this.pads = [];
    const count = 3;
    for (let k = 0; k < count; k++) {
      const t = 0.12 + ((k + 0.15 + rnd() * 0.7) / count) * 0.82;
      const i0 = Math.floor(t * SAMPLES);
      const lat = [-4.5, 0, 4.5][Math.floor(rnd() * 3)];
      this.pads.push({ i0, i1: Math.min(SAMPLES - 2, i0 + 8), lat, halfW: 2.0 });
    }
  }

  _computeBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, h: maxZ - minZ };
  }

  padAt(i, lat) {
    for (const p of this.pads) if (i >= p.i0 && i <= p.i1 && Math.abs(lat - p.lat) < p.halfW) return p;
    return null;
  }

  /** 가장 가까운 중앙선 지점. hint 주변만 탐색 (성능) */
  nearest(x, z, hint = 0) {
    const S = SAMPLES; let best = -1, bestD = Infinity;
    const search = (from, to) => {
      for (let k = from; k <= to; k++) {
        const i = ((k % S) + S) % S;
        const dx = x - this.px[i], dz = z - this.pz[i]; const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    };
    search(hint - 40, hint + 40);
    if (bestD > 45 * 45) { bestD = Infinity; search(0, S - 1); }
    // 인접 두 세그먼트에 투영해 더 가까운 쪽 채택
    let res = null;
    for (const i of [best, (best - 1 + S) % S]) {
      const j = (i + 1) % S;
      const sx = this.px[j] - this.px[i], sz = this.pz[j] - this.pz[i]; const l2 = sx * sx + sz * sz || 1;
      let s = ((x - this.px[i]) * sx + (z - this.pz[i]) * sz) / l2; s = Math.max(0, Math.min(1, s));
      const cx = this.px[i] + sx * s, cz = this.pz[i] + sz * s;
      const ex = x - cx, ez = z - cz; const d2 = ex * ex + ez * ez;
      if (!res || d2 < res.d2) {
        res = { i, d2, cx, cz, t: ((i + s) / S) % 1, lat: ex * this.rx[i] + ez * this.rz[i],
          dx: this.dx[i], dz: this.dz[i], rx: this.rx[i], rz: this.rz[i] };
      }
    }
    res.dist = Math.sqrt(res.d2);
    return res;
  }

  distToTrack(x, z) {
    let best = Infinity;
    for (let i = 0; i < SAMPLES; i += 3) { const dx = x - this.px[i], dz = z - this.pz[i]; const d = dx * dx + dz * dz; if (d < best) best = d; }
    return Math.sqrt(best);
  }

  /** 출발 그리드 (2열 × 2행, 출발선 바로 뒤가 아니라 살짝 앞: 첫 랩 카운트 안정) */
  spawn(slot) {
    const row = Math.floor(slot / 2), col = slot % 2;
    const i = 6 + row * 6;
    const lat = col ? 3.2 : -3.2;
    return { x: this.px[i] + this.rx[i] * lat, z: this.pz[i] + this.rz[i] * lat, a: Math.atan2(this.dx[i], this.dz[i]), i };
  }

  // ---------- 지오메트리 ----------
  _ribbon(offA, offB, y, colorFn = null) {
    const S = SAMPLES;
    const pos = new Float32Array(S * 6), nor = new Float32Array(S * 6);
    const col = colorFn ? new Float32Array(S * 6) : null;
    for (let i = 0; i < S; i++) {
      const x = this.px[i], z = this.pz[i], rx = this.rx[i], rz = this.rz[i];
      pos.set([x + rx * offA, y, z + rz * offA, x + rx * offB, y, z + rz * offB], i * 6);
      nor.set([0, 1, 0, 0, 1, 0], i * 6);
      if (col) { const c = colorFn(i); col.set([c[0], c[1], c[2], c[0], c[1], c[2]], i * 6); }
    }
    const idx = new Uint16Array(S * 6);
    for (let i = 0; i < S; i++) { const a = i * 2, b = a + 1, c = ((i + 1) % S) * 2, d = c + 1; idx.set([a, c, b, b, c, d], i * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  _ribbonUV(offA, offB, y, i0, len) {
    const count = len + 1;
    const pos = new Float32Array(count * 6), nor = new Float32Array(count * 6), uv = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) {
      const i = (i0 + k) % SAMPLES;
      const x = this.px[i], z = this.pz[i], rx = this.rx[i], rz = this.rz[i];
      pos.set([x + rx * offA, y, z + rz * offA, x + rx * offB, y, z + rz * offB], k * 6);
      nor.set([0, 1, 0, 0, 1, 0], k * 6);
      uv.set([0, k / len, 1, k / len], k * 4);
    }
    const idx = new Uint16Array(len * 6);
    for (let k = 0; k < len; k++) { const a = k * 2, b = a + 1, c = a + 2, d = a + 3; idx.set([a, c, b, b, c, d], k * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  _wall(off, y0, y1) {
    const S = SAMPLES;
    const pos = new Float32Array(S * 6), nor = new Float32Array(S * 6);
    const s = off > 0 ? -1 : 1;
    for (let i = 0; i < S; i++) {
      const x = this.px[i] + this.rx[i] * off, z = this.pz[i] + this.rz[i] * off;
      pos.set([x, y0, z, x, y1, z], i * 6);
      const nx = this.rx[i] * s, nz = this.rz[i] * s; nor.set([nx, 0, nz, nx, 0, nz], i * 6);
    }
    const idx = new Uint16Array(S * 6);
    for (let i = 0; i < S; i++) { const a = i * 2, b = a + 1, c = ((i + 1) % S) * 2, d = c + 1; idx.set([a, c, b, b, c, d], i * 6); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  }

  /** 트랙 + 장식 전체를 Group 으로 생성 (그림자 없음, 드로우콜 최소화) */
  buildMeshes({ low = false } = {}) {
    const grp = new THREE.Group();
    const W = TRACK_WIDTH, WO = WALL_OFFSET, b = this.bounds;
    const lam = (c, extra = {}) => new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide, ...extra });

    // 지면
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), new THREE.MeshLambertMaterial({ color: 0x5f9c48 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(b.cx, -0.05, b.cz); grp.add(ground);

    // 도로 / 차선 / 연석 / 벽
    grp.add(new THREE.Mesh(this._ribbon(-W, W, 0.0), lam(0x3d3d45)));
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6, side: THREE.DoubleSide });
    grp.add(new THREE.Mesh(this._ribbon(-W + 0.15, -W + 0.45, 0.05), lineMat));
    grp.add(new THREE.Mesh(this._ribbon(W - 0.45, W - 0.15, 0.05), lineMat));
    const curbColor = (i) => (Math.floor(i / 6) % 2 ? [0.93, 0.93, 0.93] : [0.85, 0.12, 0.12]);
    const curbMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    grp.add(new THREE.Mesh(this._ribbon(-W - 0.9, -W, 0.03, curbColor), curbMat));
    grp.add(new THREE.Mesh(this._ribbon(W, W + 0.9, 0.03, curbColor), curbMat));
    const wallMat = lam(0xdde1e8);
    grp.add(new THREE.Mesh(this._wall(-(W + WO), 0, 1.0), wallMat));
    grp.add(new THREE.Mesh(this._wall(W + WO, 0, 1.0), wallMat));

    // 출발/결승선 (체커)
    const checker = canvasTex(64, 16, (g) => {
      for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4'; g.fillRect(i * 8, j * 8, 8, 8); }
    });
    grp.add(new THREE.Mesh(this._ribbonUV(-W, W, 0.08, 0, 3), new THREE.MeshBasicMaterial({ map: checker, side: THREE.DoubleSide })));

    // 부스트 패드 (쉐브론)
    const padTex = canvasTex(64, 128, (g, w, h) => {
      g.fillStyle = '#ff8a1a'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round';
      for (let k = 0; k < 3; k++) { const y = 18 + k * 36; g.beginPath(); g.moveTo(10, y + 16); g.lineTo(32, y); g.lineTo(54, y + 16); g.stroke(); }
    }, false);
    const padMat = new THREE.MeshBasicMaterial({ map: padTex, side: THREE.DoubleSide });
    for (const pad of this.pads) grp.add(new THREE.Mesh(this._ribbonUV(pad.lat - pad.halfW, pad.lat + pad.halfW, 0.1, pad.i0, pad.i1 - pad.i0), padMat));

    // 피니시 아치
    const yaw = Math.atan2(this.dx[0], this.dz[0]);
    const arch = new THREE.Group(); arch.position.set(this.px[0], 0, this.pz[0]); arch.rotation.y = yaw;
    const half = W + WO + 0.9; const postMat = lam(0xf2f2f2);
    for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 7, 0.7), postMat); post.position.set(s * half, 3.5, 0); arch.add(post); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 0.7, 1.6, 0.9), lam(0x1d1f26)); beam.position.set(0, 6.8, 0); arch.add(beam);
    const signTex = canvasTex(512, 96, (g, w, h) => {
      g.fillStyle = '#1d1f26'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#fff' : '#111'; g.fillRect(i * 32, 0, 32, 12); g.fillRect(i * 32, h - 12, 32, 12); }
      g.fillStyle = '#fff'; g.font = 'bold 56px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('FINISH', w / 2, h / 2 + 2);
    }, false);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.5), new THREE.MeshBasicMaterial({ map: signTex }));
    sign.position.set(0, 6.8, -0.5); sign.rotation.y = Math.PI; arch.add(sign);
    grp.add(arch);

    // ---------- 장식 (별도 시드: 화질 옵션에 따라 개수만 다름, 게임플레이 무관) ----------
    const rnd2 = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const span = Math.max(b.w, b.h) / 2 + 80;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();

    // 나무
    const treeN = low ? 60 : 160; const trees = []; let tries = 0;
    while (trees.length < treeN && tries++ < treeN * 30) {
      const x = b.cx + (rnd2() * 2 - 1) * span, z = b.cz + (rnd2() * 2 - 1) * span;
      const d = this.distToTrack(x, z);
      if (d > W + WO + 4 && d < 110) trees.push([x, z, 0.8 + rnd2() * 0.6]);
    }
    if (trees.length) {
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 1.8, 5), new THREE.MeshLambertMaterial({ color: 0x6b4a2b }), trees.length);
      const canopy = new THREE.InstancedMesh(new THREE.ConeGeometry(1.8, 3.6, 6), new THREE.MeshLambertMaterial({ color: 0xffffff }), trees.length);
      trees.forEach(([x, z, s], k) => {
        q.identity(); sc.set(s, s, s);
        m.compose(v.set(x, 0.9 * s, z), q, sc); trunk.setMatrixAt(k, m);
        m.compose(v.set(x, 3.6 * s, z), q, sc); canopy.setMatrixAt(k, m);
        col.setHSL(0.27 + rnd2() * 0.09, 0.5, 0.28 + rnd2() * 0.15); canopy.setColorAt(k, col);
      });
      trunk.instanceMatrix.needsUpdate = true; canopy.instanceMatrix.needsUpdate = true; canopy.instanceColor.needsUpdate = true;
      grp.add(trunk, canopy);
    }

    // 건물
    const bN = low ? 6 : 16; const blds = []; tries = 0;
    while (blds.length < bN && tries++ < bN * 40) {
      const x = b.cx + (rnd2() * 2 - 1) * span, z = b.cz + (rnd2() * 2 - 1) * span;
      const d = this.distToTrack(x, z);
      if (d > W + WO + 13 && d < 95) blds.push([x, z, 6 + rnd2() * 8, 5 + rnd2() * 14, 6 + rnd2() * 8, rnd2() * Math.PI]);
    }
    if (blds.length) {
      const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), blds.length);
      const up = new THREE.Vector3(0, 1, 0);
      blds.forEach(([x, z, sx, sy, sz, rot], k) => {
        q.setFromAxisAngle(up, rot); m.compose(v.set(x, sy / 2, z), q, sc.set(sx, sy, sz)); bm.setMatrixAt(k, m);
        col.setHSL(rnd2(), 0.25, 0.55 + rnd2() * 0.2); bm.setColorAt(k, col);
      });
      bm.instanceMatrix.needsUpdate = true; bm.instanceColor.needsUpdate = true;
      grp.add(bm);
    }

    // 관중석 (출발선 왼쪽, 트랙과 겹치지 않을 때만)
    {
      const px = this.px[0], pz = this.pz[0], dx = this.dx[0], dz = this.dz[0], rx = this.rx[0], rz = this.rz[0];
      const baseOff = -(W + WO + 4.5); const len = 34;
      const cxs = px + rx * (baseOff - 3), czs = pz + rz * (baseOff - 3);
      const ok = [-1, 1].every(s => this.distToTrack(cxs + dx * len / 2 * s, czs + dz * len / 2 * s) > W + WO + 3);
      if (ok) {
        const stand = new THREE.Group(); stand.position.set(px, 0, pz); stand.rotation.y = yaw;
        const tierMat = lam(0x8d95a5);
        for (let k = 0; k < 3; k++) {
          const h = 1.0 + k * 1.0;
          const tier = new THREE.Mesh(new THREE.BoxGeometry(2.4, h, len), tierMat);
          tier.position.set(-(baseOff) * -1 - k * 2.4, h / 2, 0);   // 로컬 +x = 왼쪽
          stand.add(tier);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(8.5, 0.3, len + 2), lam(0xff7a1a));
        roof.position.set(-(baseOff) * -1 - 2.4, 5.6, 0); stand.add(roof);
        for (const s of [-1, 1]) { const pole = new THREE.Mesh(new THREE.BoxGeometry(0.3, 5.6, 0.3), tierMat); pole.position.set(-(baseOff) * -1 - 5.5, 2.8, s * (len / 2)); stand.add(pole); }
        if (!low) {
          const crowdN = 72;
          const crowd = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.9, 0.6), new THREE.MeshLambertMaterial({ color: 0xffffff }), crowdN);
          for (let k = 0; k < crowdN; k++) {
            const tier = k % 3; const h = 1.0 + tier * 1.0;
            q.identity(); m.compose(v.set(-(baseOff) * -1 - tier * 2.4, h + 0.45, (rnd2() - 0.5) * (len - 2)), q, sc.set(1, 1, 1));
            crowd.setMatrixAt(k, m); col.setHSL(rnd2(), 0.7, 0.55); crowd.setColorAt(k, col);
          }
          crowd.instanceMatrix.needsUpdate = true; crowd.instanceColor.needsUpdate = true;
          stand.add(crowd);
        }
        grp.add(stand);
      }
    }
    return grp;
  }

  /** 미니맵 / 로비 미리보기 */
  drawMap(ctx, w, h, cars = [], localId = null) {
    ctx.clearRect(0, 0, w, h);
    const b = this.bounds; const scale = (Math.min(w, h) * 0.82) / Math.max(b.w, b.h);
    const X = (x) => w / 2 + (x - b.cx) * scale, Z = (z) => h / 2 + (z - b.cz) * scale;
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i += 3) { const x = X(this.px[i]), y = Z(this.pz[i]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.closePath();
    ctx.lineJoin = 'round'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.stroke();
    ctx.lineWidth = 5; ctx.strokeStyle = '#cfd3dc'; ctx.stroke();
    for (const pad of this.pads) { ctx.fillStyle = '#ff9a1f'; ctx.beginPath(); ctx.arc(X(this.px[pad.i0]), Z(this.pz[pad.i0]), 3, 0, Math.PI * 2); ctx.fill(); }
    const rx = this.rx[0] * TRACK_WIDTH, rz = this.rz[0] * TRACK_WIDTH;
    ctx.beginPath(); ctx.moveTo(X(this.px[0] - rx), Z(this.pz[0] - rz)); ctx.lineTo(X(this.px[0] + rx), Z(this.pz[0] + rz));
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    for (const c of cars) {
      const me = c.id === localId;
      ctx.beginPath(); ctx.arc(X(c.x), Z(c.z), me ? 5.5 : 4.5, 0, Math.PI * 2); ctx.fillStyle = c.color; ctx.fill();
      if (me) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); }
    }
  }
}
