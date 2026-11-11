FROM python:3.12-slim

ARG TARGETARCH=amd64
ARG OLLAMA_VERSION=0.40.10

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl zstd bubblewrap \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-${TARGETARCH}.tar.zst" \
    | zstd -d | tar -x -C /usr

COPY pyproject.toml README.md /opt/benchclub/
COPY src /opt/benchclub/src
COPY cloud/probe.py /opt/probe.py
RUN pip install --no-cache-dir /opt/benchclub

ENV OLLAMA_MODELS=/models BENCHCLUB_CLOUD_WORKER=1 BENCHCLUB_HOME=/tmp/benchclub
