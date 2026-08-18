ARG TOOLCHAIN_IMAGE=holaboss/sandbox-base-toolchain:dev
FROM ${TOOLCHAIN_IMAGE}

# Install bun (toolchain image ships node + npm but not bun; the runtime build
# scripts use bun install since the monorepo migration to a single root bun.lock)
RUN npm install -g bun@1.3.6

WORKDIR /tmp/runtime-source

# Copy whole package dirs (not file-by-file) so future layout changes (new
# config files, scripts/, etc.) don't silently break the build again.
# build_runtime_root.mjs stages each package with copyIfPresent() guards, so
# extra files are harmless.
#
# Layout mirrors the .mjs path assumptions:
#   runtimeRoot = /tmp/runtime-source  (runtime/* packages)
#   repoRoot    = /tmp                 (packages/remote-api, shared/)
COPY runtime/deploy/ /tmp/runtime-source/deploy/
COPY runtime/harnesses/ /tmp/runtime-source/harnesses/
COPY runtime/harness-host/ /tmp/runtime-source/harness-host/
COPY runtime/state-store/ /tmp/runtime-source/state-store/
COPY runtime/api-server/ /tmp/runtime-source/api-server/
COPY runtime/channel-gateway/ /tmp/runtime-source/channel-gateway/
COPY packages/remote-api/ /tmp/packages/remote-api/
COPY shared/ /tmp/shared/
RUN node /tmp/runtime-source/deploy/build_runtime_root.mjs /opt/holaboss-runtime

WORKDIR /app

RUN mkdir -p /app \
    && cp -R /opt/holaboss-runtime/api-server /app/api-server \
    && cp -R /opt/holaboss-runtime/harness-host /app/harness-host \
    && cp -R /opt/holaboss-runtime/state-store /app/state-store \
    && cp /opt/holaboss-runtime/metadata.json /app/metadata.json \
    && chmod +x /opt/holaboss-runtime/bootstrap/*.sh

WORKDIR /app

COPY runtime/deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
# tini as PID 1: properly reaps zombie child processes (needed for DinD containerd-shim reaping)
ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
