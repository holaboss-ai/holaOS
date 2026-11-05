#!/bin/bash
# Prepares a fresh spike pod: the pinned Ollama, checksum verified, and a `benchclub` command for the copied CLI.
set -euo pipefail
OLLAMA_VERSION=0.40.10
OLLAMA_SHA256=1e8ad2d2a394efdd235bee74deec237badd95142ffba77588140ab2a9ecec227

# Holds the pod-scoped API key; model-written code runs as nobody and must not read it.
chmod 600 /etc/rp_environment

if ! ollama --version 2>&1 | grep -q "$OLLAMA_VERSION"; then
  curl -fsSL --retry 3 -o /tmp/ollama.tar.zst \
    "https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-linux-amd64.tar.zst"
  echo "${OLLAMA_SHA256}  /tmp/ollama.tar.zst" | sha256sum -c --quiet -
  zstd -dc /tmp/ollama.tar.zst | tar -x -C /usr
  rm /tmp/ollama.tar.zst
fi

cat > /usr/local/bin/benchclub <<'EOF'
#!/bin/sh
PYTHONPATH=/opt/benchclub/src exec python3 -m benchclub "$@"
EOF
chmod 755 /usr/local/bin/benchclub

cat > /opt/kaluma-env.sh <<'EOF'
export BENCHCLUB_CLOUD_WORKER=1 BENCHCLUB_HOME=/root/benchclub OLLAMA_MODELS=/root/models PYTHONPATH=/opt/benchclub/src
# Bundled subject configs: this measures the suites, not whether the old hub is up.
export BENCHCLUB_HUB=https://hub.invalid BENCHCLUB_API=https://api.invalid
EOF
mkdir -p /root/results /root/models /root/benchclub
echo "ollama $(ollama --version 2>&1 | grep -o '[0-9.]*$' | tail -1) · $(benchclub --version) · $(python3 --version)"
