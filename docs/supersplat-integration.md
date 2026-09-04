# SuperSplat 集成

当前集成采用独立静态编辑器：SuperSplat 负责浏览器内选择、裁切、清理和变换；FastAPI 负责资产导入、版本保存和删除；SplatTransform 负责压缩、降采样和 SOG 导出。

## Ubuntu 宿主机部署

```bash
chmod +x scripts/*.sh
APP_DIR="$PWD" ./scripts/setup-supersplat-ubuntu.sh
```

部署脚本会额外执行：

- `setup-supersplat-ubuntu.sh`：安装 `@playcanvas/splat-transform@3.3.3` 并构建固定版本的 SuperSplat 到 `front/public/supersplat`。

生产环境建议固定版本：

```bash
SUPER_SPLAT_REF=<commit-or-tag> \
SPLAT_TRANSFORM_VERSION=3.3.3 \
./scripts/setup-supersplat-ubuntu.sh
```

## GPU 容器部署

```bash
SUPER_SPLAT_REF=<commit-or-tag> \
docker compose -p gussian -f docker/compose-gussian.yml up -d --build
```

镜像构建阶段会单独构建 SuperSplat，并将 `dist` 复制到前端静态目录；运行阶段安装 SplatTransform CLI。容器启动后编辑器地址为 `/editor`，模型详情页的“SuperSplat 编辑”按钮会带上当前 PLY URL。

## 编辑和版本接口

- `POST /api/v1/reconstructions/import`：直接导入 Gaussian PLY。
- `DELETE /api/v1/reconstructions/{id}`：删除已完成或失败任务及其资产。
- `POST /api/v1/reconstructions/{id}/variants`：保存编辑器导出的 PLY 版本。
- `POST /api/v1/reconstructions/{id}/variants/{version}/optimize`：触发压缩 PLY/SOG 优化。

原始 `output/final.ply` 不会被覆盖；编辑版本保存在 `output/variants` 下。
