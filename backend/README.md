# Gaussian GPU API

这是前端所需的最小可运行 GPU API/Worker。API 接收视频或图片组，Worker 在后台串行执行：

1. 视频先由 FFmpeg 按质量档位限制在 854×480 / 1280×720 / 1920×1080 像素（快速/推荐/高质量，保持比例），再按 2/4/6 FPS 抽帧；Brush 训练分辨率同步为 480/720/1080；可通过 `GAUSSIAN_VIDEO_MAX_DIMENSION` 设置更低的全局上限以进一步提速；
2. COLMAP 提取特征、匹配并生成 `dataset/sparse/0`；
3. Brush 读取 `dataset/images + dataset/sparse/0`，训练并导出 `output/final.ply`；
4. API 通过 SSE 推送进度，并提供 PLY 下载。

生产环境的 Python、COLMAP、Brush 和 systemd 服务由宿主机手动安装并运行。新增模块使用仓库根目录下对应的独立脚本；Brush 二进制路径通过 `BRUSH_BIN` 配置，默认是 `/usr/local/bin/brush-cli`。

运行时日志写入 `GAUSSIAN_DATA_ROOT/logs/YYYY-MM-DD.log`，按服务器本地日期每天切换；每个任务目录仍保留 `worker.log`，用于查看该任务的完整命令输出。默认数据目录为项目下的 `runtime/data`，生产环境建议将 `GAUSSIAN_DATA_ROOT` 指向独立数据盘。
