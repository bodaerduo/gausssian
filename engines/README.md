# 引擎目录

这里是官方引擎源码的部署位置，但源码本身不纳入本项目 Git：

- `colmap/`：由 `scripts/setup-colmap-ubuntu.sh` 拉取或使用服务器已有源码。
- `brush/`：由 `scripts/setup-brush-ubuntu.sh` 拉取或使用服务器已有源码。

这样可以避免重复推送上游源码；部署时脚本会自动创建对应目录并完成构建。
