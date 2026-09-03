# 引擎目录

这里是官方引擎源码的本地缓存位置，源码本身不纳入本项目 Git：

- `colmap/`、`brush/`：现有服务由宿主机手动安装，目录仅作为已有源码缓存。
- `supersplat/`：由 `scripts/setup-supersplat-ubuntu.sh` 拉取并构建 SuperSplat。

这样可以避免重复推送上游源码；只有新增模块脚本会创建或更新对应目录。
