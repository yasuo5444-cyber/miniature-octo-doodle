// 로우폴리 레이서 v3 — 서버 (방 관리 + 상태 중계 + 체크포인트/랩 검증)
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const TICK_MS = 66;            // 상태 브로드캐스트 15Hz
const COUNTDOWN_MS = 3800;     // race_start → go
const DNF_MS = 60000;          // 1등 완주 후 나머지 대기 시간
const LAP_CHOICES = [1, 2, 3, 5];
const COLORS = ['#ff4b4b', '#3fa9ff', '#ffd23f', '#4bff8a'];
// ⚠ public/maps.js 의 cp 값과 반드시 동일해야 함
const MAP_CP = { sunset: 12, harbor: 18, mountain: 16, canyon: 20, random: 12 };

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_, res) => res.send('ok'));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
let nextId = 1;

const newSeed = () => (Math.random() * 0xffffffff) >>> 0;
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return rooms.has(s) ? newCode() : s;
}
function send(ws, type, data = {}) { if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); }
function broadcast(room, type, data = {}) { for (const p of room.players.values()) send(p.ws, type, data); }
function cleanName(n) { n = String(n || '').replace(/[<>]/g, '').trim().slice(0, 12); return n || '플레이어'; }

function roomInfo(room) {
  return {
    code: room.code, host: room.host, state: room.state, settings: room.settings,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, ready: p.ready, slot: p.slot })),
  };
}
const pushRoom = (room) => broadcast(room, 'room', roomInfo(room));

function createRoom() {
  const room = { code: newCode(), host: null, state: 'lobby', players: new Map(), race: null, tick: null,
    settings: { laps: 3, mapId: 'sunset', seed: newSeed() } };
  rooms.set(room.code, room);
  return room;
}
function addPlayer(room, p) {
  const used = new Set([...room.players.values()].map(q => q.slot));
  p.slot = [0, 1, 2, 3].find(s => !used.has(s));
  p.color = COLORS[p.slot]; p.ready = false; p.state = null; p.room = room;
  room.players.set(p.id, p);
  if (room.host === null) room.host = p.id;
}
function destroyRoom(room) {
  clearInterval(room.tick);
  if (room.race) { clearTimeout(room.race.dnfTimer); clearTimeout(room.race.goTimer); }
  rooms.delete(room.code);
}
function removePlayer(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  if (room.players.size === 0) { destroyRoom(room); return; }
  if (room.host === p.id) room.host = room.players.keys().next().value;
  broadcast(room, 'left', { id: p.id });
  if (room.race) { room.race.prog.delete(p.id); if (room.state === 'racing') checkAllFinished(room); }
  pushRoom(room);
}

// ---------------- 경기 ----------------
function startRace(room) {
  const s = room.settings;
  if (!MAP_CP[s.mapId]) s.mapId = 'sunset';
  if (room.race) { clearTimeout(room.race.dnfTimer); clearTimeout(room.race.goTimer); }
  clearInterval(room.tick);
  room.state = 'countdown';
  const t0 = Date.now() + COUNTDOWN_MS;
  const prog = new Map();
  for (const p of room.players.values()) {
    p.ready = false; p.state = null;
    prog.set(p.id, { nextCp: 1, lap: 0, lapStart: t0, laps: [], best: null, finished: false, finishTime: null, t: 0 });
  }
  room.race = { t0, cp: MAP_CP[s.mapId], prog, finishOrder: [], dnfTimer: null, goTimer: null };
  broadcast(room, 'race_start', {
    mapId: s.mapId, seed: s.seed, laps: s.laps, startIn: COUNTDOWN_MS,
    players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, color: p.color, slot: p.slot })),
  });
  room.race.goTimer = setTimeout(() => { if (room.state === 'countdown') { room.state = 'racing'; broadcast(room, 'go'); } }, COUNTDOWN_MS);
  room.tick = setInterval(() => tickRoom(room), TICK_MS);
}

function tickRoom(room) {
  const race = room.race; if (!race) return;
  const arr = [], rank = [];
  for (const p of room.players.values()) {
    if (p.state) arr.push([p.id, ...p.state]);
    const g = race.prog.get(p.id); if (!g) continue;
    const score = g.finished ? 1e6 - race.finishOrder.indexOf(p.id)
      : g.lap * race.cp + ((g.nextCp - 1 + race.cp) % race.cp) + g.t;
    rank.push({ id: p.id, score });
  }
  rank.sort((a, b) => b.score - a.score);
  broadcast(room, 'states', { s: arr, r: rank.map(x => x.id) });
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
function onState(p, m) {
  const room = p.room; if (!room || !room.race) return;
  p.state = [+num(m.x).toFixed(2), +num(m.y).toFixed(2), +num(m.z).toFixed(2), +num(m.a).toFixed(3), +num(m.v).toFixed(1), m.f | 0];
  if (room.state !== 'racing') return;
  const race = room.race, g = race.prog.get(p.id);
  if (!g || g.finished) return;
  const t = ((num(m.t) % 1) + 1) % 1; g.t = t;
  const cp = Math.floor(t * race.cp), CP = race.cp;
  // 다음 체크포인트(랙 보정으로 그 다음 하나까지)만 인정 → 지름길·역주행 무효
  for (let k = 0; k <= 1; k++) {
    if (cp !== (g.nextCp + k) % CP) continue;
    for (let j = 0; j <= k; j++) if ((g.nextCp + j) % CP === 0) completeLap(room, p, g);
    if (g.finished) return;
    g.nextCp = (cp + 1) % CP;
    return;
  }
}
function completeLap(room, p, g) {
  const now = Date.now(), lt = now - g.lapStart;
  g.lapStart = now; g.laps.push(lt); g.lap++;
  if (g.best === null || lt < g.best) g.best = lt;
  send(p.ws, 'lap', { lap: g.lap, time: lt, best: g.best });
  if (g.lap >= room.settings.laps) finishPlayer(room, p, g, now);
}
function finishPlayer(room, p, g, now) {
  const race = room.race;
  g.finished = true; g.finishTime = now - race.t0;
  race.finishOrder.push(p.id);
  broadcast(room, 'finish', { id: p.id, time: g.finishTime, pos: race.finishOrder.length });
  if (race.finishOrder.length === 1) race.dnfTimer = setTimeout(() => endRace(room), DNF_MS);
  checkAllFinished(room);
}
function checkAllFinished(room) {
  const race = room.race; if (!race || room.state !== 'racing') return;
  let all = true;
  for (const p of room.players.values()) { const g = race.prog.get(p.id); if (g && !g.finished) all = false; }
  if (all) endRace(room);
}
function endRace(room) {
  const race = room.race; if (!race || room.state === 'results') return;
  clearTimeout(race.dnfTimer); clearInterval(room.tick); room.tick = null;
  room.state = 'results';
  const list = [];
  for (const p of room.players.values()) {
    const g = race.prog.get(p.id); if (!g) continue;
    const score = g.lap * race.cp + ((g.nextCp - 1 + race.cp) % race.cp) + g.t;
    list.push({ id: p.id, name: p.name, color: p.color, time: g.finished ? g.finishTime : null, best: g.best, laps: g.lap, score });
  }
  list.sort((a, b) => (a.time !== null && b.time !== null) ? a.time - b.time : (a.time !== null ? -1 : b.time !== null ? 1 : b.score - a.score));
  broadcast(room, 'results', { mapId: room.settings.mapId, laps: room.settings.laps, list: list.map(({ score, ...r }) => r) });
}

// ---------------- 소켓 ----------------
wss.on('connection', (ws) => {
  const p = { id: nextId++, ws, name: '', room: null };
  send(ws, 'welcome', { id: p.id });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = p.room, host = room && room.host === p.id;
    switch (m.type) {
      case 'ping': send(ws, 'pong', { t: m.t }); break;
      case 'create': {
        if (room) removePlayer(p);
        p.name = cleanName(m.name);
        const r = createRoom(); addPlayer(r, p);
        send(ws, 'joined', { id: p.id, code: r.code }); pushRoom(r); break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, 'error', { msg: '방을 찾을 수 없습니다. 코드를 확인하세요.' });
        if (r.players.size >= MAX_PLAYERS) return send(ws, 'error', { msg: '방이 가득 찼습니다 (최대 4명).' });
        if (r.state !== 'lobby') return send(ws, 'error', { msg: '경기가 진행 중입니다. 끝난 뒤 다시 시도하세요.' });
        if (room) removePlayer(p);
        p.name = cleanName(m.name); addPlayer(r, p);
        send(ws, 'joined', { id: p.id, code: r.code }); pushRoom(r); break;
      }
      case 'ready': if (room && room.state === 'lobby') { p.ready = !!m.ready; pushRoom(room); } break;
      case 'settings': {
        if (!host || room.state !== 'lobby') break;
        if (LAP_CHOICES.includes(+m.laps)) room.settings.laps = +m.laps;
        if (m.mapId && MAP_CP[m.mapId]) { room.settings.mapId = m.mapId; if (m.mapId === 'random') room.settings.seed = newSeed(); }
        if (m.reroll) room.settings.seed = newSeed();
        pushRoom(room); break;
      }
      case 'start': {
        if (!host || room.state !== 'lobby') break;
        const allReady = [...room.players.values()].every(q => q.id === room.host || q.ready);
        if (!allReady) return send(ws, 'error', { msg: '모든 플레이어가 준비되어야 합니다.' });
        startRace(room); break;
      }
      case 'rematch': if (host && room.state === 'results') startRace(room); break;
      case 'to_lobby':
        if (host && room.state === 'results') { room.state = 'lobby'; room.race = null; for (const q of room.players.values()) q.ready = false; pushRoom(room); }
        break;
      case 'state': onState(p, m); break;
    }
  });
  ws.on('close', () => removePlayer(p));
  ws.on('error', () => {});
});
// 죽은 소켓 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true; ws.ping(); ws.once('pong', () => { ws._dead = false; });
  }
}, 30000);

server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
