ARG TOOLCHAIN_IMAGE=holaboss/sandbox-base-toolchain:dev
FROM ${TOOLCHAIN_IMAGE}

# Install bun (toolchain image ships node + npm but not bun; the runtime build
# scripts use bun install since the monorepo migration to a single root bun.lock)
RUN npm install -g bun

WORKDIR /tmp/runtime-source

COPY runtime/deploy/ /tmp/runtime-source/deploy/
COPY runtime/harnesses/package.json /tmp/runtime-source/harnesses/package.json
COPY runtime/harnesses/src/ /tmp/runtime-source/harnesses/src/
COPY runtime/harness-host/package.json /tmp/runtime-source/harness-host/package.json
COPY runtime/harness-host/tsconfig.json /tmp/runtime-source/harness-host/tsconfig.json
COPY runtime/harness-host/tsup.config.ts /tmp/runtime-source/harness-host/tsup.config.ts
COPY runtime/harness-host/src/ /tmp/runtime-source/harness-host/src/
COPY runtime/state-store/package.json /tmp/runtime-source/state-store/package.json
COPY runtime/state-store/tsconfig.json /tmp/runtime-source/state-store/tsconfig.json
COPY runtime/state-store/tsup.config.ts /tmp/runtime-source/state-store/tsup.config.ts
COPY runtime/state-store/src/ /tmp/runtime-source/state-store/src/
COPY runtime/api-server/package.json /tmp/runtime-source/api-server/package.json
COPY runtime/api-server/tsconfig.json /tmp/runtime-source/api-server/tsconfig.json
COPY runtime/api-server/tsup.config.ts /tmp/runtime-source/api-server/tsup.config.ts
COPY runtime/api-server/src/ /tmp/runtime-source/api-server/src/
COPY runtime/channel-gateway/package.json /tmp/runtime-source/channel-gateway/package.json
COPY runtime/channel-gateway/tsconfig.json /tmp/runtime-source/channel-gateway/tsconfig.json
COPY runtime/channel-gateway/tsup.config.ts /tmp/runtime-source/channel-gateway/tsup.config.ts
COPY runtime/channel-gateway/src/ /tmp/runtime-source/channel-gateway/src/
COPY packages/remote-api/package.json /tmp/runtime-source/packages/remote-api/package.json
COPY packages/remote-api/tsconfig.json /tmp/runtime-source/packages/remote-api/tsconfig.json
COPY packages/remote-api/tsup.config.ts /tmp/runtime-source/packages/remote-api/tsup.config.ts
COPY packages/remote-api/src/ /tmp/runtime-source/packages/remote-api/src/
COPY shared/ /tmp/runtime-source/shared/
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
