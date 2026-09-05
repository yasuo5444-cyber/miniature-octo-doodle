import { CHECKPOINTS, TRACK_WIDTH, WALL_OFFSET } from './track.js';

export const MAX_SPEED = 46;         // 유닛/초 (표시 km/h = ×3.4)
const ACCEL = 24, BRAKE = 40, REVERSE_MAX = 12;
const DRAG = 0.32, ROLLING = 3;
const TURN = 2.3;                    // rad/s (저속 기준)
const GRIP = 9, DRIFT_GRIP = 2.4;    // 횡속도 감쇠율
const CAR_HALF_W = 0.85;

/** 아케이드 차량 물리 (클라이언트 시뮬레이션) */
export class CarPhysics {
  constructor(track) { this.track = track; this.events = []; this.reset(0, 0, 0); }

  reset(x, z, a) {
    this.x = x; this.z = z; this.a = a; this.vx = 0; this.vz = 0;
    this.speed = 0; this.lat = 0; this.nitro = 0; this.nitroOn = false; this.drifting = false;
    this.boostTimer = 0; this.padCooldown = 0; this.onGrass = false; this.hitWall = 0;
    this.hint = 0; this.progress = 0; this.sector = 0; this.wrongWay = false; this.steerVis = 0;
  }

  syncFromVelocity() {
    const fx = Math.sin(this.a), fz = Math.cos(this.a);
    this.speed = this.vx * fx + this.vz * fz;
    this.lat = this.vx * -fz + this.vz * fx;
  }

  step(dt, input) {
    const T = this.track;
    // 조향 (속도 의존, 드리프트 시 회전량 증가)
    let fwd = this.speed; const spd = Math.abs(fwd);
    const steerEff = Math.min(1, spd / 10) / (1 + spd / 60);
    this.drifting = !!input.drift && spd > 14 && !this.onGrass;
    const turn = TURN * (this.drifting ? 1.5 : 1) * steerEff;
    this.a -= input.steer * turn * dt * (fwd < -0.5 ? -1 : 1);
    this.steerVis += (input.steer - this.steerVis) * Math.min(1, dt * 10);

    // 새 헤딩 기준으로 속도 분해 → 회전하면 자연스럽게 횡속도 발생
    const fx = Math.sin(this.a), fz = Math.cos(this.a), rx = -fz, rz = fx;
    fwd = this.vx * fx + this.vz * fz; let lat = this.vx * rx + this.vz * rz;

    const near = T.nearest(this.x, this.z, this.hint); this.hint = near.i;
    this.onGrass = Math.abs(near.lat) > TRACK_WIDTH;

    // 부스트 패드
    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.padCooldown = Math.max(0, this.padCooldown - dt);
    if (this.padCooldown <= 0 && T.padAt(near.i, near.lat)) {
      this.boostTimer = 1.5; this.padCooldown = 2.5;
      fwd = Math.max(fwd, MAX_SPEED * 0.95);
      this.events.push({ type: 'boost' });
    }

    // 니트로
    this.nitroOn = !!input.nitro && this.nitro > 0 && fwd > 3;
    if (this.nitroOn) this.nitro = Math.max(0, this.nitro - 36 * dt);
    const boosting = this.boostTimer > 0;
    const maxS = MAX_SPEED * (this.onGrass ? 0.55 : 1) * (this.nitroOn ? 1.28 : 1) * (boosting ? 1.2 : 1);

    // 가감속
    if (input.throttle > 0) fwd += ACCEL * (this.nitroOn ? 1.9 : 1) * (boosting ? 1.4 : 1) * input.throttle * dt;
    else if (input.throttle < 0) { if (fwd > 0.5) fwd -= BRAKE * dt; else fwd -= ACCEL * 0.55 * dt; }
    else fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), ROLLING * dt);
    fwd -= fwd * DRAG * dt * (this.onGrass ? 3.5 : 1);
    if (this.drifting) fwd -= fwd * 0.18 * dt;
    if (fwd > maxS) fwd -= (fwd - maxS) * Math.min(1, 2.5 * dt);
    if (fwd < -REVERSE_MAX) fwd = -REVERSE_MAX;

    // 횡 그립 / 니트로 충전
    const grip = this.drifting ? DRIFT_GRIP : GRIP * (this.onGrass ? 0.5 : 1);
    lat -= lat * Math.min(1, grip * dt);
    if (this.drifting && Math.abs(lat) > 3) this.nitro = Math.min(100, this.nitro + 20 * dt);

    // 적분
    this.vx = fx * fwd + rx * lat; this.vz = fz * fwd + rz * lat;
    this.x += this.vx * dt; this.z += this.vz * dt;

    // 벽 충돌 (중앙선 기준 횡거리 제한)
    const n2 = T.nearest(this.x, this.z, this.hint); this.hint = n2.i;
    const limit = TRACK_WIDTH + WALL_OFFSET - CAR_HALF_W;
    if (Math.abs(n2.lat) > limit) {
      const sgn = Math.sign(n2.lat); const nx = n2.rx * sgn, nz = n2.rz * sgn;
      this.x = n2.cx + nx * limit; this.z = n2.cz + nz * limit;
      const vn = this.vx * nx + this.vz * nz;
      if (vn > 0) {
        this.vx -= vn * nx * 1.4; this.vz -= vn * nz * 1.4;
        this.vx *= 0.85; this.vz *= 0.85;
        this.hitWall = Math.min(1, vn / 18);
        if (vn > 3) this.events.push({ type: 'wall', strength: vn });
      }
    }
    this.hitWall = Math.max(0, this.hitWall - dt * 2.5);
    this.syncFromVelocity();

    // 진행도 / 섹터 / 역주행
    this.progress = n2.t;
    this.sector = Math.floor(n2.t * CHECKPOINTS) % CHECKPOINTS;
    const vd = this.vx * n2.dx + this.vz * n2.dz; this.wrongWay = vd < -5;
  }
}
