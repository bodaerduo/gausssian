# 持久化 devel 容器构建

本文用于服务器网络不稳定、需要进入容器反复安装依赖和重试构建的场景。构建容器不会删除，成功后提交为本地镜像；长期运行使用不带 `build:` 的 `compose-ready.yml`，不会再次构建。

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

某一步失败时，只重新执行该步骤即可。不要退出并重新创建 `gaussian-build`。

## 3. 提交为长期镜像

在容器内完成上一步后退出：

```bash
exit
```

在宿主机执行：

```bash
docker commit gaussian-build gaussian:ready
docker image inspect gaussian:ready --format '{{.Id}}'
```

## 4. Compose 一键启动

`compose-ready.yml` 不包含 `build:`，只启动已经封装好的镜像：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml up -d
```

检查服务：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml ps
docker compose -p gaussian-ready -f docker/compose-ready.yml logs -f app
curl http://127.0.0.1:8080/api/health
```

访问：`http://服务器地址:8080/`。

项目目录以只读方式挂载到容器 `/workspace/gaussian` 供查看；模型数据写入宿主机项目下的 `runtime/data`，容器删除后数据仍保留。以后启动只需执行：

```bash
docker compose -p gaussian-ready -f docker/compose-ready.yml start
```

不要执行 `docker compose ... build`、`docker builder prune` 或 `docker system prune`。
