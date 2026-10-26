# syntax=docker/dockerfile:1
# API and recognition-worker images; see docs/DOCKER.md.
#   docker compose --profile app up --build
# Both images keep the app at /app: pipeline snapshots pin absolute code paths,
# so the API (which creates them) and the worker (which checks them) must agree.

FROM node:22-bookworm-slim AS node

FROM node AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY tests tests
RUN npm run build && npm prune --omit=dev

# Node, the built API/worker and its runtime modules on Python 3.12 (the notebook's version).
FROM python:3.12-slim-bookworm AS runtime
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /opt/venv
ENV PLATE_PIPELINE_PYTHON=/opt/venv/bin/python \
    PLATE_DATA_DIR=/app/data \
    PLATE_CACHE_DIR=/app/data/model-cache \
    PLATE_PIPELINES_CONFIG=config/pipelines.kaggle.json \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
COPY src/database/migrations src/database/migrations
COPY config config
COPY app app
COPY scripts scripts

# The API only probes uploads in Python (scripts/probe_media.py).
FROM runtime AS api
RUN /opt/venv/bin/pip install --no-cache-dir Pillow opencv-python-headless
EXPOSE 3000
CMD ["sh", "-c", "node dist/src/cli.js migrate && exec node dist/src/main.js"]

# The worker runs YOLO/OCR on the GPU: CUDA comes inside the torch wheels, so the host
# only needs the NVIDIA driver and container toolkit (Docker Desktop: WSL 2 backend).
FROM runtime AS worker
COPY requirements-inference.txt ./
RUN /opt/venv/bin/pip install --no-cache-dir "torch==2.10.0+cu128" "torchvision==0.25.0+cu128" \
        --index-url https://download.pytorch.org/whl/cu128 \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements-inference.txt
CMD ["node", "dist/src/worker.js"]
