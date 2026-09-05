import * as THREE from 'three';

/** 로우폴리 차량. +z 가 전방, 원점은 바퀴 바닥 */
export function buildCar(colorHex) {
  const g = new THREE.Group(); g.rotation.order = 'YXZ';
  const body = new THREE.MeshLambertMaterial({ color: colorHex, flatShading: true });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1b1d22, flatShading: true });
  const glass = new THREE.MeshLambertMaterial({ color: 0x9fd8ff, flatShading: true });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  add(new THREE.BoxGeometry(2.0, 0.6, 4.2), body, 0, 0.62, 0);
  add(new THREE.BoxGeometry(1.7, 0.3, 1.2), body, 0, 1.0, 1.2);
  add(new THREE.BoxGeometry(1.6, 0.6, 1.8), glass, 0, 1.15, -0.3);
  add(new THREE.BoxGeometry(1.8, 0.12, 0.7), dark, 0, 1.4, -2.0);
  add(new THREE.BoxGeometry(0.15, 0.45, 0.15), dark, -0.7, 1.1, -2.0);
  add(new THREE.BoxGeometry(0.15, 0.45, 0.15), dark, 0.7, 1.1, -2.0);
  add(new THREE.BoxGeometry(2.1, 0.25, 0.5), dark, 0, 0.35, 2.05);
  const lightM = new THREE.MeshBasicMaterial({ color: 0xfff4c4 });
  add(new THREE.BoxGeometry(0.4, 0.2, 0.1), lightM, -0.65, 0.75, 2.12);
  add(new THREE.BoxGeometry(0.4, 0.2, 0.1), lightM, 0.65, 0.75, 2.12);
  const brakeM = new THREE.MeshBasicMaterial({ color: 0x550000 });
  add(new THREE.BoxGeometry(0.45, 0.18, 0.1), brakeM, -0.65, 0.75, -2.12);
  add(new THREE.BoxGeometry(0.45, 0.18, 0.1), brakeM, 0.65, 0.75, -2.12);
  const wheelG = new THREE.CylinderGeometry(0.38, 0.38, 0.34, 8); wheelG.rotateZ(Math.PI / 2);
  const wheels = [], front = [];
  for (const [x, z] of [[-1.0, 1.35], [1.0, 1.35], [-1.0, -1.35], [1.0, -1.35]]) {
    const pivot = new THREE.Object3D(); pivot.position.set(x, 0.38, z); g.add(pivot);
    const w = new THREE.Mesh(wheelG, dark); pivot.add(w); wheels.push(w);
    if (z > 0) front.push(pivot);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.8, 6), new THREE.MeshBasicMaterial({ color: 0xff8a2a }));
  flame.rotation.x = -Math.PI / 2; flame.position.set(0, 0.55, -3.0); flame.visible = false; g.add(flame);
  return { group: g, wheels, front, flame, brakeM };
}

export function makeNameSprite(name, colorHex) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const ctx = c.getContext('2d');
  ctx.font = 'bold 34px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(name, 128, 32);
  ctx.fillStyle = colorHex; ctx.fillText(name, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(5, 1.25, 1); return s;
}
