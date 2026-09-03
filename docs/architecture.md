# Gaussian 建模架构与流程

## 系统边界

```text
Browser
  │  视频 / 图片上传
  ▼
front（Node/vinext）
  │  POST /api/v1/reconstructions
  │  GET  /api/v1/reconstructions/{id}/events（SSE）
  ▼
backend（FastAPI + GPU Worker）
  ├─ FFmpeg：视频缩放至最长边默认 1920 像素并抽帧、ffprobe：媒体校验
  ├─ COLMAP：特征提取、匹配、Mapper 稀疏重建
  └─ Brush：读取 COLMAP 数据，训练并导出 final.ply
```

## 一次任务的状态流转

```text
queued → extracting → reconstructing → training → exporting → completed
                                                        └→ failed
```

后端把每个任务保存到 `GAUSSIAN_DATA_ROOT/<task_id>/`：

```text
<task_id>/
├── uploads/             # 原始视频或图片
├── frames/              # 视频抽帧结果
├── colmap/              # COLMAP 工作目录
│   ├── database.db
│   └── sparse/0/
├── dataset/             # Brush 输入
│   ├── images/
│   └── sparse/0/
└── output/final.ply     # 最终模型
```

## 组件职责

- `front/`：上传任务、选择质量、显示实时进度、下载 PLY。
- `backend/`：校验输入、创建任务、编排命令、推送 SSE、提供模型下载。
- `engines/colmap/`：COLMAP 官方源码；安装后通常得到 `/usr/local/bin/colmap`。
- `engines/brush/`：Brush 官方源码；安装后通常得到 `/usr/local/bin/brush-cli`。
- `scripts/`：只负责 Ubuntu 安装、构建和 systemd 部署，不承载业务逻辑。
- `docs/`：架构、流程、部署和方案记录。

## 成功判定

任务只有同时满足以下条件才会标记 `completed`：

1. COLMAP 生成 `cameras.bin`、`images.bin`、`points3D.bin`。
2. Brush 退出码为 0。
3. `output/final.ply` 存在、格式有效且顶点数大于 0。

## API 最小契约

- `POST /api/v1/reconstructions`：上传 `videos` 或 `images`，并传 `quality=fast|balanced|high`。
- `GET /api/v1/reconstructions`：任务列表。
- `GET /api/v1/reconstructions/{id}`：任务状态和进度。
- `GET /api/v1/reconstructions/{id}/events`：SSE 实时事件。
- `GET /api/v1/reconstructions/{id}/download`：下载 `final.ply`。
- `GET /health`：服务和工具链健康检查。
