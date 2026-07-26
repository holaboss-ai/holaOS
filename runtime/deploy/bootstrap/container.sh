#!/usr/bin/env bash
set -euo pipefail

holaboss_container_docker_info_ready() {
  timeout 2s docker info >/dev/null 2>&1
}

holaboss_container_cleanup_stale_runtime_state() {
  holaboss_runtime_log "cleaning stale nested-docker runtime state"

  pkill -TERM dockerd >/dev/null 2>&1 || true
  pkill -TERM -f "containerd --config /var/run/docker/containerd/containerd.toml" >/dev/null 2>&1 || true
  sleep 1
  pkill -KILL dockerd >/dev/null 2>&1 || true
  pkill -KILL -f "containerd --config /var/run/docker/containerd/containerd.toml" >/dev/null 2>&1 || true

  rm -f \
    /var/run/docker.pid \
    /run/docker.pid \
    /var/run/docker.sock \
    /run/docker.sock

  rm -rf \
    /var/run/docker/containerd \
    /run/docker/containerd \
    /var/run/docker/libnetwork \
    /run/docker/libnetwork \
    /var/run/docker/metrics.sock \
    /run/docker/metrics.sock \
    /var/run/docker/unmount-on-shutdown \
    /run/docker/unmount-on-shutdown
}

holaboss_container_bootstrap() {
  : "${HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT:=http://host.docker.internal:3060/api/v1/model-proxy}"
  export HOLABOSS_MODEL_PROXY_BASE_URL_DEFAULT

  if ! command -v dockerd >/dev/null 2>&1; then
    return 0
  fi

  if holaboss_container_docker_info_ready; then
    holaboss_runtime_log "docker daemon already available"
    return 0
  fi

  holaboss_runtime_log "docker daemon not ready; starting dockerd"
  mkdir -p /etc/docker
  echo '{"storage-driver":"fuse-overlayfs","features":{"containerd-snapshotter":false}}' > /etc/docker/daemon.json
  holaboss_container_cleanup_stale_runtime_state
  dockerd >/tmp/dockerd.log 2>&1 &

  for _ in $(seq 1 60); do
    if holaboss_container_docker_info_ready; then
      holaboss_runtime_log "dockerd is ready"
      return 0
    fi
    sleep 0.5
  done

  holaboss_runtime_log "dockerd did not become ready within startup window"
  if [ -f /tmp/dockerd.log ]; then
    tail -n 120 /tmp/dockerd.log >&2 || true
  fi
}
