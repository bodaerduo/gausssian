# 文件夹说明

```text
gaussian/
├── front/                 # Node/vinext 前端
│   ├── app/               # 页面、上传交互、模型库
│   ├── public/            # 静态资源
│   └── package.json       # Node 依赖和构建命令
├── backend/               # FastAPI + GPU Worker
│   ├── app.py             # API、任务状态、COLMAP/Brush 编排
│   ├── requirements.txt   # Python 依赖
│   └── .env.example       # 后端配置模板
├── engines/
│   ├── colmap/            # 官方 COLMAP 源码，不放业务代码
│   └── brush/             # 官方 Brush 源码，不放业务代码
├── docs/                  # Markdown 文档
│   ├── architecture.md    # 架构和建模链路
│   ├── folder-layout.md   # 目录职责
│   ├── ubuntu-deployment.md # Ubuntu 部署
│   └── 视频重建Gaussian方案对比与推荐.md # 方案调研
├── scripts/               # Bash 部署和引擎安装脚本
│   ├── deploy-all-ubuntu.sh
│   ├── deploy-front-ubuntu.sh
│   ├── setup-backend-ubuntu.sh
│   ├── setup-colmap-ubuntu.sh
│   └── setup-brush-ubuntu.sh
├── AGENTS.md              # 协作约束、验收标准和流程
└── README.md              # 项目入口说明
```

运行时数据不应提交源码，生产环境推荐使用独立的 `GAUSSIAN_DATA_ROOT`，例如 `/var/lib/gaussian/data`。以下目录不应提交：`front/node_modules`、`front/.next`、`backend/.venv`、`engines/colmap/build`、`engines/brush/target` 和任务数据目录。
