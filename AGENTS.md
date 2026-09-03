# Gaussian 工程流程

## 目录约定

本项目按运行职责拆分为 `front/`、`backend/`、`engines/`、`docs/`、`scripts/` 和 `docker/`。源码、部署脚本和文档都以项目根目录为相对基准，不写死某台机器的绝对路径。

```text
gaussian/
├── front/                 # Node/vinext 前端
├── backend/               # FastAPI + GPU Worker
├── engines/
│   ├── colmap/            # COLMAP 源码
│   └── brush/             # Brush 源码
├── docs/                  # 架构、流程、Ubuntu 部署、方案文档
├── scripts/               # 部署与引擎安装脚本
├── docker/                # 单镜像 GPU 容器定义
├── AGENTS.md              # 本文件
└── README.md              # 项目入口
```

详细职责见 `docs/folder-layout.md`，建模链路见 `docs/architecture.md`。

## 建模链路

```text
浏览器 → front → backend API → GPU Worker
       → FFmpeg 抽帧
       → COLMAP 特征/匹配/Mapper
       → Brush 训练 Gaussian
       → output/final.ply
       → SSE 进度 → front 下载模型
```

COLMAP 负责相机位姿和稀疏重建，Brush 负责 Gaussian 训练；API/Worker 负责任务编排、状态、日志和产物校验。

## Ubuntu 部署流程

项目的 COLMAP、Brush、FastAPI 和前端服务由宿主机手动安装并长期运行。本仓库只为新增模块提供独立脚本：

```bash
chmod +x scripts/setup-supersplat-ubuntu.sh
APP_DIR="$PWD" ./scripts/setup-supersplat-ubuntu.sh
```

代码更新和容器重启使用 `scripts/update-and-restart-ready.sh`；不要重新执行已移除的全链路安装脚本。

新增模块只执行其对应脚本，避免影响已经运行的服务。

所有脚本都默认通过自身位置计算项目根目录；如脚本和项目不在同一目录，可显式传入 `APP_DIR=/path/to/gaussian`。

如果宿主机 APT 依赖异常，优先使用 Docker GPU 部署：

```bash
docker compose -p gaussian -f docker/compose.yml up -d --build
```

容器方案说明见 `docs/container-deployment.md`。

## 验收标准

- `nvidia-smi` 正常；编译 COLMAP 时 `nvcc` 可用。
- `gaussian-api` 的 `/health` 返回成功。
- `gaussian-web` 能打开前端页面。
- 上传视频或图片后，任务依次经过抽帧、COLMAP、Brush、导出阶段。
- 只有有效且顶点数大于 0 的 `output/final.ply` 才能标记任务完成。
- 修改后端执行 `python -m py_compile backend/app.py`；修改前端执行 `cd front && npm run lint && npm run build`。
- Bash 脚本必须在 Ubuntu 执行 `bash -n scripts/<script>.sh` 验证。

## 修改边界

- 前端接口改动必须同步检查 `front/app/page.tsx` 和 `backend/app.py`。
- 引擎源码仅在确有必要时修改，优先通过脚本参数和环境变量配置。
- 运行时数据使用独立的 `GAUSSIAN_DATA_ROOT`，不要写入源码目录或提交到仓库。
- 不提交 `front/node_modules`、`front/.next`、`backend/.venv`、COLMAP `build`、Brush `target` 和任务数据。
