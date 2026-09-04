import Link from 'next/link';

type RouteTone = 'production' | 'abot' | 'lingbot';

function RouteAnimation({ tone }: { tone: RouteTone }) {
  if (tone === 'production') {
    return <div className="route-animation production-animation" aria-label="素材逐步训练成 Gaussian" role="img"><span className="flow-track" /><span className="flow-node node-input">素材</span><span className="flow-node node-camera">相机</span><span className="flow-node node-splat">Gaussian</span><span className="flow-particle particle-one" /><span className="flow-particle particle-two" /><span className="flow-particle particle-three" /></div>;
  }
  if (tone === 'abot') {
    return <div className="route-animation abot-animation" aria-label="连续扫描视频帧并生成轨迹" role="img"><span className="scan-window" /><span className="scan-line" /><span className="scan-point point-one" /><span className="scan-point point-two" /><span className="scan-point point-three" /><span className="scan-path" /><span className="scan-camera">＋</span><span className="scan-label">12 帧窗口</span></div>;
  }
  return <div className="route-animation lingbot-animation" aria-label="空间地图不断扩展并记录相机路线" role="img"><span className="map-grid" /><span className="map-ring ring-one" /><span className="map-ring ring-two" /><span className="map-route" /><span className="map-camera">◇</span><span className="map-label">空间地图</span></div>;
}

const products = [
  {
    id: 'brush_static',
    eyebrow: 'PRODUCTION / DEFAULT',
    title: '标准 Gaussian 建模',
    description: '现有 FFmpeg → COLMAP → Brush → final.ply 主链，继续负责稳定交付和 SuperSplat 编辑。',
    flow: '视频先抽帧，再估计相机，最后训练出可编辑的 Gaussian；完成后可自由漫游。',
    pros: '质量和兼容性最好，能进入 SuperSplat 做后期编辑。',
    limits: '首屏要等完整处理；它的实时感主要在生成后的漫游，不是边拍边建图。',
    features: ['稳定生成 final.ply', 'SuperSplat 编辑', 'PLY / SOG 版本管理'],
    state: '已上线',
    tone: 'production',
  },
  {
    id: 'abot_recon_poc',
    eyebrow: 'LAB / POC',
    title: 'ABot-Recon 流式扫描',
    description: '固定 12 帧局部上下文，逐窗口输出点图、相机轨迹和置信度；适合先做实时视频接入 POC。',
    flow: '视频播放到哪，就扫描到哪；最近 12 帧组成小窗口，点云和轨迹逐段铺开。',
    pros: '接入快、显存和状态更可控，适合低延迟预览与服务化。',
    limits: '长距离主要靠轨迹累积，可能有漂移；输出是普通点云，不是 Gaussian。',
    features: ['点云逐步增长', '相机轨迹', '置信度过滤', '可选回环优化'],
    state: '待启用 GPU Worker',
    tone: 'abot',
  },
  {
    id: 'lingbot_map',
    eyebrow: 'SHOWCASE / LONG VIDEO',
    title: 'LingBot-Map 空间地图',
    description: '面向长视频的空间扫描体验，重点是让观众看到“地图正在生成”，支持 Viser 交互、鸟瞰/跟随镜头和点云飞行回放。',
    flow: '相机一边移动，地图一边扩张；新区域持续接入，旧区域由轨迹记忆保持连贯。',
    pros: '展示感最强：能同时看到相机路线、地图扩张和扫描进度，适合大屏演示。',
    limits: '显存、模型和可视化依赖更重，部署成本高于 ABot-Recon。',
    features: ['长视频滑窗推理', '轨迹与点云', '鸟瞰/跟随镜头', '天空遮罩'],
    state: '待启用 GPU Worker',
    tone: 'lingbot',
  },
];

export default function ProductRoutesPage() {
  return (
    <main className="product-routes-page">
      <header className="product-routes-header">
        <div>
          <span className="eyebrow">GAUSSIAN / PRODUCT ROUTES</span>
          <h1>实验室路线</h1>
          <p>扩展实时扫描与空间地图体验，不改变现有 Brush 和 SuperSplat 资产链。</p>
        </div>
        <Link className="outline-button" href="/">返回工作台</Link>
      </header>
      <section className="product-route-grid" aria-label="产品路线">
        {products.map((product) => (
          <article className={`product-route-card ${product.tone}`} key={product.id}>
            <div className="product-route-card-top">
              <span className="product-route-index">{product.id === 'brush_static' ? '01' : product.id === 'abot_recon_poc' ? '02' : '03'}</span>
              <span className="product-route-state">{product.state}</span>
            </div>
            <RouteAnimation tone={product.tone as RouteTone} />
            <span className="product-route-eyebrow">{product.eyebrow}</span>
            <h2>{product.title}</h2>
            <p>{product.description}</p>
            <div className="product-route-story">
              <div><span>怎么工作</span><strong>{product.flow}</strong></div>
              <div className="story-compare"><span><i>优势</i>{product.pros}</span><span><i>取舍</i>{product.limits}</span></div>
            </div>
            <ul>
              {product.features.map((feature) => <li key={feature}>{feature}</li>)}
            </ul>
            <div className="product-route-footer"><code>{product.id}</code><Link className="route-launch" href={`/?route=${product.id}`}>{product.tone === 'production' ? '进入建模' : '开始 POC'}</Link></div>
          </article>
        ))}
      </section>
      <section className="route-choice-strip" aria-label="路线选择建议">
        <div><span>想要最终可编辑模型</span><strong>选标准 Gaussian</strong><small>完成后高质量漫游和 SuperSplat 编辑</small></div>
        <div><span>想边播边看扫描进度</span><strong>选 ABot-Recon</strong><small>最快接入，点云逐段出现</small></div>
        <div><span>想做最酷的空间展示</span><strong>选 LingBot-Map</strong><small>地图持续展开，适合漫游演示</small></div>
      </section>
      <section className="product-route-note">
        <strong>资产边界</strong>
        <span>ABot-Recon / LingBot-Map 先产生普通点云预览；只有 Brush 生成并校验的 Gaussian PLY 才进入 SuperSplat 编辑。</span>
      </section>
    </main>
  );
}
