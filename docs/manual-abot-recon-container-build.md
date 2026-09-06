# ABot-Recon 容器手动安装文档

ABot-Recon 现在统一使用 `docker/compose-abot.yml` 管理，不再使用 Dockerfile。

请直接阅读：

[`ABot-Recon：使用 compose-abot.yml 手动封装并启动`](./abot-compose-manual-tutorial.md)

新教程覆盖完整流程：

1. 复用 `gaussian:deps`；
2. 通过 Compose 启动手动安装模式；
3. 安装 PyTorch 2.5.1、ABot-Recon 和 Worker API；
4. 下载并缓存 Hugging Face 模型；
5. 验证 GPU、Worker 健康检查和容器间网络；
6. `docker commit` 提交固定镜像；
7. 启动服务并在 `/streaming-scan` 页面验证真实调用。
