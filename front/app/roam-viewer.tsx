'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

type RoamViewerProps = { modelUrl: string; modelName: string; onClose: () => void };
type CharacterKind = 'spider' | 'scout' | 'armored';
type WeaponKind = 'none' | 'sniper' | 'knife' | 'sword';

const characterOptions: Array<{ id: CharacterKind; label: string; mark: string }> = [
  { id: 'spider', label: '蜘蛛侠', mark: '蛛' },
  { id: 'scout', label: '夜行者', mark: '夜' },
  { id: 'armored', label: '重装', mark: '甲' },
];
const weaponOptions: Array<{ id: WeaponKind; label: string; mark: string }> = [
  { id: 'none', label: '空手', mark: '—' },
  { id: 'sniper', label: '狙击枪', mark: '⌁' },
  { id: 'knife', label: '刀', mark: '◢' },
  { id: 'sword', label: '剑', mark: '✦' },
];

function makeWeapon(kind: WeaponKind) {
  const root = new THREE.Group();
  if (kind === 'none') return root;
  const dark = new THREE.MeshStandardMaterial({ color: 0x141c2b, roughness: 0.55, metalness: 0.7 });
  const steel = new THREE.MeshStandardMaterial({ color: kind === 'sniper' ? 0x70869d : 0xb8c8d9, roughness: 0.35, metalness: 0.85 });
  if (kind === 'sniper') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.62, 10), dark);
    body.rotation.z = Math.PI / 2;
    root.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 8), steel);
    barrel.rotation.z = Math.PI / 2;
    barrel.position.x = 0.4;
    root.add(barrel);
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8), steel);
    scope.rotation.z = Math.PI / 2;
    scope.position.set(-0.03, 0.06, 0);
    root.add(scope);
  } else if (kind === 'knife') {
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.18, 8), dark);
    handle.rotation.z = Math.PI / 2;
    handle.position.x = -0.06;
    root.add(handle);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.045, 0.018), steel);
    blade.position.x = 0.14;
    root.add(blade);
  } else {
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 8), dark);
    grip.rotation.z = Math.PI / 2;
    grip.position.x = -0.12;
    root.add(grip);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.065, 0.025), steel);
    blade.position.x = 0.26;
    root.add(blade);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.2, 0.04), steel);
    guard.position.x = -0.02;
    root.add(guard);
  }
  root.position.set(0.35, 0.68, 0.08);
  root.rotation.z = -0.12;
  return root;
}

function makeHero(character: CharacterKind, weapon: WeaponKind) {
  const root = new THREE.Group();
  const suitColor = character === 'spider' ? 0xc91f3c : character === 'scout' ? 0x0f8b83 : 0x424b5b;
  const accentColor = character === 'spider' ? 0x1c4fa3 : character === 'scout' ? 0xf2a93b : 0x5fb7ef;
  const suit = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.72, metalness: character === 'armored' ? 0.45 : 0.05 });
  const blue = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.76, metalness: 0.05 });
  const web = new THREE.MeshBasicMaterial({ color: 0xf7f8ff, transparent: true, opacity: 0.9 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.34, 5, 10), suit);
  torso.position.y = 0.55;
  root.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), suit);
  head.position.y = 1.03;
  root.add(head);
  const eyeGeometry = new THREE.SphereGeometry(0.055, 8, 6);
  for (const x of [-0.075, 0.075]) {
    const eye = new THREE.Mesh(eyeGeometry, web);
    eye.scale.set(0.75, 1.5, 0.18);
    eye.position.set(x, 1.06, 0.18);
    root.add(eye);
  }
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.29, 4, 8), blue);
    leg.position.set(side * 0.1, 0.19, 0);
    root.add(leg);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 4, 8), blue);
    arm.rotation.z = side * -0.28;
    arm.position.set(side * 0.25, 0.62, 0);
    root.add(arm);
  }
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.075, 8), web);
  emblem.position.set(0, 0.59, 0.19);
  root.add(emblem);
  root.add(makeWeapon(weapon));
  return root;
}

export function RoamViewer({ modelUrl, modelName, onClose }: RoamViewerProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef(new Set<string>());
  const flyingRef = useRef(true);
  const speedRef = useRef(1);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const heroRef = useRef<THREE.Group | null>(null);
  const characterRef = useRef<CharacterKind>('spider');
  const weaponRef = useRef<WeaponKind>('none');
  const [loaded, setLoaded] = useState(false);
  const [flying, setFlying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [character, setCharacter] = useState<CharacterKind>('spider');
  const [weapon, setWeapon] = useState<WeaponKind>('none');
  const [error, setError] = useState('');

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    setLoaded(false);
    setError('');
    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color(0x050b16);
    scene.fog = new THREE.Fog(0x050b16, 7, 38);
    const camera = new THREE.PerspectiveCamera(62, 1, 0.01, 200);
    camera.position.set(0, 1.8, 4.4);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.replaceChildren(renderer.domElement);
    const ambient = new THREE.HemisphereLight(0x9bc7ff, 0x101827, 1.8);
    scene.add(ambient);
    const keyLight = new THREE.DirectionalLight(0x8deed9, 2.2);
    keyLight.position.set(4, 8, 3);
    scene.add(keyLight);
    const grid = new THREE.GridHelper(80, 80, 0x17415a, 0x10233a);
    grid.position.y = -0.02;
    scene.add(grid);
    const hero = makeHero('spider', 'none');
    heroRef.current = hero;
    scene.add(hero);
    const velocity = new THREE.Vector3();
    const target = new THREE.Vector3();
    let yaw = 0;
    let pitch = -0.1;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let previous = performance.now();
    let frame = 0;
    let disposed = false;

    const resize = () => {
      const width = mount.clientWidth || 1;
      const height = mount.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const loader = new PLYLoader();
    loader.load(modelUrl, (geometry) => {
      if (disposed) return;
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      let hasColor = Boolean(geometry.getAttribute('color'));
      if (!hasColor) {
        const dc = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map((name) => geometry.getAttribute(name));
        if (dc.every((attribute): attribute is THREE.BufferAttribute => Boolean(attribute))) {
          const colors = new Float32Array(dc[0].count * 3);
          for (let index = 0; index < dc[0].count; index += 1) {
            for (let channel = 0; channel < 3; channel += 1) colors[index * 3 + channel] = THREE.MathUtils.clamp(0.5 + 0.2820948 * dc[channel].getX(index), 0, 1);
          }
          geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
          hasColor = true;
        }
      }
      const material = new THREE.PointsMaterial({ size: 0.012, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x76d9cb, transparent: true, opacity: 0.9, sizeAttenuation: true });
      const points = new THREE.Points(geometry, material);
      const sphere = geometry.boundingSphere;
      if (sphere) {
        const scale = 6 / Math.max(sphere.radius * 2, 1);
        points.scale.setScalar(scale);
        points.position.sub(sphere.center.multiplyScalar(scale));
      }
      scene.add(points);
      setLoaded(true);
    }, undefined, (cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : 'PLY 加载失败'); });

    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      keysRef.current.add(key);
      if (key === '1' || key === '2' || key === '3' || key === '4') {
        const nextWeapon: WeaponKind = ({ '1': 'none', '2': 'sniper', '3': 'knife', '4': 'sword' } as Record<string, WeaponKind>)[key];
        weaponRef.current = nextWeapon;
        setWeapon(nextWeapon);
      }
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    const onPointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; };
    const onPointerUp = () => { dragging = false; };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      yaw -= (event.clientX - lastX) * 0.006;
      pitch = THREE.MathUtils.clamp(pitch - (event.clientY - lastY) * 0.004, -0.9, 0.65);
      lastX = event.clientX;
      lastY = event.clientY;
    };
    window.addEventListener('keydown', onKey, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    const animate = (now: number) => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      const dt = Math.min((now - previous) / 1000, 0.05);
      previous = now;
      const keys = keysRef.current;
      const boost = keys.has('shift') ? 2.4 : 1;
      const move = 2.2 * boost * speedRef.current;
      const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      velocity.set(0, 0, 0);
      if (keys.has('w') || keys.has('arrowup')) velocity.addScaledVector(forward, -move);
      if (keys.has('s') || keys.has('arrowdown')) velocity.addScaledVector(forward, move);
      if (keys.has('a') || keys.has('arrowleft')) velocity.addScaledVector(right, -move);
      if (keys.has('d') || keys.has('arrowright')) velocity.addScaledVector(right, move);
      if (flyingRef.current && (keys.has('r') || keys.has('e'))) velocity.y += move;
      if (flyingRef.current && (keys.has('f') || keys.has('q'))) velocity.y -= move;
      const currentHero = heroRef.current;
      if (!currentHero) return;
      currentHero.position.addScaledVector(velocity, dt);
      if (!flyingRef.current) currentHero.position.y = 0;
      currentHero.rotation.y = yaw;
      target.copy(currentHero.position).add(new THREE.Vector3(0, 0.72, 0));
      const cameraOffset = new THREE.Vector3(Math.sin(yaw) * 3.2, 1.25 + Math.sin(pitch) * 1.1, Math.cos(yaw) * 3.2);
      camera.position.lerp(target.clone().add(cameraOffset), 1 - Math.pow(0.001, dt));
      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    resize();
    window.addEventListener('resize', resize);
    frame = requestAnimationFrame(animate);
    return () => { disposed = true; cancelAnimationFrame(frame); window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); renderer.domElement.removeEventListener('pointerdown', onPointerDown); window.removeEventListener('pointerup', onPointerUp); window.removeEventListener('pointermove', onPointerMove); scene.traverse((object) => { const mesh = object as THREE.Mesh; if (mesh.geometry) mesh.geometry.dispose(); if (Array.isArray(mesh.material)) mesh.material.forEach((item) => item.dispose()); else if (mesh.material) mesh.material.dispose(); }); renderer.dispose(); sceneRef.current = null; heroRef.current = null; mount.replaceChildren(); };
  }, [modelUrl]);

  useEffect(() => {
    characterRef.current = character;
    weaponRef.current = weapon;
    const scene = sceneRef.current;
    const current = heroRef.current;
    if (!scene || !current) return;
    const replacement = makeHero(character, weapon);
    replacement.position.copy(current.position);
    replacement.rotation.copy(current.rotation);
    scene.remove(current);
    current.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) mesh.material.forEach((item) => item.dispose());
      else if (mesh.material) mesh.material.dispose();
    });
    scene.add(replacement);
    heroRef.current = replacement;
  }, [character, weapon]);

  return <div className="roam-overlay" role="dialog" aria-modal="true" aria-label={`${modelName} 漫游模式`}><div className="roam-shell"><div className="roam-canvas" ref={mountRef}><div className="roam-crosshair" /><div className="roam-status"><span className={loaded ? 'status-pip' : 'status-pip amber'} />{error ? error : loaded ? '空间已载入' : '正在载入空间…'}</div></div><div className="roam-hud"><div><span className="eyebrow">FREE ROAM / 3DGS</span><h2>{modelName}</h2><p>{characterOptions.find((item) => item.id === character)?.label} · {weaponOptions.find((item) => item.id === weapon)?.label} · 在自己的空间里飞一圈。</p></div><button className="roam-close" type="button" onClick={onClose}>× 退出漫游</button></div><div className="roam-loadout"><div><span>角色</span><div>{characterOptions.map((item) => <button key={item.id} type="button" className={character === item.id ? 'loadout-button active' : 'loadout-button'} onClick={() => setCharacter(item.id)}><b>{item.mark}</b>{item.label}</button>)}</div></div><div><span>武器 · 1—4 快捷键</span><div>{weaponOptions.map((item, index) => <button key={item.id} type="button" className={weapon === item.id ? 'loadout-button active' : 'loadout-button'} onClick={() => setWeapon(item.id)}><b>{index + 1}</b>{item.label}</button>)}</div></div></div><div className="roam-controls"><div className="control-cluster"><strong>移动</strong><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><small>前后左右</small></div><div className="control-cluster"><strong>升降</strong><span><kbd>R</kbd><kbd>F</kbd></span><small>上升 / 下降</small></div><div className="control-cluster"><strong>视角</strong><span>拖动鼠标</span><small>旋转镜头</small></div><label className="flight-toggle"><input type="checkbox" checked={flying} onChange={(event) => { const next = event.target.checked; flyingRef.current = next; setFlying(next); }} /><span />飞行模式</label><label className="speed-control">速度 <input type="range" min="0.6" max="2" step="0.1" value={speed} onChange={(event) => { const next = Number(event.target.value); speedRef.current = next; setSpeed(next); }} /></label></div></div></div>;
}
