'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

type GaussianViewer = {
  addSplatScene: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  start: () => void;
  dispose: () => Promise<void> | void;
  camera: THREE.Camera;
  forceRenderNextFrame?: () => void;
};

type GaussianSplatsModule = {
  Viewer: new (options?: Record<string, unknown>) => GaussianViewer;
  SceneFormat: { Ply: number };
};

function makeStickFigure() {
  const root = new THREE.Group();
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0x1769aa, transparent: true, opacity: 0.95 });
  const accentMaterial = new THREE.MeshBasicMaterial({ color: 0x315fc4 });
  const addLine = (points: THREE.Vector3[]) => {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    root.add(new THREE.Line(geometry, lineMaterial));
  };
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), accentMaterial);
  head.position.y = 1.05;
  root.add(head);
  addLine([new THREE.Vector3(0, 0.88, 0), new THREE.Vector3(0, 0.38, 0)]);
  addLine([new THREE.Vector3(-0.32, 0.68, 0), new THREE.Vector3(0.32, 0.68, 0)]);
  addLine([new THREE.Vector3(0, 0.38, 0), new THREE.Vector3(-0.24, 0, 0)]);
  addLine([new THREE.Vector3(0, 0.38, 0), new THREE.Vector3(0.24, 0, 0)]);
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.23, 24), lineMaterial);
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = -0.01;
  root.add(marker);
  return root;
}

export function RoamViewer({ modelUrl, modelName, onClose }: { modelUrl: string; modelName: string; onClose: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef(new Set<string>());
  const flyingRef = useRef(true);
  const speedRef = useRef(1);
  const [loaded, setLoaded] = useState(false);
  const [flying, setFlying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState('');
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let cancelled = false;
    let viewer: GaussianViewer | undefined;
    let frame = 0;
    const scene = new THREE.Scene();
    const avatar = makeStickFigure();
    avatar.position.set(0, -1.35, 1.25);
    scene.add(avatar);
    const grid = new THREE.GridHelper(24, 24, 0x8db7d6, 0xd5e5f0);
    grid.position.y = -1.36;
    scene.add(grid);

    setLoaded(false);
    setError('');
    mount.replaceChildren();

    const load = async () => {
      try {
        const splatsModule = await import('@mkkellogg/gaussian-splats-3d') as unknown as GaussianSplatsModule;
        if (cancelled) return undefined;
        viewer = new splatsModule.Viewer({
          rootElement: mount,
          threeScene: scene,
          cameraUp: [0, 1, 0],
          initialCameraPosition: [0, 1.15, 4.8],
          initialCameraLookAt: [0, 0, 0],
          useBuiltInControls: false,
          sharedMemoryForWorkers: false,
          gpuAcceleratedSort: false,
          integerBasedSort: false,
          sphericalHarmonicsDegree: 2,
          maxScreenSpaceSplatSize: 256,
          logLevel: 0,
        });
        await viewer.addSplatScene(modelUrl, {
          format: splatsModule.SceneFormat.Ply,
          rotation: [1, 0, 0, 0],
          showLoadingUI: false,
          progressiveLoad: false,
          splatAlphaRemovalThreshold: 5,
        });
        if (cancelled) return undefined;
        viewer.start();
        setLoaded(true);

        const camera = viewer.camera;
        const velocity = new THREE.Vector3();
        let yaw = 0;
        let pitch = -0.12;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let previous = performance.now();
        const resize = () => viewer?.forceRenderNextFrame?.();
        const onKey = (event: KeyboardEvent) => {
          const key = event.key.toLowerCase();
          keysRef.current.add(key);
          if (key === 'escape') closeRef.current();
          if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
        };
        const onKeyUp = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
        const onPointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; };
        const onPointerUp = () => { dragging = false; };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          yaw -= (event.clientX - lastX) * 0.006;
          pitch = THREE.MathUtils.clamp(pitch - (event.clientY - lastY) * 0.004, -0.85, 0.65);
          lastX = event.clientX;
          lastY = event.clientY;
        };
        const animate = (now: number) => {
          if (cancelled || !viewer) return;
          frame = requestAnimationFrame(animate);
          const dt = Math.min((now - previous) / 1000, 0.05);
          previous = now;
          const keys = keysRef.current;
          const move = 2.2 * (keys.has('shift') ? 2.4 : 1) * speedRef.current;
          const forward = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
          const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
          velocity.set(0, 0, 0);
          if (keys.has('w') || keys.has('arrowup')) velocity.addScaledVector(forward, move);
          if (keys.has('s') || keys.has('arrowdown')) velocity.addScaledVector(forward, -move);
          if (keys.has('a') || keys.has('arrowleft')) velocity.addScaledVector(right, -move);
          if (keys.has('d') || keys.has('arrowright')) velocity.addScaledVector(right, move);
          if (flyingRef.current && (keys.has('r') || keys.has('e'))) velocity.y += move;
          if (flyingRef.current && (keys.has('f') || keys.has('q'))) velocity.y -= move;
          camera.position.addScaledVector(velocity, dt);
          if (!flyingRef.current) camera.position.y = 1.15;
          const lookDirection = new THREE.Vector3(Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw));
          camera.lookAt(camera.position.clone().add(lookDirection.multiplyScalar(3)));
          viewer.forceRenderNextFrame?.();
        };
        window.addEventListener('resize', resize);
        window.addEventListener('keydown', onKey, { passive: false });
        window.addEventListener('keyup', onKeyUp);
        mount.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointermove', onPointerMove);
        frame = requestAnimationFrame(animate);
        return () => {
          cancelAnimationFrame(frame);
          window.removeEventListener('resize', resize);
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('keyup', onKeyUp);
          mount.removeEventListener('pointerdown', onPointerDown);
          window.removeEventListener('pointerup', onPointerUp);
          window.removeEventListener('pointermove', onPointerMove);
        };
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '真实 PLY 模型加载失败');
        return undefined;
      }
    };

    let removeListeners: (() => void) | undefined;
    void load().then((cleanup) => { removeListeners = cleanup; });
    return () => {
      cancelled = true;
      removeListeners?.();
      cancelAnimationFrame(frame);
      if (viewer) void viewer.dispose();
      scene.traverse((object) => {
        const item = object as THREE.Mesh | THREE.Line;
        if (item.geometry) item.geometry.dispose();
        const material = item.material;
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
        else if (material) material.dispose();
      });
      mount.replaceChildren();
    };
  }, [modelUrl]);

  return <div className="roam-overlay" role="dialog" aria-modal="true" aria-label={`${modelName} 漫游模式`}><div className="roam-shell"><div className="roam-canvas" ref={mountRef}><div className="roam-crosshair" /><div className="roam-status"><span className={loaded ? 'status-pip' : 'status-pip amber'} />{error ? error : loaded ? '真实 PLY 场景已载入' : '正在加载真实 Gaussian 场景…'}</div></div><div className="roam-hud"><div><span className="eyebrow">REAL PLY / FREE ROAM</span><h2>{modelName}</h2><p>漫游的是当前资产本身，火柴人仅作为位置标记。</p></div><button className="roam-close" type="button" onClick={onClose}>× 退出漫游</button></div><div className="roam-loadout"><span>漫游对象</span><div className="roam-object-badge"><span className="roam-stick-icon">✣</span><strong>真实 Gaussian PLY</strong></div><small>WASD 移动 · 拖动鼠标转向 · R/F 升降</small></div><div className="roam-controls"><div className="control-cluster"><strong>移动</strong><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><small>前后左右</small></div><div className="control-cluster"><strong>视角</strong><span>拖动鼠标</span><small>旋转镜头</small></div><label className="flight-toggle"><input type="checkbox" checked={flying} onChange={(event) => { const next = event.target.checked; flyingRef.current = next; setFlying(next); }} /><span />飞行模式</label><label className="speed-control">速度 <input type="range" min="0.6" max="2" step="0.1" value={speed} onChange={(event) => { const next = Number(event.target.value); speedRef.current = next; setSpeed(next); }} /></label></div></div></div>;
}
