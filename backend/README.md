# Gaussian GPU API

这是前端所需的最小可运行 GPU API/Worker。API 接收视频或图片组，Worker 在后台串行执行：

1. 视频通过 FFmpeg 按质量档位抽帧；
2. COLMAP 提取特征、匹配并生成 `dataset/sparse/0`；
3. Brush 读取 `dataset/images + dataset/sparse/0`，训练并导出 `output/final.ply`；
4. API 通过 SSE 推送进度，并提供 PLY 下载。

生产环境使用 `setup-backend-ubuntu.sh` 创建 Python venv 和 systemd 服务。Brush 二进制路径通过 `BRUSH_BIN` 配置，默认是 `/usr/local/bin/brush-cli`。
