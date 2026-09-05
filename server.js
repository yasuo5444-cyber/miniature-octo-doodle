'use strict';
/**
 * LowPoly Racer - 서버 (Express 정적 파일 + ws 실시간)
 * - 6자리 방 코드, 최대 4명
 * - 체크포인트/랩/완주 판정은 서버가 검증 (건너뛰기·역주행 무시)
 * - 경기 종료 후 같은 방·같은 멤버로 재경기 (같은 트랙 / 새 트랙)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const CHECKPOINTS = 12;               // public/track.js 의 CHECKPOINTS 와 반드시 동일
const COLORS = ['#ff4d4d', '#4da6ff', '#5cd65c', '#ffd24d'];
const FINISH_GRACE_MS = 45000;        // 1등 완주 후 나머지에게 주는 시간

const rooms = new Map();
let nextId = 1;
const now = () => Date.now();
const rand = (n) => Math.floor(Math.random() * n);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function genCode() { let c; do c = String(100000 + rand(900000)); while (rooms.has(c)); return c; }
function send(ws, type, data = {}) { if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data })); }
function broadcast(room, type, data = {}, except = null) {
  for (const p of room.players.values()) if (p.ws !== except) send(p.ws, type, data);
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, slot: p.slot, ready: p.ready, lap: p.lap, cp: p.cp,
    finished: p.finished, finishTime: p.finishTime, bestLap: p.bestLap };
}
function roomInfo(room) {
  return { code: room.code, hostId: room.hostId, state: room.state, seed: room.seed, laps: room.laps,
    players: [...room.players.values()].map(publicPlayer) };
}
function createRoom() {
  const room = { code: genCode(), hostId: null, state: 'lobby', seed: rand(1e9), laps: 3,
    players: new Map(), raceStart: 0, finishOrder: [], endTimer: null, countdownTimers: [] };
  rooms.set(room.code, room);
  return room;
}
function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.slot));
  for (let i = 0; i < MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return -1;
}
function resetPlayerRace(p) {
  p.lap = 1; p.cp = 0; p.finished = false; p.finishTime = null; p.bestLap = null; p.lastLap = null; p.lapStart = 0; p.progress = 0;
}
function clearTimers(room) {
  if (room.endTimer) clearTimeout(room.endTimer); room.endTimer = null;
  room.countdownTimers.forEach(clearTimeout); room.countdownTimers = [];
}

function joinRoom(room, ws, name) {
  const slot = freeSlot(room);
  const p = { id: nextId++, ws, room, name: String(name || 'Player').trim().slice(0, 12) || 'Player', slot, color: COLORS[slot], ready: false };
  resetPlayerRace(p);
  room.players.set(p.id, p);
  if (room.hostId === null) room.hostId = p.id;
  ws.player = p;
  send(ws, 'joined', { id: p.id, room: roomInfo(room) });
  broadcast(room, 'room', { room: roomInfo(room) }, ws);
}

function leaveRoom(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id);
  p.room = null;
  if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.values().next().value.id;
  broadcast(room, 'left', { id: p.id, name: p.name });
  broadcast(room, 'room', { room: roomInfo(room) });
  if (room.state === 'racing') checkRaceEnd(room);
}

function startRace(room) {
  clearTimers(room);
  room.state = 'countdown'; room.finishOrder = [];
  for (const p of room.players.values()) resetPlayerRace(p);
  broadcast(room, 'race_setup', { room: roomInfo(room) });
  [3, 2, 1].forEach((n, i) => room.countdownTimers.push(setTimeout(() => broadcast(room, 'count', { n }), 1500 + i * 1000)));
  room.countdownTimers.push(setTimeout(() => {
    room.state = 'racing'; room.raceStart = now();
    for (const p of room.players.values()) p.lapStart = room.raceStart;
    broadcast(room, 'go', {});
  }, 4500));
}

function handleCheckpoint(p, index) {
  const room = p.room;
  if (!room || room.state !== 'racing' || p.finished) return;
  if (!Number.isInteger(index) || index < 0 || index >= CHECKPOINTS) return;
  const expected = (p.cp + 1) % CHECKPOINTS;
  if (index !== expected) return;            // 건너뛰기 / 역주행은 무시
  p.cp = index;
  if (index === 0) {                          // 출발선 통과 = 랩 완료
    const t = now();
    const lapTime = t - p.lapStart; p.lapStart = t; p.lastLap = lapTime;
    if (p.bestLap === null || lapTime < p.bestLap) p.bestLap = lapTime;
    p.lap++;
    if (p.lap > room.laps) {
      p.finished = true; p.finishTime = t - room.raceStart;
      room.finishOrder.push(p.id);
      broadcast(room, 'finished', { id: p.id, place: room.finishOrder.length, time: p.finishTime });
      if (!room.endTimer) room.endTimer = setTimeout(() => endRace(room), FINISH_GRACE_MS);
    }
  }
  broadcast(room, 'progress', { id: p.id, lap: p.lap, cp: p.cp, lastLap: p.lastLap, bestLap: p.bestLap, finished: p.finished });
  checkRaceEnd(room);
}
function checkRaceEnd(room) {
  if (room.state !== 'racing') return;
  const all = [...room.players.values()];
  if (all.length && all.every(p => p.finished)) endRace(room);
}
function endRace(room) {
  if (room.state !== 'racing') return;
  clearTimers(room);
  room.state = 'finished';
  const all = [...room.players.values()];
  const finished = all.filter(p => p.finished).sort((a, b) => a.finishTime - b.finishTime);
  const score = p => p.lap * CHECKPOINTS + p.cp + (p.progress || 0);
  const dnf = all.filter(p => !p.finished).sort((a, b) => score(b) - score(a));
  const results = [...finished, ...dnf].map((p, i) => ({ place: i + 1, id: p.id, name: p.name, color: p.color,
    time: p.finishTime, bestLap: p.bestLap, lap: p.lap, finished: p.finished }));
  broadcast(room, 'results', { results });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const p = ws.player; const room = p && p.room;
    switch (msg.type) {
      case 'ping': send(ws, 'pong', { t: msg.t }); break;

      case 'create': { if (p) leaveRoom(p); joinRoom(createRoom(), ws, msg.name); break; }

      case 'join': {
        const r = rooms.get(String(msg.code || '').trim());
        if (!r) return send(ws, 'error', { message: '존재하지 않는 방 코드입니다.' });
        if (r.players.size >= MAX_PLAYERS) return send(ws, 'error', { message: '방이 가득 찼습니다 (최대 4명).' });
        if (r.state !== 'lobby' && r.state !== 'finished') return send(ws, 'error', { message: '경기가 진행 중인 방입니다. 끝난 뒤 참가하세요.' });
        if (p) leaveRoom(p);
        joinRoom(r, ws, msg.name); break;
      }

      case 'leave': if (p) leaveRoom(p); break;

      case 'ready':
        if (room && room.state === 'lobby') { p.ready = !!msg.ready; broadcast(room, 'room', { room: roomInfo(room) }); }
        break;

      case 'set_laps':
        if (room && room.hostId === p.id && room.state === 'lobby') {
          room.laps = Math.min(9, Math.max(1, msg.laps | 0)); broadcast(room, 'room', { room: roomInfo(room) });
        }
        break;

      case 'new_track':
        if (room && room.hostId === p.id && room.state === 'lobby') { room.seed = rand(1e9); broadcast(room, 'room', { room: roomInfo(room) }); }
        break;

      case 'start': {
        if (!room || room.hostId !== p.id || room.state !== 'lobby') return;
        const all = [...room.players.values()];
        if (!all.every(q => q.ready || q.id === room.hostId)) return send(ws, 'error', { message: '모든 플레이어가 준비되어야 합니다.' });
        startRace(room); break;
      }

      case 'state': {
        if (!room || room.state === 'lobby') return;
        p.progress = Math.max(0, Math.min(1, +msg.f || 0));
        broadcast(room, 's', { id: p.id, x: +msg.x || 0, z: +msg.z || 0, a: +msg.a || 0, v: +msg.v || 0,
          d: msg.d ? 1 : 0, n: msg.n ? 1 : 0, f: p.progress }, ws);
        break;
      }

      case 'checkpoint': if (p) handleCheckpoint(p, msg.index); break;

      case 'rematch': {
        if (!room || room.hostId !== p.id || room.state !== 'finished') return;
        clearTimers(room); room.state = 'lobby';
        if (msg.newTrack) room.seed = rand(1e9);
        for (const q of room.players.values()) { resetPlayerRace(q); q.ready = false; }
        broadcast(room, 'room', { room: roomInfo(room) }); break;
      }
    }
  });
  ws.on('close', () => { if (ws.player) leaveRoom(ws.player); });
});

// 죽은 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`LowPoly Racer 서버 실행 중: http://localhost:${PORT}`));
