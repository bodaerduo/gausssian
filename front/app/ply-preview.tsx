'use client';

import { useEffect, useRef, useState } from 'react';

type GaussianViewer = {
  addSplatScene: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  start: () => void;
  render: () => void;
  dispose: () => Promise<void> | void;
};

type GaussianSplatsModule = {
  Viewer: new (options?: Record<string, unknown>) => GaussianViewer;
  SceneFormat: { Ply: number };
};

type PreviewCapture = () => string | undefined;

export function PlyPreview({ modelUrl, modelName, compact = false, onCaptureReady }: { modelUrl?: string; modelName: string; compact?: boolean; onCaptureReady?: (capture: PreviewCapture | undefined) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onCaptureReadyRef = useRef(onCaptureReady);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => { onCaptureReadyRef.current = onCaptureReady; }, [onCaptureReady]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !modelUrl) {
      setState('error');
      setError('没有可用的 PLY 资产');
      return undefined;
    }

    let cancelled = false;
    let viewer: GaussianViewer | undefined;
    let captureFrame = 0;
    setState('loading');
    setError('');
    onCaptureReadyRef.current?.(undefined);
    container.replaceChildren();

    void import('@mkkellogg/gaussian-splats-3d').then(async (module) => {
      if (cancelled) return;
      const { Viewer, SceneFormat } = module as unknown as GaussianSplatsModule;
      viewer = new Viewer({
        rootElement: container,
        cameraUp: [0, 1, 0],
        initialCameraPosition: [0, 0.2, 3.8],
        initialCameraLookAt: [0, 0, 0],
        useBuiltInControls: !compact,
        sharedMemoryForWorkers: false,
        gpuAcceleratedSort: false,
        integerBasedSort: false,
        sphericalHarmonicsDegree: 2,
        maxScreenSpaceSplatSize: 256,
        logLevel: 0,
      });
      await viewer.addSplatScene(modelUrl, {
        format: SceneFormat.Ply,
        // Brush exports the COLMAP scene with the opposite vertical axis from the web viewer.
        rotation: [1, 0, 0, 0],
        showLoadingUI: false,
        progressiveLoad: true,
        splatAlphaRemovalThreshold: 5,
      });
      if (cancelled) {
        await viewer.dispose();
        viewer = undefined;
        return;
      }
      viewer.start();
      setState('ready');
      const capture: PreviewCapture = () => {
        const canvas = container.querySelector('canvas');
        if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) return undefined;
        try {
          // The viewer uses a WebGL canvas whose back buffer may be cleared
          // after a frame. Render immediately before reading it so card covers
          // never capture the initial black clear frame.
          viewer?.render();
          return canvas.toDataURL('image/jpeg', 0.82);
        } catch { return undefined; }
      };
      captureFrame = window.requestAnimationFrame(() => {
        captureFrame = window.requestAnimationFrame(() => {
          window.setTimeout(() => onCaptureReadyRef.current?.(capture), 350);
        });
      });
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setState('error');
        setError(cause instanceof Error ? cause.message : 'PLY 预览失败');
      }
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(captureFrame);
      onCaptureReadyRef.current?.(undefined);
      if (viewer) void viewer.dispose();
      container.replaceChildren();
    };
  }, [compact, modelUrl]);

  return (
    <div className="ply-preview" aria-label={`${modelName} Gaussian PLY 模型预览`}>
      <div className="ply-viewer-root" ref={containerRef} />
      {state !== 'ready' && (
        <div className="ply-preview-state">
          <strong>{state === 'loading' ? '正在加载 Gaussian 场景…' : '无法预览 PLY'}</strong>
          {state === 'error' && <span>{error}</span>}
        </div>
      )}
      {state === 'ready' && <span className="ply-preview-badge">真实 3DGS · 左键拖拽旋转 · 滚轮缩放</span>}
    </div>
  );
}
