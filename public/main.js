import * as THREE from 'three';
import { Track, CHECKPOINTS } from './track.js';
import { CarPhysics, MAX_SPEED } from './car.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (ms) => {
  if (ms == null) return '--:--.---';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};
const ordinal = (n) => (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
const lerp = (a, b, u) => a + (b - a) * u;
const lerpAngle = (a, b, u) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * u; };

const G = {
  myId: null, room: null, players: new Map(), phase: 'lobby',   // lobby | countdown | racing | finished
  track: null, trackGroup: null, local: null,
  lapStartLocal: 0, lastCpSend: 0, camMode: 0, quality: 'normal', finishPlace: null, ping: 0,
};

/* ================= 오디오 (Web Audio 합성, 에셋 없음) ================= */
class AudioSys {
  constructor() { this.ctx = null; this.muted = false; }
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const C = (this.ctx = new AC());
    this.master = C.createGain(); this.master.gain.value = this.muted ? 0 : 0.45; this.master.connect(C.destination);
    const lp = C.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100;
    this.eng = C.createOscillator(); this.eng.type = 'sawtooth';
    this.eng2 = C.createOscillator(); this.eng2.type = 'square';
    const g2 = C.createGain(); g2.gain.value = 0.35;
    this.engGain = C.createGain(); this.engGain.gain.value = 0;
    this.eng.connect(lp); this.eng2.connect(g2); g2.connect(lp); lp.connect(this.engGain); this.engGain.connect(this.master);
    this.eng.start(); this.eng2.start();
    const buf = C.createBuffer(1, C.sampleRate, C.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = C.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
    const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.6;
    this.noiseGain = C.createGain(); this.noiseGain.gain.value = 0;
    this.noise.connect(bp); bp.connect(this.noiseGain); this.noiseGain.connect(this.master); this.noise.start();
  }
  update(L, input) {
    if (!this.ctx) return; const t = this.ctx.currentTime;
    const sp = Math.abs(L.speed) / MAX_SPEED;
    const rpm = 0.12 + Math.min(1.3, sp) * 0.9 + (input.throttle > 0 ? 0.06 : 0);
    const f = 48 + rpm * 190;
    this.eng.frequency.setTargetAtTime(f, t, 0.06); this.eng2.frequency.setTargetAtTime(f * 2.01, t, 0.06);
    this.engGain.gain.setTargetAtTime(0.1 + (input.throttle > 0 ? 0.07 : 0) + (L.nitroOn ? 0.05 : 0), t, 0.08);
    const skid = L.drifting && Math.abs(L.lat) > 3 ? 0.22 : 0; const grass = L.onGrass && sp > 0.15 ? 0.12 : 0;
    this.noiseGain.gain.setTargetAtTime(skid + grass + sp * 0.05, t, 0.08);
  }
  beep(freq, dur, type = 'square', vol = 0.25) {
    if (!this.ctx) return; const C = this.ctx, o = C.createOscillator(), g = C.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, C.currentTime); g.gain.exponentialRampToValueAtTime(0.001, C.currentTime + dur);
    o.connect(g); g.connect(this.master); o.start(); o.stop(C.currentTime + dur);
  }
  hit(strength) { this.beep(70 + Math.random() * 30, 0.15, 'sawtooth', Math.min(0.5, 0.1 + strength / 40)); }
  boost() {
    if (!this.ctx) return; const C = this.ctx, o = C.createOscillator(), g = C.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(300, C.currentTime); o.frequency.exponentialRampToValueAtTime(1200, C.currentTime + 0.35);
    g.gain.setValueAtTime(0.2, C.currentTime); g.gain.exponentialRampToValueAtTime(0.001, C.currentTime + 0.4);
    o.connect(g); g.connect(this.master); o.start(); o.stop(C.currentTime + 0.4);
  }
  fanfare() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.25, 'triangle', 0.3), i * 140)); }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.45; }
}
const audio = new AudioSys();

/* ================= 네트워크 ================= */
const net = {
  ws: null, handlers: {},
  connect() {
    return new Promise((res, rej) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('서버에 연결할 수 없습니다.'));
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } const h = this.handlers[m.type]; if (h) h(m); };
      ws.onclose = () => showError('서버와 연결이 끊어졌습니다. 페이지를 새로고침해 주세요.');
      this.ws = ws;
    });
  },
  send(type, data = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type, ...data })); },
  on(type, fn) { this.handlers[type] = fn; },
};

/* ================= Three.js (경량 설정) ================= */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1));
const scene = new THREE.Scene();
const SKY = 0x8ec1ee;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 180, 480);
const camera = new THREE.PerspectiveCamera(68, 1, 0.5, 700);
scene.add(new THREE.HemisphereLight(0xdff0ff, 0x4c7a3a, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.75); sun.position.set(120, 180, 60); scene.add(sun);
const camPos = new THREE.Vector3(0, 60, 120);
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
function applyQuality(q) {
  G.quality = q;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q === 'low' ? 0.7 : 1));
  scene.fog.near = q === 'low' ? 120 : 180; scene.fog.far = q === 'low' ? 320 : 480;
  camera.far = q === 'low' ? 500 : 700; camera.updateProjectionMatrix();
}

/* ================= 차량 모델 (박스 조합, 머티리얼 최소) ================= */
function buildCarMesh(colorHex) {
  const g = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  const chassis = new THREE.Group(); g.add(chassis);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 3.4), mat(colorHex)); body.position.y = 0.55; chassis.add(body);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.2, 1.1), mat(colorHex)); hood.position.set(0, 0.9, 0.95); chassis.add(hood);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.5), mat(0x1c1f26)); cabin.position.set(0, 1.05, -0.25); chassis.add(cabin);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.1, 0.5), mat(0x202228)); spoiler.position.set(0, 1.2, -1.6); chassis.add(spoiler);
  for (const s of [-0.7, 0.7]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.3), mat(0x202228)); post.position.set(s, 0.98, -1.6); chassis.add(post); }
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6c0 }), tailMat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
  for (const s of [-0.55, 0.55]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.08), lightMat); hl.position.set(s, 0.62, 1.72); chassis.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.16, 0.08), tailMat); tl.position.set(s, 0.62, -1.72); chassis.add(tl);
  }
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.35, 10); wheelGeo.rotateZ(Math.PI / 2);
  const wheelMat = mat(0x151515); const wheels = [];
  const front = new THREE.Group(); g.add(front);
  for (const [x, z] of [[-0.9, 1.1], [0.9, 1.1], [-0.9, -1.1], [0.9, -1.1]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat); w.position.set(x, 0.36, z); wheels.push(w);
    if (z > 0) { const pivot = new THREE.Group(); pivot.position.set(x, 0.36, z); w.position.set(0, 0, 0); pivot.add(w); front.add(pivot); }
    else g.add(w);
  }
  const flameGeo = new THREE.ConeGeometry(0.16, 0.8, 6); flameGeo.rotateX(-Math.PI / 2);
  const flameMat = new THREE.MeshBasicMaterial({ color: 0x66ccff }); const flames = [];
  for (const s of [-0.45, 0.45]) { const f = new THREE.Mesh(flameGeo, flameMat); f.position.set(s, 0.45, -2.05); f.visible = false; g.add(f); flames.push(f); }
  g.userData = { chassis, front, wheels, flames, spin: 0 };
  return g;
}
function makeNameSprite(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,0,0,0.45)';
  if (g.roundRect) { g.beginPath(); g.roundRect(8, 8, 240, 48, 12); g.fill(); } else g.fillRect(8, 8, 240, 48);
  g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = color; g.fillText(name, 128, 33);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(4, 1, 1); s.position.y = 2.4; return s;
}

/* ================= 드리프트 연기 / 잔디 먼지 (Points 풀) ================= */
const smoke = (() => {
  const N = 90; const pos = new Float32Array(N * 3); const life = new Float32Array(N); let idx = 0;
  for (let i = 0; i < N; i++) pos[i * 3 + 1] = -50;
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xe0e0e0, size: 1.6, transparent: true, opacity: 0.4, depthWrite: false });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; scene.add(points);
  const acc = new Map();
  return {
    spawn(key, x, z, a, dt) {
      const t = (acc.get(key) || 0) + dt; if (t < 0.035) { acc.set(key, t); return; } acc.set(key, 0);
      const fx = Math.sin(a), fz = Math.cos(a), rx = -fz, rz = fx;
      for (const s of [-0.9, 0.9]) {
        const i = idx++ % N;
        pos[i * 3] = x - fx * 1.3 + rx * s + (Math.random() - 0.5) * 0.4; pos[i * 3 + 1] = 0.3;
        pos[i * 3 + 2] = z - fz * 1.3 + rz * s + (Math.random() - 0.5) * 0.4; life[i] = 0.7;
      }
    },
    update(dt) {
      for (let i = 0; i < N; i++) if (life[i] > 0) { life[i] -= dt; pos[i * 3 + 1] += dt * 1.2; if (life[i] <= 0) pos[i * 3 + 1] = -50; }
      geo.attributes.position.needsUpdate = true;
    },
  };
})();

/* ================= 트랙 ================= */
const trackCache = new Map();
function getTrack(seed) { if (!trackCache.has(seed)) trackCache.set(seed, new Track(seed)); return trackCache.get(seed); }
function ensureTrack(seed) {
  if (G.track && G.track.seed === seed && G.trackGroup) return;
  if (G.trackGroup) { scene.remove(G.trackGroup); G.trackGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
  G.track = getTrack(seed);
  G.trackGroup = G.track.buildMeshes({ low: G.quality === 'low' });
  scene.add(G.trackGroup);
}

/* ================= 플레이어 ================= */
function syncPlayers(room) {
  const seen = new Set();
  for (const rp of room.players) {
    seen.add(rp.id);
    let p = G.players.get(rp.id);
    if (!p) { p = { id: rp.id, mesh: null, remote: null }; G.players.set(rp.id, p); }
    Object.assign(p, { name: rp.name, color: rp.color, slot: rp.slot, ready: rp.ready, lap: rp.lap, cp: rp.cp,
      finished: rp.finished, finishTime: rp.finishTime, bestLap: rp.bestLap });
  }
  for (const id of [...G.players.keys()]) if (!seen.has(id)) removePlayer(id);
}
function removePlayer(id) { const p = G.players.get(id); if (!p) return; if (p.mesh) scene.remove(p.mesh); G.players.delete(id); }

/* ================= UI 공통 ================= */
function showScreen(name) {
  $('lobby').classList.toggle('hidden', name !== 'lobby');
  $('results').classList.toggle('hidden', name !== 'results');
  $('hud').classList.toggle('hidden', name !== 'hud');
}
let errT = 0;
function showError(msg) { $('errMsg').textContent = msg; clearTimeout(errT); errT = setTimeout(() => ($('errMsg').textContent = ''), 4000); if (G.phase !== 'lobby') feed(msg); }
let noticeT = 0;
function notice(text, ms = 1800) { $('notice').textContent = text; clearTimeout(noticeT); noticeT = setTimeout(() => ($('notice').textContent = ''), ms); }
function feed(html) {
  const el = document.createElement('div'); el.innerHTML = html; const f = $('feed'); f.appendChild(el);
  while (f.children.length > 4) f.removeChild(f.firstChild);
  setTimeout(() => el.remove(), 5000);
}

function renderLobby() {
  const r = G.room; if (!r) return;
  ensureTrack(r.seed);
  $('entry').classList.add('hidden'); $('roomView').classList.remove('hidden');
  $('roomCode').textContent = r.code;
  const isHost = r.hostId === G.myId;
  const list = $('playerList'); list.innerHTML = '';
  const sorted = [...r.players].sort((a, b) => a.slot - b.slot);
  for (const p of sorted) {
    const li = document.createElement('li'); const rd = p.ready || p.id === r.hostId;
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span><span>${esc(p.name)}${p.id === G.myId ? ' (나)' : ''}${p.id === r.hostId ? ' 👑' : ''}</span>` +
      `<span class="tag ${rd ? 'ready' : ''}">${p.id === r.hostId ? 'HOST' : rd ? 'READY' : '대기 중'}</span>`;
    list.appendChild(li);
  }
  for (let i = sorted.length; i < 4; i++) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = '빈 자리 — 초대 링크를 공유하세요'; list.appendChild(li); }
  $('laps').value = String(r.laps); $('laps').disabled = !isHost;
  $('btnNewTrack').classList.toggle('hidden', !isHost);
  $('btnStart').classList.toggle('hidden', !isHost);
  const me = G.players.get(G.myId);
  $('btnReady').classList.toggle('hidden', isHost);
  $('btnReady').textContent = me && me.ready ? '준비 취소' : '준비 완료';
  $('btnReady').classList.toggle('primary', !(me && me.ready));
  const allReady = r.players.every((p) => p.ready || p.id === r.hostId);
  $('btnStart').disabled = !allReady || r.state !== 'lobby';
  $('lobbyMsg').textContent = r.state === 'finished' ? '이전 경기가 끝났습니다. 호스트가 재경기를 누르면 시작됩니다.'
    : isHost ? (allReady ? '모두 준비 완료! 경기를 시작하세요. (혼자서도 연습 주행 가능)' : '모든 플레이어가 준비하면 시작할 수 있습니다.')
    : '호스트가 경기를 시작하길 기다리는 중...';
  const pc = $('trackPreview'); G.track.drawMap(pc.getContext('2d'), pc.width, pc.height, [], null);
}

/* ================= 레이스 ================= */
function setupRace(room) {
  G.room = room; syncPlayers(room); ensureTrack(room.seed);
  for (const p of G.players.values()) {
    if (!p.mesh) { p.mesh = buildCarMesh(p.color); scene.add(p.mesh); if (p.id !== G.myId) p.mesh.add(makeNameSprite(p.name, p.color)); }
    const sp = G.track.spawn(p.slot);
    p.mesh.position.set(sp.x, 0, sp.z); p.mesh.rotation.y = sp.a;
    p.remote = { buf: [], x: sp.x, z: sp.z, a: sp.a, v: 0, d: 0, n: 0, f: 0 };
  }
  const me = G.players.get(G.myId); const sp = G.track.spawn(me.slot);
  G.local = new CarPhysics(G.track); G.local.reset(sp.x, sp.z, sp.a); G.local.hint = sp.i;
  G.phase = 'countdown'; G.finishPlace = null; G.lapStartLocal = performance.now();
  $('lapsTotal').textContent = room.laps; $('lap').textContent = '1';
  $('lastLap').textContent = fmt(null); $('bestLap').textContent = fmt(null); $('curTime').textContent = fmt(0);
  $('countdown').textContent = 'READY'; $('feed').innerHTML = ''; $('notice').textContent = '';
  showScreen('hud');
  const fx = Math.sin(sp.a), fz = Math.cos(sp.a); camPos.set(sp.x - fx * 8, 3.5, sp.z - fz * 8);
  audio.start();
}
function returnToLobby() {
  G.phase = 'lobby'; G.local = null;
  for (const p of G.players.values()) if (p.mesh) { scene.remove(p.mesh); p.mesh = null; p.remote = null; }
  showScreen('lobby'); renderLobby();
}
function leaveRoom() {
  net.send('leave');
  for (const p of G.players.values()) if (p.mesh) scene.remove(p.mesh);
  G.players.clear(); G.room = null; G.local = null; G.phase = 'lobby';
  showScreen('lobby'); $('roomView').classList.add('hidden'); $('entry').classList.remove('hidden');
}
function respawn() {
  if (!G.local || G.phase === 'lobby') return;
  const L = G.local, T = G.track; const n = T.nearest(L.x, L.z, L.hint); const i = n.i; const nitro = L.nitro;
  L.reset(T.px[i], T.pz[i], Math.atan2(T.dx[i], T.dz[i])); L.hint = i; L.nitro = nitro;
}
function checkpoints() {
  if (G.phase !== 'racing') return;
  const me = G.players.get(G.myId); if (!me || me.finished) return;
  const expected = (me.cp + 1) % CHECKPOINTS;
  if (G.local.sector === expected && performance.now() - G.lastCpSend > 300) { net.send('checkpoint', { index: expected }); G.lastCpSend = performance.now(); }
}
function computeRanking() {
  const arr = [...G.players.values()].filter((p) => p.remote);
  const prog = (p) => {
    const t = p.id === G.myId ? G.local.progress : p.remote.f;
    const frac = Math.max(0, Math.min(1, t * CHECKPOINTS - p.cp));
    return (p.lap - 1) * CHECKPOINTS + p.cp + frac;
  };
  arr.sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1; if (b.finished) return 1;
    return prog(b) - prog(a);
  });
  return arr;
}
function showResults(results) {
  const me = G.myId;
  $('resultTable').innerHTML = `<tr><th>#</th><th></th><th>플레이어</th><th>기록</th><th>베스트 랩</th></tr>` + results.map((r) =>
    `<tr class="${r.id === me ? 'me' : ''}"><td>${r.place}</td><td><i style="background:${r.color}"></i></td><td>${esc(r.name)}</td>` +
    `<td>${r.finished ? fmt(r.time) : 'DNF (Lap ' + Math.min(r.lap, G.room.laps) + ')'}</td><td>${fmt(r.bestLap)}</td></tr>`).join('');
  const isHost = G.room && G.room.hostId === me;
  $('rematchRow').classList.toggle('hidden', !isHost);
  $('resultsMsg').textContent = isHost ? '같은 멤버로 바로 다시 달릴 수 있습니다.' : '호스트가 재경기를 선택하면 자동으로 로비로 돌아갑니다.';
  showScreen('results');
}

/* ================= 입력 ================= */
const keys = {}; const touch = { left: 0, right: 0, acc: 0, brake: 0, drift: 0, nitro: 0 };
const input = { steer: 0, throttle: 0, drift: false, nitro: false };
addEventListener('keydown', (e) => {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
    if (e.ctrlKey && /^(Key[A-Z]|Arrow.*|Space)$/.test(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyR') respawn();
  if (e.code === 'KeyC') G.camMode = (G.camMode + 1) % 3;
  if (e.code === 'KeyM') { audio.setMuted(!audio.muted); notice(audio.muted ? '🔇 MUTE' : '🔊 SOUND', 800); }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function readInput(dt) {
  const right = keys.ArrowRight || keys.KeyD || touch.right ? 1 : 0, left = keys.ArrowLeft || keys.KeyA || touch.left ? 1 : 0;
  const target = right - left;
  if (target !== 0) input.steer = Math.max(-1, Math.min(1, input.steer + target * dt * 5));
  else { const s = Math.sign(input.steer); input.steer -= s * Math.min(Math.abs(input.steer), dt * 7); }
  input.throttle = (keys.ArrowUp || keys.KeyW || touch.acc ? 1 : 0) - (keys.ArrowDown || keys.KeyS || touch.brake ? 1 : 0);
  input.drift = !!(keys.ShiftLeft || keys.ShiftRight || touch.drift);
  input.nitro = !!(keys.ControlLeft || keys.ControlRight || touch.nitro);
  return input;
}
if (matchMedia('(pointer: coarse)').matches) {
  $('touch').classList.remove('hidden');
  for (const btn of $('touch').querySelectorAll('button')) {
    const k = btn.dataset.k;
    const on = (e) => { e.preventDefault(); touch[k] = 1; btn.classList.add('on'); };
    const off = (e) => { e.preventDefault(); touch[k] = 0; btn.classList.remove('on'); };
    btn.addEventListener('pointerdown', on); btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off); btn.addEventListener('pointerleave', off);
  }
}

/* ================= 프레임 업데이트 ================= */
function handleCarCollisions() {
  const L = G.local;
  for (const p of G.players.values()) {
    if (p.id === G.myId || !p.remote) continue;
    const dx = L.x - p.remote.x, dz = L.z - p.remote.z; const d = Math.hypot(dx, dz);
    if (d < 2.4 && d > 0.001) {
      const nx = dx / d, nz = dz / d, pen = 2.4 - d;
      L.x += nx * pen; L.z += nz * pen;
      const vn = L.vx * nx + L.vz * nz;
      if (vn < 0) {
        L.vx -= vn * nx * 1.3; L.vz -= vn * nz * 1.3; L.syncFromVelocity();
        L.hitWall = Math.max(L.hitWall, Math.min(0.6, -vn / 25));
        if (-vn > 6) audio.hit(-vn);
      }
    }
  }
}
function updateLocalMesh(dt) {
  const L = G.local, me = G.players.get(G.myId); if (!me || !me.mesh) return;
  const m = me.mesh; m.position.set(L.x, 0, L.z); m.rotation.y = L.a;
  const u = m.userData;
  u.chassis.rotation.z = L.lat * 0.012;
  u.front.rotation.y = 0; for (const piv of u.front.children) piv.rotation.y = -L.steerVis * 0.45;
  u.spin += (L.speed * dt) / 0.36; for (const w of u.wheels) w.rotation.x = u.spin;
  const flame = L.nitroOn || L.boostTimer > 0;
  for (const f of u.flames) { f.visible = flame; if (flame) f.scale.set(1, 1, 0.7 + Math.random() * 0.7); }
  if ((L.drifting && Math.abs(L.lat) > 3) || (L.onGrass && Math.abs(L.speed) > 8)) smoke.spawn('me', L.x, L.z, L.a, dt);
}
function updateRemotes(now, dt) {
  const renderT = now - 120;
  for (const p of G.players.values()) {
    if (p.id === G.myId || !p.remote || !p.mesh) continue;
    const buf = p.remote.buf;
    while (buf.length > 2 && buf[1].rt <= renderT) buf.shift();
    let x, z, a, v, d, n;
    if (buf.length >= 2 && buf[0].rt <= renderT && buf[1].rt >= renderT) {
      const s0 = buf[0], s1 = buf[1]; const u = (renderT - s0.rt) / Math.max(1, s1.rt - s0.rt);
      x = lerp(s0.x, s1.x, u); z = lerp(s0.z, s1.z, u); a = lerpAngle(s0.a, s1.a, u); v = s1.v; d = s1.d; n = s1.n;
    } else if (buf.length) {
      const s = buf[buf.length - 1]; const ex = Math.max(0, Math.min(0.25, (renderT - s.rt) / 1000));
      x = s.x + Math.sin(s.a) * s.v * ex; z = s.z + Math.cos(s.a) * s.v * ex; a = s.a; v = s.v; d = s.d; n = s.n;
    } else continue;
    p.remote.x = x; p.remote.z = z; p.remote.a = a; p.remote.v = v;
    p.mesh.position.set(x, 0, z); p.mesh.rotation.y = a;
    const u = p.mesh.userData; u.spin += (v * dt) / 0.36; for (const w of u.wheels) w.rotation.x = u.spin;
    for (const f of u.flames) { f.visible = !!n; if (n) f.scale.set(1, 1, 0.7 + Math.random() * 0.7); }
    if (d && Math.abs(v) > 10) smoke.spawn(p.id, x, z, a, dt);
  }
}
function updateCamera(dt) {
  const L = G.local; const fx = Math.sin(L.a), fz = Math.cos(L.a); const sp = Math.min(1.3, Math.abs(L.speed) / MAX_SPEED);
  if (G.camMode === 2) {
    camera.position.set(L.x + fx * 0.6, 1.5, L.z + fz * 0.6); camera.lookAt(L.x + fx * 30, 1.0, L.z + fz * 30);
  } else {
    const dist = (G.camMode === 0 ? 6.0 : 10.5) + sp * 1.2, height = G.camMode === 0 ? 3.0 : 5.2;
    const tx = L.x - fx * dist, tz = L.z - fz * dist; const k = 1 - Math.exp(-dt * 14);
    camPos.x += (tx - camPos.x) * k; camPos.z += (tz - camPos.z) * k; camPos.y += (height - camPos.y) * k;
    if (L.hitWall > 0) { camPos.x += (Math.random() - 0.5) * L.hitWall * 0.5; camPos.y += (Math.random() - 0.5) * L.hitWall * 0.3; }
    camera.position.copy(camPos); camera.lookAt(L.x + fx * 4, 1.1, L.z + fz * 4);
  }
  const fov = 66 + sp * 14 + (L.nitroOn ? 6 : 0);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 5); camera.updateProjectionMatrix(); }
}
function idleCamera(now) {
  const b = G.track.bounds; const r = Math.max(b.w, b.h) * 0.8; const t = now * 0.00012;
  camera.position.set(b.cx + Math.cos(t) * r, 75 + Math.sin(t * 0.7) * 10, b.cz + Math.sin(t) * r); camera.lookAt(b.cx, 0, b.cz);
}
let hudTimer = 0; const mm = $('minimap');
function updateHud(now, dt) {
  const L = G.local; const me = G.players.get(G.myId); if (!me) return;
  hudTimer += dt;
  $('nitroFill').style.width = L.nitro + '%'; $('nitroBar').classList.toggle('on', L.nitroOn);
  $('wrongWay').classList.toggle('hidden', !(L.wrongWay && G.phase === 'racing' && !me.finished));
  if (hudTimer < 0.1) return; hudTimer = 0;
  $('speed').textContent = Math.round(Math.abs(L.speed) * 3.4);
  if (G.phase === 'racing' && !me.finished) $('curTime').textContent = fmt(now - G.lapStartLocal);
  const ranked = computeRanking(); const myPlace = ranked.findIndex((p) => p.id === G.myId) + 1;
  $('place').textContent = myPlace; $('placeSuffix').textContent = ordinal(myPlace); $('total').textContent = ranked.length;
  $('standings').innerHTML = ranked.map((p, i) =>
    `<div class="st ${p.id === G.myId ? 'me' : ''}"><span class="pl">${i + 1}</span><i style="background:${p.color}"></i><span class="nm">${esc(p.name)}</span>` +
    `<span class="lp">${p.finished ? 'FIN ' + fmt(p.finishTime) : 'LAP ' + Math.min(p.lap, G.room.laps)}</span></div>`).join('');
  const cars = [...G.players.values()].filter((p) => p.remote).map((p) => p.id === G.myId
    ? { id: p.id, x: L.x, z: L.z, color: p.color } : { id: p.id, x: p.remote.x, z: p.remote.z, color: p.color });
  G.track.drawMap(mm.getContext('2d'), mm.width, mm.height, cars, G.myId);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (G.phase === 'lobby' || !G.local) { if (G.track && G.trackGroup) idleCamera(now); renderer.render(scene, camera); return; }
  const inp = readInput(dt);
  const blocked = G.phase === 'countdown' || !$('results').classList.contains('hidden');
  if (blocked) { inp.steer = 0; inp.throttle = 0; inp.drift = false; inp.nitro = false; }
  G.local.step(dt, inp);
  handleCarCollisions();
  for (const ev of G.local.events) {
    if (ev.type === 'wall') audio.hit(ev.strength);
    else if (ev.type === 'boost') { audio.boost(); notice('BOOST!', 700); }
  }
  G.local.events.length = 0;
  updateLocalMesh(dt);
  updateRemotes(now, dt);
  smoke.update(dt);
  updateCamera(dt);
  checkpoints();
  updateHud(now, dt);
  audio.update(G.local, inp);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// 상태 전송 20Hz
setInterval(() => {
  if (!G.local || G.phase === 'lobby') return; const L = G.local;
  net.send('state', { x: +L.x.toFixed(2), z: +L.z.toFixed(2), a: +L.a.toFixed(3), v: +L.speed.toFixed(1),
    d: L.drifting && Math.abs(L.lat) > 3 ? 1 : 0, n: L.nitroOn || L.boostTimer > 0 ? 1 : 0, f: +L.progress.toFixed(4) });
}, 50);
setInterval(() => net.send('ping', { t: performance.now() }), 2000);

/* ================= 서버 메시지 핸들러 ================= */
net.on('pong', (m) => { G.ping = Math.round(performance.now() - m.t); $('ping').textContent = G.ping; });
net.on('error', (m) => showError(m.message));
net.on('joined', (m) => { G.myId = m.id; G.room = m.room; syncPlayers(m.room); showScreen('lobby'); renderLobby(); });
net.on('room', (m) => {
  G.room = m.room; syncPlayers(m.room);
  if (m.room.state === 'lobby') { if (G.phase !== 'lobby') returnToLobby(); else renderLobby(); }
  else if (G.phase === 'lobby') renderLobby();
});
net.on('left', (m) => { removePlayer(m.id); if (G.phase !== 'lobby') feed(`${esc(m.name)} 님이 나갔습니다`); });
net.on('race_setup', (m) => setupRace(m.room));
net.on('count', (m) => { $('countdown').textContent = m.n; audio.beep(440, 0.15); });
net.on('go', () => {
  G.phase = 'racing'; G.lapStartLocal = performance.now();
  $('countdown').textContent = 'GO!'; audio.beep(880, 0.35);
  setTimeout(() => { if (G.phase === 'racing') $('countdown').textContent = ''; }, 900);
});
net.on('s', (m) => {
  const p = G.players.get(m.id); if (!p || !p.remote) return;
  p.remote.buf.push({ rt: performance.now(), x: m.x, z: m.z, a: m.a, v: m.v, d: m.d, n: m.n });
  if (p.remote.buf.length > 30) p.remote.buf.shift();
  p.remote.f = m.f;
});
net.on('progress', (m) => {
  const p = G.players.get(m.id); if (!p) return;
  const prevLap = p.lap;
  Object.assign(p, { lap: m.lap, cp: m.cp, lastLap: m.lastLap, bestLap: m.bestLap, finished: m.finished });
  if (m.id === G.myId) {
    if (m.cp === 0 && m.lap !== prevLap) {
      G.lapStartLocal = performance.now();
      $('lastLap').textContent = fmt(m.lastLap); $('bestLap').textContent = fmt(m.bestLap);
      if (!m.finished) { notice(m.lap === G.room.laps ? 'FINAL LAP!' : `LAP ${m.lap}`); audio.beep(660, 0.1, 'triangle'); }
    }
    $('lap').textContent = Math.min(m.lap, G.room.laps);
  }
});
net.on('finished', (m) => {
  const p = G.players.get(m.id); if (!p) return;
  feed(`🏁 <b style="color:${p.color}">${esc(p.name)}</b> 완주 — ${m.place}${ordinal(m.place)} (${fmt(m.time)})`);
  if (m.id === G.myId) { G.finishPlace = m.place; notice(`FINISH! ${m.place}${ordinal(m.place)}`, 4000); audio.fanfare(); }
});
net.on('results', (m) => { G.phase = 'finished'; setTimeout(() => { if (G.phase === 'finished') showResults(m.results); }, 1500); });

/* ================= 버튼 ================= */
const getName = () => { const n = $('name').value.trim().slice(0, 12); if (n) localStorage.setItem('lpr_name', n); return n; };
$('name').value = localStorage.getItem('lpr_name') || '';
const urlRoom = new URLSearchParams(location.search).get('room'); if (urlRoom) $('code').value = urlRoom;
$('btnCreate').onclick = () => { const name = getName(); if (!name) return showError('닉네임을 입력하세요.'); applyQuality($('quality').value); audio.start(); net.send('create', { name }); };
$('btnJoin').onclick = () => {
  const name = getName(); const code = $('code').value.trim();
  if (!name) return showError('닉네임을 입력하세요.');
  if (!/^\d{6}$/.test(code)) return showError('6자리 방 코드를 입력하세요.');
  applyQuality($('quality').value); audio.start(); net.send('join', { name, code });
};
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('code').value ? $('btnJoin') : $('btnCreate')).click(); });
$('btnCopy').onclick = () => {
  const url = `${location.origin}${location.pathname}?room=${G.room.code}`;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(
    () => { $('btnCopy').textContent = '복사됨!'; setTimeout(() => ($('btnCopy').textContent = '초대 링크 복사'), 1200); },
    () => prompt('초대 링크', url));
};
$('btnReady').onclick = () => { const me = G.players.get(G.myId); net.send('ready', { ready: !(me && me.ready) }); };
$('btnStart').onclick = () => net.send('start');
$('laps').onchange = (e) => net.send('set_laps', { laps: +e.target.value });
$('btnNewTrack').onclick = () => net.send('new_track');
$('btnLeave').onclick = leaveRoom; $('btnLeave2').onclick = leaveRoom;
$('btnRematchSame').onclick = () => net.send('rematch', { newTrack: false });
$('btnRematchNew').onclick = () => net.send('rematch', { newTrack: true });

net.connect().catch((e) => showError(e.message));
