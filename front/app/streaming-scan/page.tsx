'use client';

import Link from 'next/link';
import { ChangeEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { PointCloudPreview } from './point-cloud-preview';

const API_ROOT = (process.env.NEXT_PUBLIC_GAUSSIAN_API_URL ?? '').replace(/\/$/, '');

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const rest = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

export default function StreamingScanPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoFrameRef = useRef<HTMLDivElement>(null);
  const scanFrameRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const [selectedFile, setSelectedFile] = useState<File>();
  const [videoUrl, setVideoUrl] = useState<string>();
  const [fileName, setFileName] = useState('未选择视频');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [scanRange, setScanRange] = useState(64);
  const [isPlaying, setIsPlaying] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [workerMessage, setWorkerMessage] = useState('ABot Worker 待连接');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); eventsRef.current?.close(); }, [videoUrl]);

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const pointCount = Math.round(1800 + progress * 82);
  const status = videoUrl ? (isPlaying ? '正在扫描 · Worker 预览位' : '已就绪 · 点击播放开始') : '等待输入视频';
  const pointCloud = useMemo(() => Array.from({ length: 260 }, (_, index) => {
    const seed = (index * 9301 + 49297) % 233280 / 233280;
    const angle = seed * Math.PI * 2;
    const radius = Math.sqrt(((index * 37) % 260) / 260);
    const x = 50 + Math.cos(angle) * (radius * 35 + (index % 7) * .7);
    const y = 51 + Math.sin(angle) * (radius * 25 + (index % 5) * .5);
    return { x, y, r: 1.1 + (index % 4) * .35, opacity: .3 + (index % 6) * .1, delay: `${(index % 18) * .08}s`, depth: (index % 9) - 4 };
  }), []);

  const chooseVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setSelectedFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setFileName(file.name);
    setCurrentTime(0);
    setIsPlaying(false);
    setPreviewUrl(undefined);
    setJobId(undefined);
    setWorkerMessage('视频已就绪');
  };

  const togglePlayback = () => {
    if (!videoRef.current || !videoUrl) return;
    if (videoRef.current.paused) void videoRef.current.play();
    else videoRef.current.pause();
  };

  const seek = (value: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const enterFullscreen = (element: HTMLElement | null) => {
    if (!element) return;
    if (document.fullscreenElement === element) { void document.exitFullscreen(); return; }
    void element.requestFullscreen();
  };

  const startScan = async () => {
    if (!selectedFile || submitting) return;
    setSubmitting(true);
    setWorkerMessage('正在提交 ABot 任务');
    const form = new FormData();
    form.append('videos', selectedFile);
    form.append('quality', 'fast');
    form.append('route', 'abot_recon_poc');
    try {
      const response = await fetch(`${API_ROOT}/api/v1/reconstructions`, { method: 'POST', body: form });
      if (!response.ok) { const payload = await response.json().catch(() => undefined) as { detail?: string } | undefined; throw new Error(payload?.detail ?? 'ABot 服务未接受任务'); }
      const payload = await response.json() as { id: string };
      setJobId(payload.id);
      setWorkerMessage('ABot 正在准备视频帧');
      eventsRef.current?.close();
      const events = new EventSource(`${API_ROOT}/api/v1/reconstructions/${payload.id}/events`);
      eventsRef.current = events;
      events.onmessage = (event) => {
        const data = JSON.parse(event.data) as { type?: string; message?: string; preview_url?: string; progress?: number; point_count?: number };
        if (data.message) setWorkerMessage(data.message);
        if (data.preview_url?.endsWith('.ply')) setPreviewUrl(`${API_ROOT}${data.preview_url}?t=${Date.now()}`);
        if (data.type === 'completed' || data.type === 'failed') { events.close(); setSubmitting(false); }
      };
      events.onerror = () => { events.close(); setSubmitting(false); setWorkerMessage('ABot 事件连接中断'); };
      void videoRef.current?.play();
    } catch (error) {
      setWorkerMessage(error instanceof Error ? error.message : 'ABot 任务提交失败');
      setSubmitting(false);
    }
  };

  return (
    <main className="streaming-scan-page">
      <header className="streaming-scan-header">
        <div className="streaming-brand"><span className="streaming-pulse" /><div><span className="streaming-kicker">ABOT-RECON / STREAMING SCAN</span><h1>流式扫描</h1></div></div>
        <div className="streaming-header-actions"><span className="streaming-worker-status"><i className={submitting ? 'online' : ''} /> {workerMessage}</span><Link className="streaming-back" href="/">返回工作台</Link></div>
      </header>

      <section className="streaming-stage" aria-label="视频与扫描预览">
        <div className="stream-pane video-pane">
          <div className="stream-pane-head"><span>01 / VIDEO INPUT</span><strong>{fileName}</strong></div>
          <div ref={videoFrameRef} className="video-frame" onDoubleClick={() => enterFullscreen(videoFrameRef.current)}>
            <button className="stream-frame-fullscreen" type="button" onClick={() => enterFullscreen(videoFrameRef.current)} aria-label="视频全屏查看">全屏 ↗</button>
            {videoUrl ? <video ref={videoRef} src={videoUrl} playsInline muted onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} /> : <label className="stream-drop"><input type="file" accept="video/*,.m4v" onChange={chooseVideo} /><span className="stream-drop-icon">＋</span><strong>拖入视频，开始流式扫描</strong><small>视频播放到哪里，ABot 就从哪里开始推理</small></label>}
            {videoUrl && <button className="video-play-button" type="button" onClick={togglePlayback} aria-label={isPlaying ? '暂停视频' : '播放视频'}>{isPlaying ? 'Ⅱ' : '▶'}</button>}
            <div className="video-overlay"><span>RGB / INPUT</span><span>{formatTime(currentTime)} / {formatTime(duration)}</span></div>
          </div>
        </div>

        <div className="stream-pane scan-pane">
          <div className="stream-pane-head"><span>02 / LIVE RECONSTRUCTION</span><strong>{status}</strong></div>
          <div ref={scanFrameRef} className="scan-frame" style={{ '--scan-range': `${scanRange}%`, '--scan-progress': `${progress}%` } as CSSProperties} onDoubleClick={() => enterFullscreen(scanFrameRef.current)}>
            <button className="stream-frame-fullscreen" type="button" onClick={() => enterFullscreen(scanFrameRef.current)} aria-label="模型全屏查看">全屏 ↗</button>
            <div className="scan-hud"><span>CAMERA TRAJECTORY · {pointCount.toLocaleString()} PTS</span><strong>{Math.round(progress)}%</strong></div>
            {previewUrl ? <PointCloudPreview modelUrl={previewUrl} range={scanRange} /> : <><svg className="scan-cloud" viewBox="0 0 100 100" role="img" aria-label="实时点云预览"><defs><filter id="point-glow"><feGaussianBlur stdDeviation=".7" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter><linearGradient id="trajectory-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#43cfc2" /><stop offset="1" stopColor="#7368e8" /></linearGradient></defs><g className="point-cloud-points" filter="url(#point-glow)">{pointCloud.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={point.r} fill={index % 7 === 0 ? '#7368e8' : '#39bfb8'} opacity={point.opacity} style={{ animationDelay: point.delay, '--point-depth': `${point.depth}px` } as CSSProperties} />)}</g><path className="cloud-axis" d="M50 12V89M16 51H85" /><path className="cloud-trajectory" d="M50 53 C43 48 42 39 49 35 S65 33 70 42 S67 62 57 67 S38 73 30 65" pathLength="1" /><circle className="cloud-camera" cx="50" cy="53" r="2.5" /><circle className="cloud-camera-halo" cx="50" cy="53" r="7" /></svg><div className="scan-empty-copy"><strong>{videoUrl ? '准备实时点云' : '等待视频输入'}</strong><span>{videoUrl ? '点击开始扫描，首个 ABot 预览生成后自动切换' : '当前页面先验证播放、时间轴和扫描范围交互'}</span></div></>}
            <div className="scan-frame-label">ABOT / LOCAL CONTEXT 12F</div>
          </div>
        </div>
      </section>

      <section className="streaming-controls">
        <div className="stream-timeline"><div className="timeline-label"><span>扫描进度</span><strong>{Math.round(progress)}%</strong></div><input aria-label="视频播放进度" type="range" min="0" max={duration || 1} step="0.01" value={Math.min(currentTime, duration || 1)} onChange={(event) => seek(Number(event.target.value))} /><div className="timeline-ticks"><span>开始</span><span>视频播放中 · 点云同步生成</span><span>结束</span></div></div>
        <div className="range-control"><div className="timeline-label"><span>扫描范围</span><strong>{scanRange}%</strong></div><input aria-label="扫描范围" type="range" min="20" max="100" value={scanRange} onChange={(event) => setScanRange(Number(event.target.value))} /><small>拖动调整当前查看区域大小</small></div>
      </section>

      <footer className="streaming-footer"><span>ABot-Recon POC · 固定 12 帧局部上下文</span><span>{jobId ? `任务 ${jobId}` : '输出：轨迹 / 点图 / 置信度 / 普通点云预览'}</span><span>最终 Gaussian 仍由 Brush 生产</span><button className="stream-start-button" type="button" disabled={!selectedFile || submitting} onClick={startScan}>{submitting ? '扫描中…' : '开始扫描'}</button><label className="stream-upload-button"><input type="file" accept="video/*,.m4v" onChange={chooseVideo} />更换视频</label></footer>
      <span className="streaming-api-hint">{API_ROOT ? `API ${API_ROOT}` : 'API 同源'} · preview surface</span>
    </main>
  );
}
