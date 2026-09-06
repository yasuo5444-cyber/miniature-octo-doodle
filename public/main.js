import * as THREE from 'three';
import { MAPS, MAP_ORDER } from './maps.js';
import { Track, TRACK_WIDTH, WALL_OFFSET } from './track.js';
import { buildCar, makeNameSprite } from './car.js';
import { Sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const lerpAngle = (a, b, t) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (ms) => { if (ms == null) return '--:--.---'; ms = Math.max(0, Math.round(ms)); const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = ms % 1000; return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`; };
const show = (el, on) => el.classList.toggle('hidden', !on);
const isTouch = matchMedia('(pointer: coarse)').matches;
const COLORS = ['#ff4b4b', '#ff8c2a', '#ffd23f', '#4bff8a', '#2ad4b0', '#3fa9ff', '#7d5cff', '#ff5cc8', '#ffffff', '#9aa3ad', '#3b3f45', '#c8a45a'];
let myColor = localStorage.getItem('racer_color') || COLORS[0]; // 저장된 색상이 없으면 첫 번째 색상(빨강)

// ---------- 주행 튜닝 상수 ----------
const P = {
    maxSpeed: 42, accel: 18, brake: 28, reverseMax: 12, drag: 0.0006, roll: 0.04, engineBrake: 0.12,
    grip: 8, driftGrip: 2.0, steer: 1.7, driftSteer: 1.35,
    nitroSpeed: 16, nitroAccel: 18, nitroUse: 45,
    nitroCharge: 35, // 👈 기존 15에서 35로 상향! 드리프트 시 게이지가 훨씬 빠르고 시원하게 찹니다.
    padSpeed: 16, padTime: 2.0, grassMax: 22, grassDrag: 1.5,
    gravity: 20, collideR: 2.3,
};

// ---------- 토스트 ----------
function toast(msg, ms = 2500) { const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; $('toasts').appendChild(el); setTimeout(() => el.classList.add('out'), ms); setTimeout(() => el.remove(), ms + 400); }

// ---------- 네트워크 ----------
class Net {
  constructor() { this.h = {}; this.ping = 0; this.open = false; }
  connect() {
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => { this.open = true; this.emit('_open', {}); clearInterval(this.pt); this.pt = setInterval(() => this.send('ping', { t: performance.now() }), 2000); };
    ws.onclose = () => { this.open = false; clearInterval(this.pt); this.emit('_close', {}); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.emit(m.type, m); };
  }
  send(type, data = {}) { if (this.open) this.ws.send(JSON.stringify({ type, ...data })); }
  on(type, fn) { (this.h[type] ||= []).push(fn); }
  emit(type, m) { for (const f of this.h[type] || []) f(m); }
}
const net = new Net(), sfx = new Sfx();

// ---------- 앱 상태 ----------
const app = { me: null, room: null, phase: 'enter', track: null, trackKey: '', quality: 1, laps: 3, cars: new Map(), local: null, goTime: 0, lapStartPerf: 0, ranks: [], lapInfo: { lap: 0, last: null, best: null }, finished: false, camMode: 0 };
const isHost = () => !!(app.room && app.me && app.room.host === app.me.id);

// ---------- 렌더러 / 씬 ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, 1, 0.5, 2500);
const hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 0.85); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.0); sun.position.set(150, 220, 90); scene.add(sun);
let trackGroup = null;
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

class Particles {
  constructor(n) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3).fill(-1000); this.col = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    this.pa = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage); this.ca = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pa); g.setAttribute('color', this.ca);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.points.frustumCulled = false; scene.add(this.points);
  }
  emit(x, y, z, vx, vy, vz, r, g, b, life = 0.8) { const i = this.i; this.i = (i + 1) % this.n; this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3); this.col.set([r, g, b], i * 3); this.life[i] = life; }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue; this.life[i] -= dt; const k = i * 3;
      if (this.life[i] <= 0) { this.pos[k + 1] = -1000; continue; }
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.vel[k] *= 0.96; this.vel[k + 2] *= 0.96; this.vel[k + 1] += 1.2 * dt;
    }
    this.pa.needsUpdate = true; this.ca.needsUpdate = true;
  }
}
const particles = new Particles(400);

function applyFog() {
  const pal = app.track.def.palette;
  scene.background = new THREE.Color(pal.sky);
  scene.fog = new THREE.Fog(pal.fog, app.quality === 0 ? 120 : 260, app.quality === 0 ? 480 : 950);
  hemi.color.set(pal.sky); hemi.groundColor.set(pal.ground); sun.color.set(pal.light || 0xffffff);
}
function setQuality(q) { app.quality = q; renderer.setPixelRatio(q === 0 ? 0.7 : 1); }
let mmMap = null;
function loadTrack(mapId, seed) {
  const key = `${mapId}:${seed}:${app.quality}`;
  if (key === app.trackKey && app.track) return;
  if (trackGroup) { scene.remove(trackGroup); trackGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); }); }
  app.track = new Track(mapId, seed);
  trackGroup = app.track.build(app.quality); scene.add(trackGroup);
  app.trackKey = key; mmMap = null; applyFog(); drawPreview();
}
function drawPreview() { const c = $('preview'), ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height); if (app.track) app.track.drawMap(ctx, c.width, c.height, 14); }

// ---------- 미니맵 ----------
const mm = $('minimap'), mmCtx = mm.getContext('2d'), mmOff = document.createElement('canvas'); mmOff.width = mm.width; mmOff.height = mm.height;
function drawMinimap() {
  if (!app.track) return;
  if (!mmMap) { const c = mmOff.getContext('2d'); c.clearRect(0, 0, mm.width, mm.height); mmMap = app.track.drawMap(c, mm.width, mm.height, 16); c.globalCompositeOperation = 'destination-over'; c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.arc(mm.width / 2, mm.height / 2, mm.width / 2, 0, Math.PI * 2); c.fill(); c.globalCompositeOperation = 'source-over'; }
  mmCtx.clearRect(0, 0, mm.width, mm.height); mmCtx.drawImage(mmOff, 0, 0);
  for (const c of app.cars.values()) {
    mmCtx.beginPath(); mmCtx.arc(mmMap.tx(c.x), mmMap.tz(c.z), c.local ? 5.5 : 4, 0, Math.PI * 2); mmCtx.fillStyle = c.color; mmCtx.fill();
    if (c.local) { mmCtx.lineWidth = 2; mmCtx.strokeStyle = '#fff'; mmCtx.stroke(); }
  }
}

// ---------- 로비 UI ----------
const nameInput = $('name'), codeInput = $('code');
// --- 메인 화면 색상 팔레트 생성 (안전 장치 추가) ---
try {
    const preCp = $('pre-color-picker');
    if (preCp) {
        COLORS.forEach(c => {
            const btn = document.createElement('div');
            btn.className = 'color-btn';
            btn.style.backgroundColor = c;
            if (c === myColor) btn.classList.add('sel');

            btn.onclick = () => {
                myColor = c;
                localStorage.setItem('racer_color', c);
                Array.from(preCp.children).forEach(b => b.classList.remove('sel'));
                btn.classList.add('sel');
            };
            preCp.appendChild(btn);
        });
    }
} catch (err) {
    console.error("Color picker init error:", err);
}
// ---------------------------------
nameInput.value = localStorage.getItem('racer_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) codeInput.value = params.get('room').toUpperCase();
$('quality').value = localStorage.getItem('racer_q') || '1'; setQuality(+$('quality').value);
function getName() { const n = nameInput.value.trim().slice(0, 12); if (!n) { toast('닉네임을 입력하세요'); nameInput.focus(); return null; } localStorage.setItem('racer_name', n); return n; }
$('btn-create').onclick = () => { const n = getName(); if (!n) return; sfx.init(); net.send('create', { name: n }); };
$('btn-join').onclick = () => { const n = getName(); if (!n) return; const c = codeInput.value.trim().toUpperCase(); if (c.length < 4) { toast('방 코드를 입력하세요'); return; } sfx.init(); net.send('join', { name: n, code: c }); };
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
$('btn-ready').onclick = () => { const me = app.room && app.room.players.find(p => p.id === app.me.id); if (me) net.send('ready', { ready: !me.ready }); };
$('btn-start').onclick = () => net.send('start');
$('btn-leave').onclick = () => {
    net.send('leave'); // 서버에 나간다고 확실하게 신호 전송
    setTimeout(() => {
        location.href = location.pathname; // 0.1초 후 안전하게 로비로 이동
    }, 100);
};
$('btn-invite').onclick = () => { const url = `${location.origin}${location.pathname}?room=${app.room.code}`; if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('초대 링크를 복사했습니다'), () => prompt('링크 복사', url)); else prompt('링크 복사', url); };
$('laps').onchange = (e) => net.send('settings', { laps: +e.target.value });
$('btn-reroll').onclick = () => net.send('settings', { reroll: true });
$('quality').onchange = (e) => { setQuality(+e.target.value); localStorage.setItem('racer_q', e.target.value); if (app.track) { const [id, seed] = app.trackKey.split(':'); app.trackKey = ''; loadTrack(id, +seed); } };
$('btn-rematch').onclick = () => net.send('rematch');
$('btn-tolobby').onclick = () => net.send('to_lobby');
for (const id of MAP_ORDER) {
  const d = MAPS[id], el = document.createElement('div'); el.className = 'map-card'; el.dataset.id = id;
  el.innerHTML = `<div class="map-name">${d.icon} ${d.name}</div><div class="map-diff">${d.diff ? '★'.repeat(d.diff) + '<span class="dim">' + '★'.repeat(5 - d.diff) + '</span>' : '가변'}</div><div class="map-desc">${d.desc}</div>`;
  el.onclick = () => { if (isHost() && app.room.state === 'lobby') net.send('settings', { mapId: id }); };
  $('maps').appendChild(el);
}
function renderRoom() {
  const r = app.room; if (!r) return;
  loadTrack(r.settings.mapId, r.settings.seed);
  const host = isHost(), me = r.players.find(p => p.id === app.me.id);
  $('room-code').textContent = r.code;
  const list = $('players'); list.innerHTML = '';
  for (const p of r.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.id === r.host ? ' <span class="tag">HOST</span>' : ''}${p.id === app.me.id ? ' <span class="tag me">나</span>' : ''}<span class="ready ${p.ready ? 'on' : ''}">${p.id === r.host ? '' : (p.ready ? '준비 완료' : '대기')}</span>`;
    list.appendChild(li);
  }
  for (let i = r.players.length; i < 4; i++) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = '빈 자리'; list.appendChild(li); }
  $('laps').value = String(r.settings.laps); $('laps').disabled = !host;
  document.querySelectorAll('.map-card').forEach(el => { el.classList.toggle('sel', el.dataset.id === r.settings.mapId); el.classList.toggle('locked', !host); });
  show($('btn-reroll'), host && r.settings.mapId === 'random');
  show($('btn-ready'), !host); $('btn-ready').textContent = me && me.ready ? '준비 취소' : '준비';
  show($('btn-start'), host);
  const allReady = r.players.every(p => p.id === r.host || p.ready);
  $('btn-start').disabled = !allReady; $('btn-start').textContent = allReady ? '경기 시작' : '전원 준비 대기 중';
  $('host-hint').textContent = host ? '— 맵을 클릭해 선택' : '— 호스트가 선택 중';
  const d = MAPS[r.settings.mapId];
  $('map-info').innerHTML = `<b>${d.icon} ${d.name}</b><br/>랩 길이 약 ${Math.round(app.track.length / 10) * 10}m · 최대 고도 ${Math.round(app.track.maxY)}m · 점프 ${app.track.jumps.length}개<br/>${r.settings.laps}랩 · 총 약 ${(app.track.length * r.settings.laps / 1000).toFixed(1)}km`;
}
function toLobby() {
  app.phase = 'lobby'; clearCars(); app.local = null;
  show($('lobby'), true); show($('screen-enter'), false); show($('screen-room'), true);
  show($('hud'), false); show($('results'), false); show($('touch'), false); show($('countdown'), false);
  renderRoom();
}

// ---------- 네트워크 핸들러 ----------
net.on('_open', () => { $('conn').textContent = ''; });
net.on('_close', () => { $('conn').textContent = '서버 연결 끊김 — 새로고침하세요'; toast('서버와 연결이 끊어졌습니다. 새로고침하세요.', 8000); });
net.on('error', m => toast(m.msg || '오류'));
net.on('welcome', m => { app.me = { id: m.id }; });
net.on('joined', m => {
    app.me = { id: m.id }; app.phase = 'lobby'; show($('screen-enter'), false); show($('screen-room'), true); history.replaceState(null, '', `${location.pathname}?room=${m.code}`);

    // 👇 방에 입장하자마자 서버에 내가 찜한 색상 보내기 (이 줄이 꼭 있어야 합니다!)
    net.send('color', { color: myColor });
});
net.on('room', m => {
  app.room = m;
  if (m.state === 'lobby' && app.phase !== 'lobby' && app.phase !== 'enter') toLobby();
  else if (app.phase === 'lobby') renderRoom();
});
net.on('left', m => { const c = app.cars.get(m.id); if (c) { toast(`${c.name} 님이 나갔습니다`); scene.remove(c.group); app.cars.delete(m.id); } });
net.on('pong', m => { net.ping = Math.round(performance.now() - m.t); });
net.on('race_start', m => {
    app.phase = 'countdown';
    app.finished = false;
    app.laps = m.laps || (app.room ? app.room.settings.laps : 3);
    app.ranks = [];
    app.lapInfo = { lap: 0, last: null, best: null };

    const mapId = m.mapId || (app.room ? app.room.settings.mapId : 'sunset');
    const seed = m.seed || (app.room ? app.room.settings.seed : 1);
    loadTrack(mapId, seed);

    show($('lobby'), false); show($('results'), false); show($('hud'), true); show($('touch'), isTouch);

    clearCars();

    // 🚨 핵심 포인트: 서버에서 m.players를 주지 않을 경우 방의 참가자 목록을 알아서 사용하도록 2중 방어!
    const playersList = m.players || (app.room ? app.room.players : []);
    for (const p of playersList) {
        if (p) spawnCar(p);
    }

    camInit = false;
    sfx.init();

    if (MAPS[mapId]) {
        $('hud-map').textContent = `${MAPS[mapId].icon} ${MAPS[mapId].name}`;
    }
    $('hud-lap').textContent = `LAP 1/${app.laps}`;
    runCountdown(m.startIn || 3000);
});
net.on('go', () => { app.phase = 'racing'; app.goTime = app.lapStartPerf = performance.now(); sfx.go(); });
net.on('states', m => {
  for (const s of m.s) { const c = app.cars.get(s[0]); if (!c || c.local) continue; c.target = { x: s[1], y: s[2], z: s[3], a: s[4], v: s[5], f: s[6] }; if (!c.hasTarget) { c.x = s[1]; c.y = s[2]; c.z = s[3]; c.a = s[4]; } c.hasTarget = true; }
  app.ranks = m.r;
});
net.on('lap', m => { app.lapInfo = { lap: m.lap, last: m.time, best: m.best }; app.lapStartPerf = performance.now(); sfx.lap(); if (m.lap < app.laps) toast(m.lap === app.laps - 1 ? '🏁 FINAL LAP!' : `LAP ${m.lap + 1} / ${app.laps}`, 1500); });
net.on('finish', m => { const c = app.cars.get(m.id); toast(`🏁 ${c ? c.name : '?'} 완주 — ${m.pos}위 (${fmtTime(m.time)})`, 3500); if (m.id === app.me.id) { app.finished = true; sfx.fanfare(); } });
net.on('results', m => showResults(m));

// ---------- 카운트다운 / 결과 ----------
let cdTimers = [];
function runCountdown(startIn) {
  cdTimers.forEach(clearTimeout); cdTimers = [];
  const el = $('countdown'); el.className = 'ready'; el.textContent = 'READY';
  [3, 2, 1].forEach(n => cdTimers.push(setTimeout(() => { el.className = ''; el.textContent = String(n); sfx.countdown(); }, Math.max(0, startIn - n * 1000))));
  cdTimers.push(setTimeout(() => { el.className = 'go'; el.textContent = 'GO!'; }, startIn));
  cdTimers.push(setTimeout(() => show(el, false), startIn + 900));
}
function showResults(m) {
  app.phase = 'results';
  show($('results'), true); show($('hud'), false); show($('touch'), false); show($('countdown'), false);
  $('results-map').textContent = `${MAPS[m.mapId].name} · ${m.laps}랩`;
  const tb = $('results-body'); tb.innerHTML = '';
  m.list.forEach((r, i) => {
    const tr = document.createElement('tr'); if (r.id === app.me.id) tr.className = 'me';
    tr.innerHTML = `<td>${i + 1}</td><td><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</td><td>${r.time != null ? fmtTime(r.time) : `DNF (${r.laps}랩)`}</td><td>${fmtTime(r.best)}</td>`;
    tb.appendChild(tr);
  });
  show($('host-actions'), isHost()); show($('guest-wait'), !isHost());
}

// ---------- 차량 ----------
function clearCars() { for (const c of app.cars.values()) { scene.remove(c.group); c.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); } app.cars.clear(); }
function spawnCar(p) {
    if (!p) return;
    const myId = app.me ? app.me.id : app.myId;
    const local = (p.id == myId);

    // 혹시 맵에서 높이(y) 값을 누락해서 보내더라도 차가 지하로 꺼지지 않도록 방어
    const gridPos = p.grid !== undefined ? p.grid : (p.slot !== undefined ? p.slot : 0);
    const sp = app.track.spawn(gridPos);
    if (sp.y === undefined) sp.y = 0;

    const car = buildCar(p.color || '#ffffff');
    car.group.position.set(sp.x, sp.y, sp.z);
    car.group.rotation.y = sp.a;

    const c = { id: p.id, name: p.name, color: p.color, ...car, local, target: null, hasTarget: false, x: sp.x, y: sp.y, z: sp.z, a: sp.a, v: 0, pitch: 0, hint: sp.i };

    if (!local) {
        const spr = makeNameSprite(p.name, p.color);
        spr.position.y = 2.8;
        car.group.add(spr);
    }

    scene.add(car.group);
    app.cars.set(p.id, c);

    if (local) {
        // 👇 결정적 해결! steerVis: 0 과 landBurst: 0 을 추가하여 차가 화면에서 사라지는 버그를 완벽 해결했습니다.
        app.local = {
            x: sp.x, y: sp.y, z: sp.z, vx: 0, vz: 0, vy: 0, a: sp.a, hint: sp.i, n: null,
            airborne: false, airTime: 0, drifting: false, slip: 0, nitro: 0, nitroOn: false,
            padBoost: 0, padLast: null, wrong: 0, shake: 0, camYaw: sp.a, off: 0,
            steerVis: 0, landBurst: 0
        };
    }
}
// ---------- 입력 ----------
const keys = {}, touch = { up: 0, down: 0, left: 0, right: 0, drift: 0, nitro: 0 };
const input = { ...NO_INPUT };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
  if (e.ctrlKey && /^(Key[A-Z]|Arrow.*|Space)$/.test(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'KeyC') app.camMode = (app.camMode + 1) % 3;
  if (e.code === 'KeyM') toast(sfx.toggleMute() ? '🔇 음소거' : '🔊 소리 켬', 800);
  if (e.code === 'KeyR' && app.local && app.phase === 'racing') resetCar();
});
addEventListener('keyup', e => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function readInput() {
  input.up = !!(keys.KeyW || keys.ArrowUp || touch.up); input.down = !!(keys.KeyS || keys.ArrowDown || touch.down);
  input.left = !!(keys.KeyA || keys.ArrowLeft || touch.left); input.right = !!(keys.KeyD || keys.ArrowRight || touch.right);
  input.drift = !!(keys.ShiftLeft || keys.ShiftRight || touch.drift); input.nitro = !!(keys.ControlLeft || keys.ControlRight || touch.nitro);
}
for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.k, on = e => { e.preventDefault(); touch[k] = 1; b.classList.add('on'); }, off = e => { e.preventDefault(); touch[k] = 0; b.classList.remove('on'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
}
function resetCar() {
  const L = app.local, n = app.track.nearest(L.x, L.z, L.hint);
  L.x = n.cx; L.z = n.cz; L.y = n.gy; L.vx = L.vz = L.vy = 0; L.a = Math.atan2(n.dx, n.dz); L.airborne = false; L.padBoost = 0;
  toast('트랙으로 복귀', 800);
}

// ---------- 물리 (로컬 차량) ----------
function stepLocal(dt, control) {
    const L = app.local, T = app.track, inp = control ? input : NO_INPUT;
    const fwdX = Math.sin(L.a), fwdZ = Math.cos(L.a);
    const fs0 = L.vx * fwdX + L.vz * fwdZ, speed = Math.hypot(L.vx, L.vz);
    const n = T.nearest(L.x, L.z, L.hint); L.hint = n.i;
    const onRoad = Math.abs(n.lat) <= TRACK_WIDTH + 0.5; L.offRoad = !onRoad;
    // 기존 코드:
    // L.drifting = inp.drift && speed > 8 && !L.airborne;
    // L.nitroOn = inp.nitro && L.nitro > 0 && !L.airborne && fs0 > 1;

    // 👇 수정할 코드 (드리프트 중에는 부스터 사용 원천 차단!)
    L.drifting = inp.drift && speed > 8 && !L.airborne;
    L.nitroOn = inp.nitro && L.nitro > 0 && !L.airborne && fs0 > 1 && !L.drifting;
    if (L.nitroOn) L.nitro = Math.max(0, L.nitro - P.nitroUse * dt);
    // 조향 (a 증가 = 좌회전)
    const steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0), dir = fs0 >= -0.5 ? 1 : -1;
    let turn = steer * P.steer * Math.min(1, speed / 7) / (1 + speed / 60) * (L.drifting ? P.driftSteer : 1) * dir;
    if (L.airborne) turn *= 0.25;
    L.a += turn * dt;
    L.steerVis += (steer - L.steerVis) * Math.min(1, dt * 10);
    // 종방향
    const maxS = P.maxSpeed + (L.nitroOn ? P.nitroSpeed : 0) + (L.padBoost > 0 ? P.padSpeed : 0);
    let acc = 0;
    if (!L.airborne) {
        if (inp.up) acc += (P.accel + (L.nitroOn ? P.nitroAccel : 0)) * Math.max(0, 1 - fs0 / maxS);
        else if (!inp.down) acc -= fs0 * P.engineBrake;
        if (inp.down) acc += fs0 > 0.5 ? -P.brake : (fs0 > -P.reverseMax ? -P.accel * 0.5 : 0);
        if (!onRoad) { acc -= fs0 * P.grassDrag; if (Math.abs(fs0) > P.grassMax) acc -= Math.sign(fs0) * 10; }
        const sl = n.slope * (fwdX * n.dx + fwdZ * n.dz);          // 진행방향 경사
        acc -= P.gravity * sl / Math.sqrt(1 + sl * sl);             // 오르막 감속 / 내리막 가속
        L.pitchTarget = -Math.atan(sl);
    } else L.pitchTarget = -Math.atan2(L.vy, Math.max(5, speed)) * 0.7;
    acc -= fs0 * Math.abs(fs0) * P.drag + fs0 * P.roll;
    if (!control) acc = 0;
    if (L.padBoost > 0) L.padBoost -= dt;
    // 새 헤딩 축으로 속도 재구성: 전방 성분 + 감쇠하는 횡 성분(드리프트)
    const fX = Math.sin(L.a), fZ = Math.cos(L.a), rX = -fZ, rZ = fX;
    let f = L.vx * fX + L.vz * fZ + acc * dt, l = L.vx * rX + L.vz * rZ;
    if (!control) f *= Math.exp(-3 * dt);
    const grip = L.airborne ? 0.2 : (L.drifting ? P.driftGrip : (onRoad ? P.grip : 4.5));
    l *= Math.exp(-grip * dt);
    L.slip = Math.atan2(Math.abs(l), Math.abs(f) + 0.01);
    if (L.drifting && L.slip > 0.1) L.nitro = Math.min(100, L.nitro + P.nitroCharge * dt * Math.min(1, L.slip * 4));
    L.vx = fX * f + rX * l; L.vz = fZ * f + rZ * l;
    L.x += L.vx * dt; L.z += L.vz * dt;
    // 벽 충돌 (미끄러지듯 스쳐 지나가도록 수정)
    const frontX = L.x + fX * 1.2;
    const frontZ = L.z + fZ * 1.2;
    const n2 = T.nearest(frontX, frontZ, L.hint);
    L.hint = n2.i; L.n = n2;
    const limit = TRACK_WIDTH + WALL_OFFSET - 1.0;

    if (Math.abs(n2.lat) > limit && L.y < n2.gy + 1.3) {
        const s = Math.sign(n2.lat);

        L.x = n2.cx + n2.rx * s * limit - fX * 1.2;
        L.z = n2.cz + n2.rz * s * limit - fZ * 1.2;

        const vn = L.vx * n2.rx + L.vz * n2.rz;
        if (vn * s > 0) {
            L.vx -= vn * n2.rx * 1.2;
            L.vz -= vn * n2.rz * 1.2;
            L.vx *= 0.98;
            L.vz *= 0.98;

            const k = Math.min(1, Math.abs(vn) / 20);
            L.shake = Math.max(L.shake, k * 0.8);
            sfx.thud(k);
        }
        n2.lat = s * limit;
    }
    // 지면 / 공중 (램프 끝·급한 정점에서 자연스럽게 이륙)
    const gy = T.groundY(n2);
    if (L.airborne) {
        L.vy -= P.gravity * dt; L.y += L.vy * dt; L.airTime += dt;
        if (L.y <= gy) {
            const impact = -L.vy; L.y = gy; L.airborne = false; L.vy = 0; L.airTime = 0;
            if (impact > 6) { L.shake = Math.max(L.shake, Math.min(1, impact / 18)); L.vx *= 0.92; L.vz *= 0.92; sfx.land(Math.min(1, impact / 18)); L.landBurst = 14; }
        }
    } else {
        const yAir = L.y + L.vy * dt - 0.5 * P.gravity * dt * dt;
        if (gy < yAir - 0.06) { L.airborne = true; L.y = yAir; L.airTime = 0; }
        else { L.vy = (gy - L.y) / dt; L.y = gy; }
    }
    // 부스트 패드
    if (!L.airborne) {
        const pad = T.padAt(n2.i, n2.lat);
        if (pad && L.padLast !== pad) { L.padLast = pad; L.padBoost = P.padTime; L.nitro = Math.min(100, L.nitro + 30); const sp = Math.hypot(L.vx, L.vz), k = (sp + 8) / (sp || 1); L.vx *= k; L.vz *= k; sfx.boost(); }
        else if (!pad) L.padLast = null;
    }
    // 역주행
    if (fX * n2.dx + fZ * n2.dz < -0.4 && f > 4) L.wrong += dt; else L.wrong = 0;
    // 차량 간 충돌 (상대는 자기 쪽에서 처리)
    for (const c of app.cars.values()) {
        if (c.local) continue;
        const ddx = L.x - c.x, ddz = L.z - c.z, d = Math.hypot(ddx, ddz);

        if (d < P.collideR && d > 0.01 && Math.abs(L.y - c.y) < 1.5) {
            // 충돌 방향 법선 벡터 (상대차 -> 내 차)
            const nx = ddx / d, nz = ddz / d;

            // 1. 겹침 방지 (서로 파고들지 않게 즉시 밖으로 밀어냄)
            L.x += nx * (P.collideR - d);
            L.z += nz * (P.collideR - d);

            // 2. 상대방(원격) 차량의 현재 X, Z 방향 이동 속도 추정
            const cvx = Math.sin(c.a) * c.v;
            const cvz = Math.cos(c.a) * c.v;

            // 3. 상대 속도 계산 (내 속도 - 상대 속도)
            const dvx = L.vx - cvx;
            const dvz = L.vz - cvz;
            const vn = dvx * nx + dvz * nz; // 충돌 축으로의 접근 속도

            // vn < 0: 서로 가까워지고 있을 때만 운동량 변화 적용
            if (vn < 0) {
                // 반발 계수 (0.4: 범퍼카처럼 튕기지 않고 묵직하게 밀림)
                const bounce = 0.4;
                L.vx -= vn * nx * (1 + bounce);
                L.vz -= vn * nz * (1 + bounce);

                L.shake = Math.max(L.shake, Math.min(1, Math.abs(vn) / 10));
                sfx.thud(Math.min(1, Math.abs(vn) / 15));
            }

            // 4. 측면 마찰 및 밀어내기 (옆으로 나란히 달릴 때의 상호작용)
            // 옆으로 비비면 바깥쪽으로 지속적인 힘(Side Push)을 받고 마찰로 인해 살짝 감속됨
            const sidePush = 2.5;
            L.vx += nx * sidePush * dt;
            L.vz += nz * sidePush * dt;
            L.vx *= 0.99; // 마찰로 인한 속도 감소
            L.vz *= 0.99;
        }
    }
    L.speed = Math.hypot(L.vx, L.vz);
    L.fs = fs0;
}
function animateCar(c, dt, fs, steer, nitro, braking) {
  for (const w of c.wheels) w.rotation.x += fs * dt / 0.38;
  for (const p of c.front) p.rotation.y = steer * 0.45;
  c.flame.visible = nitro; if (nitro) c.flame.scale.set(1, 0.8 + Math.random() * 0.6, 1);
  c.brakeM.color.setHex(braking ? 0xff2020 : 0x550000);
}
function updateLocalVisual(dt) {
    const L = app.local;
    let c = null;
    for (const car of app.cars.values()) {
        if (car.local) { c = car; break; }
    }
    if (!c) return;

    c.x = L.x; c.y = L.y; c.z = L.z; c.a = L.a; c.v = L.speed;
    c.group.position.set(L.x, L.y, L.z);
    c.pitch += (L.pitchTarget - c.pitch) * Math.min(1, dt * 6);
    c.group.rotation.set(c.pitch, L.a, -L.steerVis * 0.06 * Math.min(1, L.speed / 25));
    animateCar(c, dt, L.fs, L.steerVis, L.nitroOn, input.down && L.fs > 0.5);

    const fX = Math.sin(L.a), fZ = Math.cos(L.a), rX = -fZ, rZ = fX, R = () => Math.random() - 0.5;

    if (!L.airborne && L.speed > 6) {
        if (L.drifting && L.slip > 0.12) for (const s of [-1, 1]) if (Math.random() < 0.7) particles.emit(L.x + rX * s * 0.9 - fX * 1.4, L.y + 0.2, L.z + rZ * s * 0.9 - fZ * 1.4, R() * 2, 0.8, R() * 2, 0.85, 0.85, 0.88, 0.9);
        if (L.offRoad && Math.random() < 0.8) particles.emit(L.x - fX * 1.4 + R() * 2, L.y + 0.15, L.z - fZ * 1.4 + R() * 2, R() * 3, 1.5, R() * 3, 0.55, 0.42, 0.25, 0.7);
    }

    // 👇 강화된 부스터 불꽃 이펙트 적용 완료!
    if (L.nitroOn) {
        for (let i = 0; i < 3; i++) {
            particles.emit(
                L.x - fX * 2.8 + R(), L.y + 0.4 + R(), L.z - fZ * 2.8 + R(),
                -fX * 15 + R() * 4, R() * 2, -fZ * 15 + R() * 4,
                1.0, 0.6 + Math.random() * 0.4, 0.1,
                0.3 + Math.random() * 0.3
            );
        }
    }

    if (L.landBurst > 0) { L.landBurst--; particles.emit(L.x + R() * 2.5, L.y + 0.1, L.z + R() * 2.5, R() * 6, 2 + Math.random() * 2, R() * 6, 0.6, 0.5, 0.35, 0.8); }
}
function updateRemote(dt) {
  const k = 1 - Math.exp(-dt * 12);
  for (const c of app.cars.values()) {
    if (c.local || !c.hasTarget) continue;
    const t = c.target;
    c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k; c.z += (t.z - c.z) * k; c.a = lerpAngle(c.a, t.a, k); c.v += (t.v - c.v) * k;
    const drifting = !!(t.f & 1), nitro = !!(t.f & 2), brake = !!(t.f & 8);
    c.group.position.set(c.x, c.y, c.z);
    const n = app.track.nearest(c.x, c.z, c.hint); c.hint = n.i;
    const fX = Math.sin(c.a), fZ = Math.cos(c.a), sl = n.slope * (fX * n.dx + fZ * n.dz);
    c.pitch += (-Math.atan(sl) - c.pitch) * Math.min(1, dt * 6);
    c.group.rotation.set(c.pitch, c.a, 0);
    animateCar(c, dt, c.v, 0, nitro, brake);
    if (drifting && c.v > 6 && Math.random() < 0.6) particles.emit(c.x - fX * 1.4, c.y + 0.2, c.z - fZ * 1.4, (Math.random() - 0.5) * 2, 0.8, (Math.random() - 0.5) * 2, 0.85, 0.85, 0.88, 0.8);
    if (nitro) particles.emit(c.x - fX * 2.8, c.y + 0.5, c.z - fZ * 2.8, -fX * 8, 0.3, -fZ * 8, 1, 0.6, 0.1, 0.3);
  }
}

// ---------- 카메라 ----------
const camModes = [{ d: 9.5, h: 3.8, look: 5, lh: 1.2 }, { d: 15, h: 6.5, look: 8, lh: 1.5 }, null];
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(); let camInit = false;
function updateCamera(dt) {
    const L = app.local; if (!L) return;
    const mode = camModes[app.camMode];
    const velA = L.speed > 3 ? Math.atan2(L.vx, L.vz) : L.a;
    L.camYaw = lerpAngle(L.camYaw, lerpAngle(L.a, velA, L.drifting ? 0.5 : 0.25), 1 - Math.exp(-dt * 5));
    L.shake = Math.max(0, L.shake - dt * 2.2);

    // 👇 부스터/패드 사용 시 화면 진동 추가!
    if (L.nitroOn || L.padBoost > 0) L.shake = Math.max(L.shake, 0.5);

    const sh = L.shake * 0.35, R = () => Math.random() - 0.5;

    // 👇 부스터 켤 때 시야각(FOV) 연출 강화 적용!
    const targetFov = 62 + L.speed * 0.25 + (L.nitroOn ? 25 : 0) + (L.padBoost > 0 ? 18 : 0);
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();

    if (!mode) {   // 후드 카메라
        camera.position.set(L.x + Math.sin(L.a) * 1.0, L.y + 1.25, L.z + Math.cos(L.a) * 1.0);
        camera.lookAt(L.x + Math.sin(L.a) * 30, L.y + 1.0 - Math.tan(L.pitchTarget) * 18, L.z + Math.cos(L.a) * 30);
        return;
    }
    const fX = Math.sin(L.camYaw), fZ = Math.cos(L.camYaw);
    const dx = L.x - fX * mode.d, dz = L.z - fZ * mode.d;
    let dy = L.y + mode.h;
    const gyc = app.track.heightAt(dx, dz, L.hint) + 1.3; if (dy < gyc) dy = gyc;   // 언덕 뒤에서 카메라가 땅에 묻히지 않게
    if (!camInit) { camPos.set(dx, dy, dz); camInit = true; }
    const k = 1 - Math.exp(-dt * 7);
    camPos.x += (dx - camPos.x) * k; camPos.z += (dz - camPos.z) * k; camPos.y += (dy - camPos.y) * Math.min(1, dt * 9);
    camera.position.set(camPos.x + R() * sh, camPos.y + R() * sh, camPos.z + R() * sh);
    camLook.set(L.x + Math.sin(L.a) * mode.look, L.y + mode.lh, L.z + Math.cos(L.a) * mode.look);
    camera.lookAt(camLook);
}
function lobbyCamera(t) {
  const T = app.track, b = T.bounds, r = Math.max(b.w, b.h) * 0.62 + 90;
  camera.fov = 60; camera.updateProjectionMatrix();
  camera.position.set(b.cx + Math.cos(t * 0.12) * r, 110 + T.maxY, b.cz + Math.sin(t * 0.12) * r);
  camera.lookAt(b.cx, T.maxY * 0.3, b.cz);
}

// ---------- HUD ----------
function updateHud() {
  const L = app.local; if (!L) return;
  $('hud-speed').textContent = Math.round(L.speed * 3.6);
  $('hud-lap').textContent = app.finished ? 'FINISH' : `LAP ${Math.min(app.laps, app.lapInfo.lap + 1)}/${app.laps}`;
  const pos = app.ranks.indexOf(app.me.id) + 1; $('hud-pos').textContent = pos ? `${pos}위 / ${app.ranks.length}` : '-';
  $('hud-cur').textContent = app.phase === 'racing' && !app.finished ? fmtTime(performance.now() - app.lapStartPerf) : fmtTime(app.lapInfo.last);
  $('hud-last').textContent = fmtTime(app.lapInfo.last); $('hud-best').textContent = fmtTime(app.lapInfo.best);
  $('nitro-fill').style.width = `${L.nitro}%`; $('nitro-fill').classList.toggle('full', L.nitro >= 99);
  $('hud-ping').textContent = `${net.ping} ms`;
  show($('wrongway'), L.wrong > 0.8); show($('airtime'), L.airTime > 0.45);
  $('leaderboard').innerHTML = app.ranks.map((id, i) => { const c = app.cars.get(id); return c ? `<li class="${id === app.me.id ? 'me' : ''}"><b>${i + 1}</b><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</li>` : ''; }).join('');
}
function sendState() {
  const L = app.local, f = (L.drifting ? 1 : 0) | (L.nitroOn ? 2 : 0) | (L.airborne ? 4 : 0) | (input.down && L.fs > 0.5 ? 8 : 0);
  net.send('state', { x: L.x, y: L.y, z: L.z, a: L.a, v: L.speed, f, t: L.n ? L.n.t : 0 });
}

// ---------- 메인 루프 ----------
let last = performance.now(), sendAcc = 0, hudAcc = 0;
function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!app.track) return;

    if (app.phase === 'enter' || app.phase === 'lobby' || app.phase === 'results') {
        lobbyCamera(now / 1000);
        sfx.setEngine(0, false, false); sfx.setSkid(false, 0); sfx.setNitro(false);
        renderer.render(scene, camera);
        return;
    }

    readInput();
    const control = app.phase === 'racing' && !app.finished;
    if (app.local) {
        const steps = Math.max(1, Math.min(6, Math.ceil(dt / (1 / 120)))), h = dt / steps;
        for (let i = 0; i < steps; i++) stepLocal(h, control);
        updateLocalVisual(dt);
        sendAcc += dt; if (sendAcc >= 1 / 15 && app.phase !== 'results') { sendAcc = 0; sendState(); }
        sfx.setEngine(app.local.speed, control && input.up, app.local.nitroOn);
        sfx.setSkid(app.local.drifting && app.local.slip > 0.1, app.local.slip);
        sfx.setNitro(app.local.nitroOn);
    }
    updateRemote(dt);
    particles.update(dt);

    updateCamera(dt);
    updateHud();
    renderer.render(scene, camera);
}

// ---------- 시작 ----------
try {
    if (!renderer.capabilities.isWebGL2 && !renderer.getContext()) {
        throw new Error("WebGL 지원 불가");
    }
    loadTrack('sunset', 1);
    net.connect();

    // 오디오 컨텍스트 재개 안전장치
    document.addEventListener('pointerdown', () => {
        try { sfx.resume(); } catch (e) { }
    }, { once: true });

    requestAnimationFrame(frame);
} catch (e) {
    console.error("Game initialization failed:", e);
    toast("게임 초기화 중 오류가 발생했습니다. 새로고침 해주세요.", 5000);
}