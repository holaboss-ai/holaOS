ARG TOOLCHAIN_IMAGE=holaboss/sandbox-base-toolchain:dev
FROM ${TOOLCHAIN_IMAGE}

WORKDIR /tmp/runtime-source

COPY package.json bun.lock /tmp/runtime-source/
COPY apps/desktop/package.json /tmp/runtime-source/apps/desktop/package.json
COPY apps/docs/ /tmp/runtime-source/apps/docs/
COPY packages/app-builder-sdk/package.json /tmp/runtime-source/packages/app-builder-sdk/package.json
COPY packages/app-builder-sdk/reference/content-calendar/playground/package.json /tmp/runtime-source/packages/app-builder-sdk/reference/content-calendar/playground/package.json
COPY packages/app-builder-sdk/reference/engagement-inbox/playground/package.json /tmp/runtime-source/packages/app-builder-sdk/reference/engagement-inbox/playground/package.json
COPY packages/app-builder-sdk/reference/messaging-dashboard/playground/package.json /tmp/runtime-source/packages/app-builder-sdk/reference/messaging-dashboard/playground/package.json
COPY packages/app-builder-sdk/reference/post-analytics/playground/package.json /tmp/runtime-source/packages/app-builder-sdk/reference/post-analytics/playground/package.json
COPY packages/app-host/package.json /tmp/runtime-source/packages/app-host/package.json
COPY packages/app-sdk/package.json /tmp/runtime-source/packages/app-sdk/package.json
COPY packages/editor/package.json /tmp/runtime-source/packages/editor/package.json
COPY packages/remote-api/ /tmp/runtime-source/packages/remote-api/
COPY packages/runtime-client/package.json /tmp/runtime-source/packages/runtime-client/package.json
COPY packages/tsconfig/package.json /tmp/runtime-source/packages/tsconfig/package.json
COPY packages/ui/package.json /tmp/runtime-source/packages/ui/package.json
COPY shared/ /tmp/runtime-source/shared/
COPY runtime/deploy/ /tmp/runtime-source/runtime/deploy/
COPY runtime/channel-gateway/ /tmp/runtime-source/runtime/channel-gateway/
COPY runtime/harnesses/package.json /tmp/runtime-source/runtime/harnesses/package.json
COPY runtime/harnesses/src/ /tmp/runtime-source/runtime/harnesses/src/
COPY runtime/harness-host/package.json /tmp/runtime-source/runtime/harness-host/package.json
COPY runtime/harness-host/scripts/ /tmp/runtime-source/runtime/harness-host/scripts/
COPY runtime/harness-host/tsconfig.json /tmp/runtime-source/runtime/harness-host/tsconfig.json
COPY runtime/harness-host/tsup.config.ts /tmp/runtime-source/runtime/harness-host/tsup.config.ts
COPY runtime/harness-host/src/ /tmp/runtime-source/runtime/harness-host/src/
COPY runtime/state-store/package.json /tmp/runtime-source/runtime/state-store/package.json
COPY runtime/state-store/tsconfig.json /tmp/runtime-source/runtime/state-store/tsconfig.json
COPY runtime/state-store/tsup.config.ts /tmp/runtime-source/runtime/state-store/tsup.config.ts
COPY runtime/state-store/src/ /tmp/runtime-source/runtime/state-store/src/
COPY runtime/api-server/package.json /tmp/runtime-source/runtime/api-server/package.json
COPY runtime/api-server/tsconfig.json /tmp/runtime-source/runtime/api-server/tsconfig.json
COPY runtime/api-server/tsup.config.ts /tmp/runtime-source/runtime/api-server/tsup.config.ts
COPY runtime/api-server/src/ /tmp/runtime-source/runtime/api-server/src/
RUN chmod +x /tmp/runtime-source/runtime/deploy/build_runtime_root.sh \
    && /tmp/runtime-source/runtime/deploy/build_runtime_root.sh /opt/holaboss-runtime

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
