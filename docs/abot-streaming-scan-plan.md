# ABot-Recon 流式扫描实现规划

## 目标

把 ABot-Recon 做成一条独立的实时预览产品线：用户上传或接入视频后，视频持续播放；Worker 按顺序消费帧，点云、相机轨迹和置信度同步更新；用户可拖动时间轴和扫描范围查看当前区域。它先解决“马上看到扫描结果”，不替换现有 Brush + SuperSplat 最终 Gaussian 生产链。

## 用户体验

```text
选择视频
  ↓
视频开始播放 ────────────────┐
  ↓                          │ 同步
抽帧/窗口排队 → ABot 12 帧推理 → 点云/轨迹/置信度增量预览
  ↓                          │
拖动时间轴、扫描范围 ─────────┘
```

用户不需要理解“局部上下文”或“相对位姿”，只需要看到：

- 左侧视频正在播放；
- 右侧扫描范围从小到大逐步铺开；
- 相机路线跟着视频移动；
- 低置信度区域可以被隐藏或降低透明度；
- 滑动时间轴可以回看某个时刻；
- 滑动扫描范围可以控制当前查看窗口大小。

## 第一版范围（ABot POC）

### 必须有

1. 视频文件上传，支持 MP4/MOV/WebM；
2. 服务端按质量档位抽帧，不等待完整视频处理完才返回；
3. ABot Worker 以固定 12 帧上下文连续推理；
4. 每 32～64 帧输出一份普通 RGB 点云预览；
5. SSE 事件推送 `frame`、`point_count`、`confidence`、`preview_url`；
6. 全屏双栏界面：左视频、右点云/轨迹；
7. 播放进度和扫描范围滑块；
8. 预览失败与 Brush 任务状态隔离。

### 暂不做

- 不把 ABot 输出伪装成 Gaussian PLY；
- 不在主 API 进程 import `torch` 或 ABot 包；
- 不在第一版开启 loop closure；
- 不做手机摄像头 WebRTC/RTSP，先用视频文件验证完整链路；
- 不把 ABot 预览自动送入 Brush，除非用户明确选择“继续生成最终 Gaussian”。

## 服务边界

主 API 保持任务编排，ABot Worker 使用独立容器和 Python 环境。

```text
POST /api/v1/reconstructions
  route=abot_recon_poc

主 API → 抽帧目录/任务元数据 → abot-worker
abot-worker → SSE/Webhook 或共享 events.ndjson
主 API → 浏览器 SSE
```

推荐的事件格式：

```json
{
  "type": "preview",
  "route": "abot_recon_poc",
  "frame": 128,
  "timestamp": 12.8,
  "point_count": 184320,
  "confidence": 0.82,
  "trajectory": [1.2, 0.4, -0.8],
  "preview_url": "/api/v1/reconstructions/gs-123/preview/points-0004.ply"
}
```

产物目录：

```text
<job_id>/
├── source/                 # 原视频
├── frames/                 # 增量抽帧，可按窗口清理
├── preview/                # 浏览器直接读取的普通点云
│   ├── points-0001.ply
│   ├── points-0002.ply
│   └── trajectory.json
└── products/abot_recon_poc/
    ├── camera_poses.npy
    ├── confidence.pt
    └── metadata.json
```

## 阶段拆分

### P0：前端交互骨架（当前）

- 新增“流式扫描”菜单；
- 全屏视频/扫描双栏布局；
- 视频播放、进度条、扫描范围滑块；
- Worker 未连接时明确显示“实时点云预览位”。

### P1：离线视频的准实时 Worker

- API 接收视频后立即开始抽帧；
- ABot 基础推理关闭 loop closure；
- 每个窗口落盘 PLY 和轨迹；
- SSE 推送进度和预览 URL；
- 用 30～60 秒视频测首帧延迟、持续 FPS、显存峰值。

### P2：播放器与推理时钟对齐

- 视频播放时间作为 UI 主时钟；
- Worker 事件带 `timestamp/frame`，前端只展示不超过当前播放位置的结果；
- 推理落后时显示“扫描处理中”，不阻塞视频播放；
- 拖动时间轴时读取最近的预览快照，而不是重新训练。

### P3：现场输入和质量增强

- 接入摄像头、WebRTC 或 RTSP；
- 增加置信度阈值和回环优化开关；
- 多 GPU 队列和断点恢复；
- 可选“继续生成最终 Gaussian”，把原视频交给 Brush。

## 可量化验收标准

| 指标 | P1 目标 | 测量方式 |
|---|---:|---|
| 首个预览出现 | 视频开始后 5 秒内 | SSE 第一条 `preview` 时间戳 |
| 预览更新间隔 | 不超过 3 秒 | 相邻 `preview` 事件间隔 |
| 视频播放 | 不被 Worker 阻塞 | 浏览器播放连续 30 秒无卡顿 |
| 滑块响应 | 100 ms 内更新 UI | 前端性能面板 |
| 资产隔离 | 不生成/覆盖 `output/final.ply` | 任务目录检查 |
| Brush 回归 | 原标准任务成功率不下降 | 同一测试素材跑前后对比 |

## 当前实现入口

- 菜单：`front/app/page.tsx` 中的“流式扫描”；
- 页面：`front/app/streaming-scan/page.tsx`；
- 样式：`front/app/globals.css` 的 `.streaming-scan-*`；
- 后端路由契约：`backend/app.py` 的 `abot_recon_poc`；
- 预览下载：`/api/v1/reconstructions/{job_id}/preview`。

