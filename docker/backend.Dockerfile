ARG CUDA_BUILD_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-devel-ubuntu22.04
ARG CUDA_RUNTIME_IMAGE=swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/nvidia/cuda:12.4.1-runtime-ubuntu22.04

FROM ${CUDA_BUILD_IMAGE} AS builder

ARG COLMAP_REF=main
ARG BRUSH_REF=main
ARG CUDA_ARCH=89
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git cmake ninja-build build-essential pkg-config \
    libboost-program-options-dev libboost-graph-dev libboost-system-dev \
    libeigen3-dev libopenimageio-dev libmetis-dev \
    libgoogle-glog-dev libgtest-dev libgmock-dev libsqlite3-dev \
    libglew-dev libcgal-dev libceres-dev libsuitesparse-dev \
    libcurl4-openssl-dev libssl-dev libblas-dev liblapack-dev \
    libvulkan-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${COLMAP_REF}" \
    https://github.com/colmap/colmap.git colmap
RUN cmake -S /src/colmap -B /build/colmap -GNinja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DCMAKE_CUDA_ARCHITECTURES="${CUDA_ARCH}" \
    -DCUDA_ENABLED=ON \
    -DGUI_ENABLED=OFF \
    -DTESTS_ENABLED=OFF
RUN cmake --build /build/colmap --target install --parallel

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH=/root/.cargo/bin:${PATH}
RUN git clone --depth 1 --branch "${BRUSH_REF}" \
    https://github.com/ArthurBrussee/brush.git brush
RUN cargo build --manifest-path /src/brush/Cargo.toml --release -p brush-cli

FROM ${CUDA_RUNTIME_IMAGE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg curl ca-certificates \
    libboost-program-options1.74.0 libboost-graph1.74.0 libboost-system1.74.0 \
    libopenimageio2.2 libmetis5 libgoogle-glog0v5 libgflags2.2 \
    libceres2 libsqlite3-0 libglew2.2 libglu1-mesa \
    libamd2 libcamd2 libccolamd2 libcholmod3 libcolamd2 \
    libcxsparse3 libklu1 libldl2 libmongoose2 libspqr2 libumfpack5 \
    libblas3 liblapack3 libvulkan1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && npm --version \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/bin/colmap /usr/local/bin/colmap
COPY --from=builder /src/brush/target/release/brush-cli /usr/local/bin/brush-cli
COPY backend /app/backend
COPY front /app/front
COPY docker/start.sh /usr/local/bin/gaussian-start
RUN chmod 0755 /usr/local/bin/gaussian-start

RUN python3 -m pip install --no-cache-dir -r /app/backend/requirements.txt
WORKDIR /app/front
ARG NEXT_PUBLIC_GAUSSIAN_DEMO=false
ENV NEXT_PUBLIC_GAUSSIAN_DEMO=${NEXT_PUBLIC_GAUSSIAN_DEMO}
RUN npm ci && npm run build

WORKDIR /app/backend
ENV GAUSSIAN_DATA_ROOT=/app/runtime/data \
    GAUSSIAN_HOST=0.0.0.0 \
    GAUSSIAN_PORT=4178 \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    COLMAP_BIN=/usr/local/bin/colmap \
    BRUSH_BIN=/usr/local/bin/brush-cli

EXPOSE 4177 4178
CMD ["/usr/local/bin/gaussian-start"]
