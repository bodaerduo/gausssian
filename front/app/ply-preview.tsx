'use client';

import { useEffect, useRef, useState } from 'react';

type GaussianViewer = {
  addSplatScene: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  start: () => void;
  dispose: () => Promise<void> | void;
};

type GaussianSplatsModule = {
  Viewer: new (options?: Record<string, unknown>) => GaussianViewer;
  SceneFormat: { Ply: number };
};

export function PlyPreview({ modelUrl, modelName, compact = false }: { modelUrl?: string; modelName: string; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !modelUrl) {
      setState('error');
      setError('没有可用的 PLY 资产');
      return undefined;
    }

    let cancelled = false;
    let viewer: GaussianViewer | undefined;
    setState('loading');
    setError('');
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
        showLoadingUI: false,
        progressiveLoad: false,
        splatAlphaRemovalThreshold: 5,
      });
      if (cancelled) return;
      viewer.start();
      setState('ready');
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setState('error');
        setError(cause instanceof Error ? cause.message : 'PLY 预览失败');
      }
    });

    return () => {
      cancelled = true;
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
      {state === 'ready' && <span className="ply-preview-badge">真实 3DGS · 拖拽旋转</span>}
    </div>
  );
}
