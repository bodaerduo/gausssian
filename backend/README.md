# Gaussian GPU API

这是前端所需的最小可运行 GPU API/Worker。API 接收视频或图片组，Worker 在后台串行执行：

1. 视频先由 FFmpeg 将最长边默认限制为 1920 像素（1080p 级别，保持比例、不放大小视频），再按质量档位抽帧；可通过 `GAUSSIAN_VIDEO_MAX_DIMENSION=1280` 进一步降低分辨率以提速；
2. COLMAP 提取特征、匹配并生成 `dataset/sparse/0`；
3. Brush 读取 `dataset/images + dataset/sparse/0`，训练并导出 `output/final.ply`；
4. API 通过 SSE 推送进度，并提供 PLY 下载。

生产环境使用 `setup-backend-ubuntu.sh` 创建 Python venv 和 systemd 服务。Brush 二进制路径通过 `BRUSH_BIN` 配置，默认是 `/usr/local/bin/brush-cli`。

运行时日志写入 `GAUSSIAN_DATA_ROOT/logs/YYYY-MM-DD.log`，按服务器本地日期每天切换；每个任务目录仍保留 `worker.log`，用于查看该任务的完整命令输出。默认数据目录为项目下的 `runtime/data`，生产环境建议将 `GAUSSIAN_DATA_ROOT` 指向独立数据盘。
