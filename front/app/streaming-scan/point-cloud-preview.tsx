'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

type PreviewManifest = { assets?: Array<{ name?: string; url?: string }> };
type CameraPose = number[][];

function applyCameraPose(camera: THREE.PerspectiveCamera, controls: OrbitControls, pose: CameraPose, target: THREE.Vector3) {
  if (pose.length !== 4 || pose.some((row) => row.length !== 4 || row.some((value) => !Number.isFinite(value)))) return;
  const matrix = new THREE.Matrix4().set(...pose.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]);
  matrix.decompose(camera.position, camera.quaternion, camera.scale);
  camera.updateMatrixWorld(true);
  controls.target.copy(target);
  controls.update();
}

export function PointCloudPreview({ modelUrl, range, cameraPose }: { modelUrl: string; range: number; cameraPose?: CameraPose }) {
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<THREE.BufferGeometry>();
  const countRef = useRef(0);
  const rangeRef = useRef(range);
  const cameraPoseRef = useRef(cameraPose);
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const controlsRef = useRef<OrbitControls>();
  const targetRef = useRef(new THREE.Vector3());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return undefined;
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
    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    cameraRef.current = camera;
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.screenSpacePanning = true;
    const grid = new THREE.GridHelper(12, 24, '#8fc9d0', '#d1e2eb');
    grid.material.opacity = .35;
    grid.material.transparent = true;
    scene.add(grid);
    const resize = () => { const width = host.clientWidth || 1; const height = host.clientHeight || 1; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const animate = () => { controls.update(); renderer.render(scene, camera); frame = window.requestAnimationFrame(animate); };
    animate();
    setState('loading');

    new PLYLoader().load(modelUrl, (geometry) => {
      if (cancelled) { geometry.dispose(); return; }
      geometry.computeBoundingSphere();
      const sceneCenter = geometry.boundingSphere?.center.clone() ?? new THREE.Vector3();
      if (!cameraPoseRef.current) geometry.center();
      const total = geometry.getAttribute('position')?.count ?? 0;
      geometry.setDrawRange(0, Math.max(1, Math.floor(total * rangeRef.current / 100)));
      geometryRef.current = geometry;
      countRef.current = total;
      const material = new THREE.PointsMaterial({ size: .024, sizeAttenuation: true, vertexColors: Boolean(geometry.getAttribute('color')), color: '#ffffff', transparent: true, opacity: .94 });
      const points = new THREE.Points(geometry, material);
      scene.add(points);
      const radius = geometry.boundingSphere?.radius || 1;
      material.size = Math.max(.012, Math.min(.09, radius * .003));
      targetRef.current.copy(cameraPoseRef.current ? sceneCenter : new THREE.Vector3());
      camera.position.set(radius * .7, radius * .45, radius * 2.3);
      camera.near = Math.max(.001, radius / 1000);
      camera.far = Math.max(100, radius * 20);
      camera.updateProjectionMatrix();
      controls.target.copy(targetRef.current);
      if (cameraPoseRef.current) applyCameraPose(camera, controls, cameraPoseRef.current, targetRef.current);
      else controls.update();
      setState('ready');
    }, undefined, () => { if (!cancelled) setState('error'); });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      cameraRef.current = undefined;
      controlsRef.current = undefined;
      geometryRef.current = undefined;
      countRef.current = 0;
      scene.traverse((object) => { if (object instanceof THREE.Points) { object.geometry.dispose(); object.material.dispose(); } });
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [modelUrl]);

  useEffect(() => { cameraPoseRef.current = cameraPose; if (cameraPose && cameraRef.current && controlsRef.current) applyCameraPose(cameraRef.current, controlsRef.current, cameraPose, targetRef.current); }, [cameraPose]);
  useEffect(() => { rangeRef.current = range; geometryRef.current?.setDrawRange(0, Math.max(1, Math.floor(countRef.current * range / 100))); }, [range]);

  return <div className="stream-point-viewer"><div className="stream-point-canvas" ref={canvasHostRef} />{state !== 'ready' && <div className="stream-point-state">{state === 'loading' ? '加载实时点云…' : '点云预览加载失败'}</div>}</div>;
}

export function PointCloudAssetPreview({ previewUrl, range }: { previewUrl: string; range: number }) {
  const [asset, setAsset] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    const manifestUrl = new URL(previewUrl, window.location.href).toString();
    void fetch(manifestUrl, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('预览资产清单不可用');
        const manifest = await response.json() as PreviewManifest;
        const assets = (manifest.assets ?? []).filter((asset) => asset.url && asset.name?.toLowerCase().endsWith('.ply'));
        const latest = assets.at(-1);
        if (!latest?.url) throw new Error('尚未生成点云预览');
        if (!cancelled) setAsset({ url: new URL(latest.url, manifestUrl).toString() });
      })
      .catch((cause: unknown) => { if (!cancelled) setAsset({ error: cause instanceof Error ? cause.message : '预览资产加载失败' }); });
    return () => { cancelled = true; };
  }, [previewUrl]);

  if (!asset.url) return <div className="stream-point-viewer"><div className="stream-point-state">{asset.error || '正在读取点云预览…'}</div></div>;
  return <PointCloudPreview modelUrl={asset.url} range={range} />;
}
