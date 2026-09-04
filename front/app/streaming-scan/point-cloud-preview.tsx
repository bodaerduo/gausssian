'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

export function PointCloudPreview({ modelUrl, range }: { modelUrl: string; range: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<THREE.BufferGeometry>();
  const countRef = useRef(0);
  const rangeRef = useRef(range);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let cancelled = false;
    let frame = 0;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef5fa');
    scene.fog = new THREE.FogExp2('#eef5fa', .025);
    const camera = new THREE.PerspectiveCamera(52, 1, .01, 10000);
    camera.position.set(0, 0.8, 4);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    root.replaceChildren(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.screenSpacePanning = true;
    const grid = new THREE.GridHelper(12, 24, '#8fc9d0', '#d1e2eb');
    grid.material.opacity = .35;
    grid.material.transparent = true;
    scene.add(grid);
    const resize = () => { const width = root.clientWidth || 1; const height = root.clientHeight || 1; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    const animate = () => { controls.update(); renderer.render(scene, camera); frame = window.requestAnimationFrame(animate); };
    animate();
    setState('loading');

    new PLYLoader().load(modelUrl, (geometry) => {
      if (cancelled) { geometry.dispose(); return; }
      geometry.computeBoundingSphere();
      geometry.center();
      const total = geometry.getAttribute('position')?.count ?? 0;
      geometry.setDrawRange(0, Math.max(1, Math.floor(total * rangeRef.current / 100)));
      geometryRef.current = geometry;
      countRef.current = total;
      const material = new THREE.PointsMaterial({ size: .018, sizeAttenuation: true, vertexColors: Boolean(geometry.getAttribute('color')), color: '#109f9b', transparent: true, opacity: .92 });
      const points = new THREE.Points(geometry, material);
      scene.add(points);
      const radius = geometry.boundingSphere?.radius || 1;
      camera.position.set(radius * .7, radius * .45, radius * 2.3);
      camera.near = Math.max(.001, radius / 1000);
      camera.far = Math.max(100, radius * 20);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      setState('ready');
    }, undefined, () => { if (!cancelled) setState('error'); });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      geometryRef.current = undefined;
      countRef.current = 0;
      scene.traverse((object) => { if (object instanceof THREE.Points) { object.geometry.dispose(); object.material.dispose(); } });
      renderer.dispose();
      root.replaceChildren();
    };
  }, [modelUrl]);

  useEffect(() => { rangeRef.current = range; geometryRef.current?.setDrawRange(0, Math.max(1, Math.floor(countRef.current * range / 100))); }, [range]);

  return <div className="stream-point-viewer" ref={rootRef}>{state !== 'ready' && <div className="stream-point-state">{state === 'loading' ? '加载实时点云…' : '点云预览加载失败'}</div>}</div>;
}
