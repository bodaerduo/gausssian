'use client';

import { useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';

export default function EditorPage() {
  const params = useSearchParams();
  const [status, setStatus] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const load = params.get('load') ?? '';
  const jobId = params.get('id') ?? '';
  const editorLoad = load.replace(/\/download(?=($|[?#]))/, `/download/${encodeURIComponent(jobId)}.ply`);
  const src = `/supersplat/index.html${editorLoad ? `?load=${encodeURIComponent(editorLoad)}` : ''}`;
  const saveVariant = async (file?: File) => { if (!file || !jobId) return; setStatus('正在保存编辑版本…'); const form = new FormData(); form.append('file', file); const response = await fetch(`/api/v1/reconstructions/${jobId}/variants`, { method: 'POST', body: form }); if (!response.ok) { setStatus('保存失败，请确认导出的是 Gaussian PLY'); return; } const variant = await response.json() as { version: number }; const optimize = new FormData(); optimize.append('harmonics', '2'); const optimized = await fetch(`/api/v1/reconstructions/${jobId}/variants/${variant.version}/optimize`, { method: 'POST', body: optimize }); setStatus(optimized.ok ? `已保存 v${String(variant.version).padStart(3, '0')}，优化任务已排队` : '已保存编辑版本，优化任务启动失败'); if (inputRef.current) inputRef.current.value = ''; };
  return <main className="editor-shell"><header className="editor-header"><div><strong>SuperSplat</strong><span>选择、裁切、清理和优化 Gaussian 场景</span></div><div className="editor-actions"><input ref={inputRef} type="file" accept=".ply" hidden onChange={(event) => void saveVariant(event.target.files?.[0])} /><button type="button" onClick={() => inputRef.current?.click()} disabled={!jobId}>保存编辑 PLY</button>{status && <span>{status}</span>}<Link href="/">返回 gaussian</Link></div></header><iframe className="editor-frame" title="SuperSplat Gaussian 编辑器" src={src} /></main>;
}
