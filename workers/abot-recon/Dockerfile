ARG CUDA_IMAGE=nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
FROM ${CUDA_IMAGE}

ARG ABOT_RECON_REF=main
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip git ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121

WORKDIR /opt/ABot-Recon
RUN git clone --depth 1 --branch "${ABOT_RECON_REF}" https://github.com/amap-cvlab/ABot-Recon.git . \
    && python3 -m pip install -e . \
    && python3 -m pip install fastapi uvicorn[standard] pydantic

COPY app.py /opt/abot-worker/app.py
ENV ABOT_RECON_DATA_ROOT=/app/runtime/data \
    ABOT_RECON_DEVICE=cuda \
    ABOT_RECON_FFMPEG=/usr/bin/ffmpeg

WORKDIR /opt/abot-worker
EXPOSE 8091
CMD ["python3", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8091"]
