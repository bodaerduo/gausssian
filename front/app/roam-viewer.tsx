'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import Image from 'next/image';

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

export function RoamViewer({ modelUrl, modelName, onClose }: { modelUrl: string; modelName: string; onClose: () => void }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef(new Set<string>());
  const speedValues = [0.72, 1.2, 2.1];
  const speedLabels = ['低速', '中速', '高速'];
  const speedRef = useRef(speedValues[1]);
  const jumpVelocityRef = useRef(0);
  const groundedRef = useRef(true);
  const jumpingRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [speedLevel, setSpeedLevel] = useState(1);
  const [error, setError] = useState('');
  const [pressedKeys, setPressedKeys] = useState<string[]>([]);
  const recenterRef = useRef<(clientX: number, clientY: number) => void>(() => undefined);
  const eagleRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  const cycleSpeed = () => {
    setSpeedLevel((current) => {
      const next = (current + 1) % speedValues.length;
      speedRef.current = speedValues[next];
      return next;
    });
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    let cancelled = false;
    let viewer: GaussianViewer | undefined;
    let frame = 0;
    const scene = new THREE.Scene();
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
          progressiveLoad: true,
          splatAlphaRemovalThreshold: 5,
        });
        if (cancelled) {
          await viewer.dispose();
          viewer = undefined;
          return undefined;
        }
        viewer.start();
        setLoaded(true);

        const camera = viewer.camera;
        const playerPosition = new THREE.Vector3(0, 1.15, 4.8);
        const velocity = new THREE.Vector3();
        let yaw = 0;
        let pitch = -0.12;
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        let previous = performance.now();
        const resize = () => {
          const rect = mount.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && camera.isPerspectiveCamera) {
            camera.aspect = rect.width / rect.height;
            camera.updateProjectionMatrix();
          }
          viewer?.forceRenderNextFrame?.();
        };
        const resizeObserver = new ResizeObserver(resize);
        const normalizeKey = (event: KeyboardEvent) => event.key === ' ' ? ' ' : event.code.toLowerCase().startsWith('key') ? event.code.slice(3).toLowerCase() : event.key.toLowerCase();
        const clearKeys = () => { keysRef.current.clear(); setPressedKeys([]); };
        const onKey = (event: KeyboardEvent) => {
          const key = normalizeKey(event);
          keysRef.current.add(key);
          setPressedKeys((current) => current.includes(key) ? current : [...current, key]);
          if (key === 'shift' && !event.repeat) cycleSpeed();
          if (key === 'escape') closeRef.current();
          if (key === ' ' && groundedRef.current) {
            jumpVelocityRef.current = 4.4;
            groundedRef.current = false;
            jumpingRef.current = true;
          }
          if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
        };
        const onKeyUp = (event: KeyboardEvent) => { const key = normalizeKey(event); keysRef.current.delete(key); setPressedKeys((current) => current.filter((value) => value !== key)); };
        const onPointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; };
        const onPointerUp = () => { dragging = false; };
        const onPointerMove = (event: PointerEvent) => {
          if (!dragging) return;
          yaw += (event.clientX - lastX) * 0.006;
          pitch = THREE.MathUtils.clamp(pitch - (event.clientY - lastY) * 0.004, -0.85, 0.65);
          lastX = event.clientX;
          lastY = event.clientY;
        };
        const onDoubleClick = (event: MouseEvent) => recenterRef.current(event.clientX, event.clientY);
        recenterRef.current = (clientX, clientY) => {
          const rect = mount.getBoundingClientRect();
          const nx = (clientX - rect.left - rect.width / 2) / Math.max(1, rect.width);
          const ny = (clientY - rect.top - rect.height / 2) / Math.max(1, rect.height);
          yaw += nx * 1.15;
          pitch = THREE.MathUtils.clamp(pitch - ny * 0.8, -0.85, 0.65);
          dragging = false;
        };
        const animate = (now: number) => {
          if (cancelled || !viewer) return;
          frame = requestAnimationFrame(animate);
          const dt = Math.min((now - previous) / 1000, 0.05);
          previous = now;
          const keys = keysRef.current;
          const move = 2.2 * speedRef.current;
          const verticalMove = move * 4;
          const turnRate = 1.8 * speedRef.current;
          if (keys.has('q')) yaw -= turnRate * dt;
          if (keys.has('e')) yaw += turnRate * dt;
          const forward = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
          const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
          velocity.set(0, 0, 0);
          if (keys.has('w') || keys.has('arrowup')) velocity.addScaledVector(forward, move);
          if (keys.has('s') || keys.has('arrowdown')) velocity.addScaledVector(forward, -move);
          if (keys.has('a') || keys.has('arrowleft')) velocity.addScaledVector(right, -move);
          if (keys.has('d') || keys.has('arrowright')) velocity.addScaledVector(right, move);
          playerPosition.addScaledVector(velocity, dt);
          const verticalInput = (keys.has('r') ? 1 : 0) - (keys.has('f') ? 1 : 0);
          const turnInput = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0);
          const eagle = eagleRef.current;
          if (eagle) {
            eagle.dataset.moving = velocity.lengthSq() > 0.01 || turnInput !== 0 || verticalInput !== 0 ? 'true' : 'false';
            eagle.dataset.turn = turnInput < 0 ? 'left' : turnInput > 0 ? 'right' : 'none';
            eagle.style.setProperty('--eagle-bank', `${turnInput * 12}deg`);
            eagle.style.setProperty('--eagle-yaw', `${turnInput * 24}deg`);
          }
          if (verticalInput !== 0) {
            playerPosition.y = Math.max(1.15, playerPosition.y + verticalInput * verticalMove * dt);
            jumpVelocityRef.current = 0;
            groundedRef.current = playerPosition.y <= 1.15;
            jumpingRef.current = false;
          } else if (jumpingRef.current) {
            jumpVelocityRef.current -= 11 * dt;
            playerPosition.y += jumpVelocityRef.current * dt;
            if (playerPosition.y <= 1.15) {
              playerPosition.y = 1.15;
              jumpVelocityRef.current = 0;
              groundedRef.current = true;
              jumpingRef.current = false;
            }
          }
          const lookDirection = new THREE.Vector3(Math.sin(yaw), Math.sin(pitch), -Math.cos(yaw));
          camera.position.lerp(playerPosition, 0.42);
          camera.lookAt(camera.position.clone().add(lookDirection.multiplyScalar(3)));
          viewer.forceRenderNextFrame?.();
        };
        window.addEventListener('resize', resize);
        resizeObserver.observe(mount);
        resize();
        window.addEventListener('keydown', onKey, { passive: false });
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('blur', clearKeys);
        document.addEventListener('visibilitychange', clearKeys);
        mount.addEventListener('pointerdown', onPointerDown);
        mount.addEventListener('dblclick', onDoubleClick);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointermove', onPointerMove);
        frame = requestAnimationFrame(animate);
        return () => {
          cancelAnimationFrame(frame);
          resizeObserver.disconnect();
          window.removeEventListener('resize', resize);
          window.removeEventListener('keydown', onKey);
          window.removeEventListener('keyup', onKeyUp);
          window.removeEventListener('blur', clearKeys);
          document.removeEventListener('visibilitychange', clearKeys);
          mount.removeEventListener('pointerdown', onPointerDown);
          mount.removeEventListener('dblclick', onDoubleClick);
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
      recenterRef.current = () => undefined;
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
  // The listener lifetime follows the loaded model; cycleSpeed is stable for this interaction handler.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelUrl]);

  const virtualKey = (key: string, label = key.toUpperCase()) => <button className={pressedKeys.includes(key) ? 'virtual-key pressed' : 'virtual-key'} type="button" aria-label={key === 'shift' ? '点击切换速度' : `按住 ${label}`} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); if (key === 'shift') cycleSpeed(); keysRef.current.add(key); setPressedKeys((current) => current.includes(key) ? current : [...current, key]); if (key === ' ' && groundedRef.current) { jumpVelocityRef.current = 4.4; groundedRef.current = false; jumpingRef.current = true; } }} onPointerUp={() => { keysRef.current.delete(key); setPressedKeys((current) => current.filter((value) => value !== key)); }} onPointerCancel={() => { keysRef.current.delete(key); setPressedKeys((current) => current.filter((value) => value !== key)); }}>{label}</button>;
  return <div className="roam-overlay" role="dialog" aria-modal="true" aria-label={`${modelName} 漫游模式`}><div className="roam-shell"><div className="roam-canvas"><div className="roam-engine" ref={mountRef} /><div className="roam-crosshair" /><div ref={eagleRef} className={`eagle-avatar eagle-speed-${speedLevel}`} data-moving="false" data-turn="none" aria-hidden="true"><Image className="eagle-rear" src="/eagle-flight-rear.png" alt="" width={255} height={255} unoptimized /><Image className="eagle-side" src="/eagle-flight.png" alt="" width={255} height={255} unoptimized /></div><div className="roam-status"><span className={loaded ? 'status-pip' : 'status-pip amber'} />{error ? error : loaded ? '真实 PLY 场景已载入' : '正在加载真实 Gaussian 场景…'}</div></div><div className="roam-cockpit"><div className="roam-controls"><div className="virtual-keyboard"><div className="key-row">{virtualKey('q')} {virtualKey('w')} {virtualKey('e')} {virtualKey('r')}</div><div className="key-row">{virtualKey('a')} {virtualKey('s')} {virtualKey('d')} {virtualKey('f')}</div><div className="key-row key-row-wide">{virtualKey('shift', 'SHIFT')}</div></div><div className="speed-control" aria-live="polite"><span>速度</span><strong>{speedLabels[speedLevel]}</strong><small>点击 SHIFT 切换</small></div></div></div></div></div>;
}
