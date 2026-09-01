'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type FileKind = 'video' | 'images';
type JobStatus = 'idle' | 'queued' | 'processing' | 'completed' | 'failed';
type Stage = 'upload' | 'frames' | 'colmap' | 'brush' | 'validate';
type View = 'new' | 'models';
type SelectedFile = { name: string; size: number; kind: FileKind; file?: File };
type ModelRecord = { id: string; name: string; createdAt: string; views: string; splats: string; size: string; quality: string; source: string; modelUrl?: string };

const API_BASE = process.env.NEXT_PUBLIC_GAUSSIAN_API_URL ?? '';
const API_ROOT = API_BASE.replace(/\/$/, '');
const DEMO_MODE = process.env.NEXT_PUBLIC_GAUSSIAN_DEMO !== 'false';

const stageInfo: Record<Stage, { label: string; short: string }> = {
  upload: { label: '素材检查', short: '输入' },
  frames: { label: 'FFmpeg 抽帧', short: '抽帧' },
  colmap: { label: 'COLMAP 相机重建', short: '相机' },
  brush: { label: 'Brush Gaussian 训练', short: '训练' },
  validate: { label: 'PLY 质量校验', short: '校验' },
};

const demoModels: ModelRecord[] = [
  { id: 'gs-demo-042', name: '客厅 · 展示样本', createdAt: '今天 14:22', views: '284', splats: '2.4M', size: '86.2 MB', quality: '97.9%', source: 'video / 1080p' },
  { id: 'gs-demo-038', name: '陶瓷器 · 环绕拍摄', createdAt: '昨天 18:06', views: '196', splats: '1.8M', size: '64.7 MB', quality: '94.3%', source: 'video / 4K' },
];

function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(seconds: number) { return seconds < 60 ? `${Math.round(seconds)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`; }
function absoluteUrl(url: string) { return /^https?:\/\//i.test(url) ? url : `${API_ROOT}${url}`; }
function fileKind(file: File): FileKind | undefined {
  if (file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name)) return 'video';
  if (file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(file.name)) return 'images';
  return undefined;
}

function ModelPreview({ active, modelName }: { active: boolean; modelName: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotationRef = useRef(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let frame = 0;
    const seed = modelName.length * 0.17;
    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * ratio; canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const gradient = context.createRadialGradient(width * .49, height * .42, 5, width * .5, height * .5, width * .76);
      gradient.addColorStop(0, '#214f91'); gradient.addColorStop(.53, '#112e68'); gradient.addColorStop(1, '#07142f');
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      context.strokeStyle = 'rgba(131, 201, 255, .13)';
      for (let line = 1; line < 9; line += 1) { const y = (height / 9) * line; context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
      rotationRef.current += active ? .008 : .002;
      const rotation = rotationRef.current;
      for (let index = 0; index < 420; index += 1) {
        const angle = index * 2.39996 + seed; const radius = Math.sqrt(index / 420); const x = Math.cos(angle) * radius; const y = Math.sin(angle) * radius * .7; const z = Math.sin(angle * 1.7 + seed) * .5; const depth = z * Math.sin(rotation) + x * Math.cos(rotation); const scale = 1 + depth * .28;
        const px = width * .5 + (x * Math.cos(rotation) - z * Math.sin(rotation)) * width * .39; const py = height * .5 + y * height * .47; const alpha = Math.min(.96, .3 + (depth + .5) * .52);
        context.fillStyle = index % 7 === 0 ? `rgba(190, 161, 255, ${alpha})` : `rgba(110, 238, 255, ${alpha})`; context.beginPath(); context.arc(px, py, Math.max(1, (1.15 + (index % 5) * .55) * scale), 0, Math.PI * 2); context.fill();
      }
      frame = requestAnimationFrame(draw);
    };
    draw(); return () => cancelAnimationFrame(frame);
  }, [active, modelName]);
  return <canvas ref={canvasRef} className="model-canvas" aria-label={`${modelName} Gaussian 模型预览`} />;
}

function Sidebar({ view, onViewChange }: { view: View; onViewChange: (view: View) => void }) {
  return <aside className="sidebar"><div className="side-section-label">WORKSPACE</div>
    <button className={view === 'new' ? 'side-link active' : 'side-link'} onClick={() => onViewChange('new')}><span>＋</span> 新建重建 <kbd>⌘ N</kbd></button>
    <button className="side-link"><span>◷</span> 任务历史 <em>—</em></button>
    <button className={view === 'models' ? 'side-link active' : 'side-link'} onClick={() => onViewChange('models')}><span>◇</span> 模型资产</button>
    <div className="side-section-label side-label-spaced">TOOLS</div><button className="side-link"><span>▦</span> COLMAP 数据</button><button className="side-link"><span>◌</span> GPU 监控</button>
    <div className="sidebar-bottom"><div className="worker-card"><div className="worker-card-head"><span className="status-pip" /> WORKER {DEMO_MODE ? 'DEMO' : 'ONLINE'}</div><div className="worker-name">Ubuntu · GPU Worker</div><div className="worker-metrics"><span>API <strong>{DEMO_MODE ? 'Demo' : '4178'}</strong></span><span>QUEUE <strong>1</strong></span></div></div><div className="side-footer"><span>v0.1.0</span><span>·</span><span>Ubuntu</span></div></div>
  </aside>;
}

function PageHeader({ view, onViewChange }: { view: View; onViewChange: (view: View) => void }) {
  return <div className="content-heading"><div><div className="page-kicker">{view === 'new' ? '工作台 / 新建重建' : '资产库 / 模型预览'}</div><h1>{view === 'new' ? '新建重建' : '模型预览'}</h1><p>{view === 'new' ? '选择素材，配置参数，开始建模。' : '浏览已建立的 Gaussian 模型。'}</p></div><div className="heading-actions"><div className="heading-status"><span className="status-pip" /> {DEMO_MODE ? '演示模式' : 'GPU API 已连接'}</div>{view === 'models' && <button className="outline-button" onClick={() => onViewChange('new')}>＋ 新建模型</button>}</div></div>;
}

function NewModelView({ onComplete }: { onComplete: (model: ModelRecord) => void }) {
  const [files, setFiles] = useState<SelectedFile[]>([]); const [kind, setKind] = useState<FileKind>('video'); const [quality, setQuality] = useState('balanced'); const [status, setStatus] = useState<JobStatus>('completed'); const [progress, setProgress] = useState(100); const [activeStage, setActiveStage] = useState<Stage>('validate'); const [elapsed, setElapsed] = useState(184); const [jobId, setJobId] = useState('gs-demo-042'); const [dragging, setDragging] = useState(false); const [message, setMessage] = useState('上次任务已完成，可以开始新的重建'); const [downloadUrl, setDownloadUrl] = useState(''); const [logs, setLogs] = useState(['[14:22:06] PLY 校验通过 · 2,841,006 splats', '[14:21:58] Brush 训练完成 · 30,000 iterations', '[14:20:43] COLMAP 注册 278 / 284 视图 · 97.9%']);
  const isRunning = status === 'queued' || status === 'processing'; const imageCount = files.filter((file) => file.kind === 'images').length; const totalSize = files.reduce((sum, file) => sum + file.size, 0); const statusText = { idle: '待上传', queued: '排队中', processing: '建模中', completed: '已完成', failed: '失败' }[status];
  const inputSummary = useMemo(() => !files.length ? '拖入视频，或选择一组多视角图片' : kind === 'video' ? files[0]?.name ?? '已选择视频' : `${imageCount} 张图片 · ${formatBytes(totalSize)}`, [files, imageCount, kind, totalSize]);
  useEffect(() => { if (!isRunning) return; const started = Date.now() - elapsed * 1000; const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => window.clearInterval(timer); }, [isRunning, elapsed]);
  const addFiles = (fileList: FileList | File[]) => { const incoming = Array.from(fileList).map((file) => ({ file, kind: fileKind(file) })).filter((item): item is { file: File; kind: FileKind } => Boolean(item.kind)); if (!incoming.length) return; const nextKind = incoming[0].kind; const normalized = incoming.filter((item) => item.kind === nextKind); setKind(nextKind); setFiles(nextKind === 'video' ? [{ name: normalized[0].file.name, size: normalized[0].file.size, kind: nextKind, file: normalized[0].file }] : normalized.map((item) => ({ name: item.file.name, size: item.file.size, kind: nextKind, file: item.file }))); setDownloadUrl(''); setStatus('idle'); setProgress(0); setMessage(nextKind === 'video' ? '视频已就绪，可以开始重建' : '图片组已就绪，可以开始重建'); };
  const resetFiles = () => { setFiles([]); setDownloadUrl(''); setProgress(0); setStatus('idle'); setActiveStage('upload'); setMessage('拖入视频，或选择一组多视角图片'); };
  const startDemo = () => { setDownloadUrl(''); setStatus('queued'); setProgress(4); setElapsed(0); setActiveStage('upload'); setMessage('任务已加入本地演示队列'); const started = Date.now(); const timer = window.setInterval(() => { const seconds = Math.floor((Date.now() - started) / 1000); const next = Math.min(100, 4 + seconds * 8); setElapsed(seconds); setProgress(next); setStatus(next >= 100 ? 'completed' : 'processing'); if (next < 24) setActiveStage('upload'); else if (next < 48) setActiveStage('frames'); else if (next < 72) setActiveStage('colmap'); else if (next < 95) setActiveStage('brush'); else setActiveStage('validate'); if (next >= 100) { window.clearInterval(timer); setMessage('演示建模完成，模型已加入资产库'); onComplete({ id: `gs-demo-${Date.now()}`, name: files[0]?.name?.replace(/\.[^/.]+$/, '') || '新建空间模型', createdAt: '刚刚', views: kind === 'video' ? '284' : String(imageCount), splats: '1.4M', size: '52.8 MB', quality: '94.3%', source: kind === 'video' ? 'video / 1080p' : `images / ${imageCount}` }); } }, 250); };
  const startReal = async () => { const form = new FormData(); if (kind === 'video' && files[0]?.file) form.append('videos', files[0].file); if (kind === 'images') files.forEach((item) => item.file && form.append('images', item.file)); form.append('quality', quality); setDownloadUrl(''); const response = await fetch(`${API_ROOT}/api/v1/reconstructions`, { method: 'POST', body: form }); if (!response.ok) { const detail = await response.json().catch(() => undefined) as { detail?: string } | undefined; throw new Error(detail?.detail ?? 'Ubuntu 服务端未接受任务'); } const payload = await response.json() as { id: string }; setJobId(payload.id); setStatus('queued'); setProgress(2); setElapsed(0); setActiveStage('upload'); setMessage('任务已提交到 Ubuntu GPU Worker'); const events = new EventSource(`${API_ROOT}/api/v1/reconstructions/${payload.id}/events`); events.onmessage = (event) => { const data = JSON.parse(event.data) as { progress?: number; phase?: string; message?: string; type?: string; download_url?: string; image_count?: number; ply_bytes?: number; splat_count?: number }; if (data.message) { setMessage(data.message); setLogs((current) => [`[now] ${data.message}`, ...current].slice(0, 5)); } if (data.type === 'completed') { const url = absoluteUrl(data.download_url ?? `/api/v1/reconstructions/${payload.id}/download`); setDownloadUrl(url); setStatus('completed'); setProgress(100); setActiveStage('validate'); setMessage('Ubuntu 建模完成，模型可以下载'); events.close(); onComplete({ id: payload.id, name: files[0]?.name?.replace(/\.[^/.]+$/, '') || '新建空间模型', createdAt: '刚刚', views: data.image_count ? String(data.image_count) : '—', splats: data.splat_count ? `${(data.splat_count / 1000000).toFixed(1)}M` : '—', size: data.ply_bytes ? formatBytes(data.ply_bytes) : '—', quality, source: kind === 'video' ? 'video / GPU' : `images / ${imageCount}`, modelUrl: url }); return; } if (data.type === 'failed') { setStatus('failed'); setMessage(data.message ?? '任务失败'); events.close(); return; } setStatus('processing'); setProgress(data.progress ?? 0); if (data.phase?.includes('抽帧')) setActiveStage('frames'); else if (data.phase?.includes('COLMAP') || data.phase?.includes('相机')) setActiveStage('colmap'); else if (data.phase?.includes('Gaussian') || data.phase?.includes('训练')) setActiveStage('brush'); else if (data.phase?.includes('校验')) setActiveStage('validate'); }; events.onerror = () => { events.close(); setStatus('failed'); setMessage('SSE 连接中断，请查看 API 日志'); }; };
  const startJob = () => { if (!files.length || isRunning) return; if (DEMO_MODE) startDemo(); else void startReal().catch((error: unknown) => { setStatus('failed'); setMessage(error instanceof Error ? error.message : '提交任务失败'); }); };
  void downloadUrl;
  const stages = Object.entries(stageInfo) as [Stage, { label: string; short: string }][];
  return <div className="control-grid"><div className="primary-column"><div className="panel upload-panel"><div className="panel-heading"><div><span className="panel-index">01</span><h2>选择素材</h2></div><span className="hint">MP4 · MOV · JPG · PNG</span></div><div className="mode-tabs" role="tablist" aria-label="素材类型"><button className={kind === 'video' ? 'mode-tab selected' : 'mode-tab'} onClick={() => { setKind('video'); setFiles([]); setDownloadUrl(''); }}><span className="mode-icon">▶</span> 视频</button><button className={kind === 'images' ? 'mode-tab selected' : 'mode-tab'} onClick={() => { setKind('images'); setFiles([]); setDownloadUrl(''); }}><span className="mode-icon">▧</span> 图片组</button></div><div className={dragging ? 'dropzone dragging' : 'dropzone'} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}><input id="source-files" type="file" accept={kind === 'video' ? 'video/mp4,video/quicktime,video/webm,.m4v' : 'image/jpeg,image/png,image/webp'} multiple={kind === 'images'} onChange={(event: ChangeEvent<HTMLInputElement>) => event.target.files && addFiles(event.target.files)} /><label htmlFor="source-files" className="dropzone-label"><span className="upload-symbol">↑</span><strong>{files.length ? inputSummary : `拖入${kind === 'video' ? '视频文件' : '多视角图片'}`}</strong><span>{files.length ? '点击重新选择素材' : '或点击从本机选择'}</span></label>{files.length > 0 && <button className="clear-file" onClick={resetFiles} aria-label="清除素材">×</button>}</div><div className="upload-note"><span>✦</span>{kind === 'video' ? '建议 20–60 秒，主体静止、相机缓慢环绕' : '建议 20–300 张，邻帧重叠约 60% 以上'}</div></div><div className="panel settings-panel"><div className="panel-heading"><div><span className="panel-index">02</span><h2>重建参数</h2></div><span className="hint">传给 GPU Worker</span></div><div className="setting-row"><div><strong>质量档位</strong><small>影响抽帧数量与训练步数</small></div><div className="select-wrap"><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="fast">Fast · 快速预览</option><option value="balanced">Balanced · 推荐</option><option value="high">High · 高质量</option></select><span>⌄</span></div></div><div className="setting-row"><div><strong>COLMAP GPU 加速</strong><small>特征提取与匹配使用 CUDA</small></div><div className="toggle on"><span /></div></div><div className="setting-row"><div><strong>自动清理异常 Splat</strong><small>过滤超大尺度与近透明点</small></div><div className="toggle on"><span /></div></div></div><div className="action-row"><div className="action-meta"><span className={status === 'failed' ? 'status-pip red' : 'status-pip'} />{message}</div><button className="start-button" disabled={!files.length || isRunning} onClick={startJob}>{isRunning ? '正在建模…' : '开始建模'} <span>↗</span></button></div></div><div className="secondary-column"><div className="panel progress-panel"><div className="panel-heading"><div><span className="panel-index">03</span><h2>任务进度</h2></div><span className={`job-state ${status}`}>{statusText}</span></div><div className="progress-numbers"><strong>{progress}%</strong><span>{jobId} · {formatTime(elapsed)}</span></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="stage-list">{stages.map(([stage, info], index) => { const currentIndex = stages.findIndex(([value]) => value === activeStage); const done = status === 'completed' || index < currentIndex; const current = stage === activeStage && status !== 'idle' && status !== 'completed'; return <div className={current ? 'stage-row current' : 'stage-row'} key={stage}><span className={done ? 'stage-marker done' : current ? 'stage-marker current' : 'stage-marker'}>{done ? '✓' : info.short}</span><span>{info.label}</span>{current && <span className="stage-loading">处理中</span>}{done && <span className="stage-done">完成</span>}</div>; })}</div><div className="console"><div className="console-head"><span>ENGINE LOG</span><span>{DEMO_MODE ? 'DEMO' : 'LIVE'}</span></div>{logs.map((log) => <div key={log}>{log}</div>)}</div></div></div></div>;
}

function ModelLibraryView({ models, selectedId, onSelect, onNew }: { models: ModelRecord[]; selectedId: string; onSelect: (id: string) => void; onNew: () => void }) {
  const [query, setQuery] = useState(''); const selected = models.find((model) => model.id === selectedId) ?? models[0]; const filtered = models.filter((model) => model.name.toLowerCase().includes(query.toLowerCase()));
  if (!selected) return <div className="empty-library"><div className="empty-orb">◇</div><h2>还没有模型</h2><p>上传第一段视频或图片组，开始建立你的空间资产。</p><button className="start-button" onClick={onNew}>＋ 新建模型</button></div>;
  return <div className="library-layout"><div className="library-list"><div className="library-toolbar"><div><strong>全部模型</strong><span>{models.length} 个资产</span></div><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型" /></label></div><div className="model-grid">{filtered.map((model) => <button className={model.id === selected.id ? 'model-card selected' : 'model-card'} key={model.id} onClick={() => onSelect(model.id)}><div className="card-thumb"><ModelPreview active={false} modelName={model.name} /><span className="card-type">PLY</span></div><div className="card-copy"><strong>{model.name}</strong><span>{model.createdAt} · {model.size}</span></div><div className="card-meta"><span>{model.splats} splats</span><span className="quality-dot">● {model.quality}</span></div></button>)}</div></div><div className="model-detail"><div className="detail-heading"><div><span className="eyebrow">SELECTED ASSET</span><h2>{selected.name}</h2></div><span className="detail-id">{selected.id}</span></div><div className="detail-stage"><ModelPreview active={false} modelName={selected.name} /><div className="stage-chrome"><span>3DGS / GAUSSIAN SPLAT</span><span>PLY asset</span></div></div><div className="detail-stats"><div><span>有效视图</span><strong>{selected.views}</strong></div><div><span>Splat 数量</span><strong>{selected.splats}</strong></div><div><span>质量</span><strong>{selected.quality}</strong></div><div><span>文件大小</span><strong>{selected.size}</strong></div></div><div className="detail-footer"><div><span>创建时间</span><strong>{selected.createdAt}</strong></div><div className="detail-actions"><button className="outline-button" onClick={onNew}>＋ 新建</button><button className="start-button" disabled={!selected.modelUrl} onClick={() => { if (selected.modelUrl) window.location.href = selected.modelUrl; }}>↓ 导出 PLY</button></div></div></div></div>;
}

export default function Home() {
  const [view, setView] = useState<View>('new'); const [models, setModels] = useState<ModelRecord[]>(DEMO_MODE ? demoModels : []); const [selectedId, setSelectedId] = useState(demoModels[0].id);
  useEffect(() => { if (DEMO_MODE) return; void fetch(`${API_ROOT}/api/v1/reconstructions`).then((response) => response.json()).then((payload: { jobs?: Array<{ id: string; status?: string; created_at?: string; modelUrl?: string; image_count?: number; ply_bytes?: number; quality?: string }> }) => { const remote = (payload.jobs ?? []).filter((job) => job.status === 'completed').map((job) => ({ id: job.id, name: `重建模型 · ${job.id.slice(0, 8)}`, createdAt: job.created_at ? new Date(job.created_at).toLocaleString('zh-CN') : '—', views: job.image_count ? String(job.image_count) : '—', splats: '—', size: job.ply_bytes ? formatBytes(job.ply_bytes) : '—', quality: job.quality ?? '—', source: 'Ubuntu GPU', modelUrl: absoluteUrl(job.modelUrl ?? `/api/v1/reconstructions/${job.id}/download`) })); if (remote.length) { setModels(remote); setSelectedId(remote[0].id); } }).catch(() => undefined); }, []);
  const addModel = (model: ModelRecord) => { setModels((current) => [model, ...current]); setSelectedId(model.id); };
  return <main className="app-shell"><header className="topbar"><div className="brand-lockup"><div className="brand-mark">G</div><div><div className="brand-name">gaussian</div><div className="brand-caption">reconstruction workspace</div></div></div><div className="topbar-center"><span className="live-dot" /> Ubuntu GPU Worker <span className="muted-dot">·</span> {DEMO_MODE ? '演示模式' : 'API 已连接'}</div><div className="topbar-actions"><button className="icon-button" aria-label="打开设置">⚙</button><div className="avatar">SK</div></div></header><div className="workspace"><Sidebar view={view} onViewChange={setView} /><section className="content-pane"><PageHeader view={view} onViewChange={setView} />{view === 'new' ? <NewModelView onComplete={addModel} /> : <ModelLibraryView models={models} selectedId={selectedId} onSelect={setSelectedId} onNew={() => setView('new')} />}<footer className="page-footer"><span>GAUSSIAN / VIDEO TO SPLATS</span><span>服务端接口：{DEMO_MODE ? '未配置 · 当前为演示模式' : API_BASE || '同源 API'}</span><span>{DEMO_MODE ? 'Demo worker' : 'GPU worker ready'}</span></footer></section></div></main>;
}
