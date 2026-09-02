# 持久化 devel 容器构建

本文用于服务器网络不稳定、需要进入容器反复安装依赖和重试构建的场景。最终镜像只保存系统依赖、Python 依赖、Node runtime、CUDA 版 COLMAP 和 Brush；应用代码通过 `/workspace/gaussian` 挂载运行，不通过 `docker commit` 封装。

## 1. 创建并进入准备容器

在项目根目录执行：

```bash
cd /mnt/data/tk-koc1/tk-server/gaussian

IMG=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04

docker run --name gaussian-build --gpus all -it \
  -v "$PWD":/workspace/gaussian \
  -w /workspace/gaussian \
  "$IMG" bash
```

如果网络中断或某一步失败，重新进入原容器，不要重新 `docker run`：

```bash
docker start -ai gaussian-build
```

## 2. 在容器内安装依赖和构建

以下命令都在容器内执行。推荐直接执行项目内的幂等脚本：

```bash
bash /workspace/gaussian/docker/prepare-manual.sh
```

本次使用依赖镜像模式，不把应用代码复制进镜像：

```bash
IMAGE_ONLY=true bash /workspace/gaussian/docker/prepare-manual.sh
```

准备或排查过程中，可执行只读环境检查：

```bash
bash /workspace/gaussian/docker/check-environment.sh
```

某一步失败时，修正原因后可以重复执行同一个脚本；已安装的软件、源码和 COLMAP build 目录会在 `gaussian-build` 内保留。不要退出并重新创建 `gaussian-build`。

## 3. 提交为长期镜像

在容器内完成上一步后退出：

```bash
exit
```

在宿主机执行：

```bash
docker commit gaussian-build gaussian:deps
docker image inspect gaussian:deps --format '{{.Id}}'
```

## 4. Compose 一键启动

`compose-ready.yml` 不包含 `build:`，只启动已经封装好的依赖镜像，并将当前项目代码挂载到容器：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml up -d
```

检查服务：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml ps
docker compose -p gaussian-ready -f docker/compose-ready.yml logs -f app
docker compose -p gaussian-ready -f docker/compose-ready.yml exec -T app \
  curl -f http://127.0.0.1:4178/health
```

访问：`http://服务器地址:8080/`。

项目目录以读写方式挂载到容器 `/workspace/gaussian`，FastAPI 和前端都直接使用该目录中的代码；前端 `node_modules`、`.next` 等构建产物保留在该目录的忽略路径。模型数据写入宿主机项目下的 `runtime/data`，容器删除后数据仍保留。以后启动只需执行：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml start
```

发布新代码后不需要重新封装依赖镜像。更新宿主机项目并重建容器即可；启动脚本会根据 `package-lock.json` 和前端源码哈希自动判断是否需要执行 `npm ci`/`npm run build`：

```bash
git pull --ff-only origin main
docker compose -p gaussian-ready -f docker/compose-ready.yml up -d --force-recreate
```

不要执行 `docker compose ... build`、`docker builder prune` 或 `docker system prune`。
