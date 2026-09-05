/** Web Audio 합성 효과음 (에셋 없음) */
export class Sfx {
  constructor() { this.ctx = null; this.muted = false; }
  init() {
    if (this.ctx) { this.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.5; this.master.connect(ctx.destination);
    // 엔진
    this.eng1 = ctx.createOscillator(); this.eng1.type = 'sawtooth';
    this.eng2 = ctx.createOscillator(); this.eng2.type = 'square';
    this.engF = ctx.createBiquadFilter(); this.engF.type = 'lowpass'; this.engF.frequency.value = 500;
    this.engG = ctx.createGain(); this.engG.gain.value = 0;
    this.eng1.connect(this.engF); this.eng2.connect(this.engF); this.engF.connect(this.engG); this.engG.connect(this.master);
    this.eng1.start(); this.eng2.start();
    // 노이즈 버퍼
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    const loop = (freq, q) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.master); s.start(); return g; };
    this.skidG = loop(1100, 0.8);
    this.nitroG = loop(350, 0.5);
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setEngine(speed, throttle, nitro) {
    if (!this.ctx) return; const t = this.ctx.currentTime, f = 55 + speed * 3.2 + (throttle ? 12 : 0);
    this.eng1.frequency.setTargetAtTime(f, t, 0.06); this.eng2.frequency.setTargetAtTime(f * 0.5 + 1, t, 0.06);
    this.engF.frequency.setTargetAtTime(350 + speed * 30 + (nitro ? 900 : 0), t, 0.08);
    this.engG.gain.setTargetAtTime(0.1 + (throttle ? 0.07 : 0) + Math.min(0.1, speed * 0.002), t, 0.1);
  }
  setSkid(on, k) { if (this.ctx) this.skidG.gain.setTargetAtTime(on ? 0.04 + Math.min(0.2, k * 0.3) : 0, this.ctx.currentTime, 0.05); }
  setNitro(on) { if (this.ctx) this.nitroG.gain.setTargetAtTime(on ? 0.25 : 0, this.ctx.currentTime, 0.08); }
  blip(freq, dur, type = 'square', vol = 0.18) {
    if (!this.ctx) return; const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur);
  }
  countdown() { this.blip(660, 0.15); }
  go() { this.blip(990, 0.5, 'square', 0.22); }
  lap() { this.blip(880, 0.08); setTimeout(() => this.blip(1320, 0.14), 90); }
  boost() {
    if (!this.ctx) return; const ctx = this.ctx, t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2; f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2600, t + 0.45);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + 0.5);
  }
  thud(v) {
    if (!this.ctx) return; const ctx = this.ctx, t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(35, t + 0.2);
    g.gain.setValueAtTime(0.15 + v * 0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.25);
  }
  land(v) { this.thud(v); }
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.blip(f, 0.35, 'triangle', 0.25), i * 130)); }
  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.5; return this.muted; }
}
