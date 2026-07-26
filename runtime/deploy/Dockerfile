ARG TOOLCHAIN_IMAGE=holaboss/sandbox-base-toolchain:dev
FROM ${TOOLCHAIN_IMAGE}

WORKDIR /tmp/runtime-source

COPY runtime/deploy/ /tmp/runtime-source/deploy/
COPY runtime/harnesses/package.json /tmp/runtime-source/harnesses/package.json
COPY runtime/harnesses/src/ /tmp/runtime-source/harnesses/src/
COPY runtime/harness-host/package.json /tmp/runtime-source/harness-host/package.json
COPY runtime/harness-host/package-lock.json /tmp/runtime-source/harness-host/package-lock.json
COPY runtime/harness-host/tsconfig.json /tmp/runtime-source/harness-host/tsconfig.json
COPY runtime/harness-host/tsup.config.ts /tmp/runtime-source/harness-host/tsup.config.ts
COPY runtime/harness-host/src/ /tmp/runtime-source/harness-host/src/
COPY runtime/state-store/package.json /tmp/runtime-source/state-store/package.json
COPY runtime/state-store/package-lock.json /tmp/runtime-source/state-store/package-lock.json
COPY runtime/state-store/tsconfig.json /tmp/runtime-source/state-store/tsconfig.json
COPY runtime/state-store/tsup.config.ts /tmp/runtime-source/state-store/tsup.config.ts
COPY runtime/state-store/src/ /tmp/runtime-source/state-store/src/
COPY runtime/api-server/package.json /tmp/runtime-source/api-server/package.json
COPY runtime/api-server/package-lock.json /tmp/runtime-source/api-server/package-lock.json
COPY runtime/api-server/tsconfig.json /tmp/runtime-source/api-server/tsconfig.json
COPY runtime/api-server/tsup.config.ts /tmp/runtime-source/api-server/tsup.config.ts
COPY runtime/api-server/src/ /tmp/runtime-source/api-server/src/
RUN chmod +x /tmp/runtime-source/deploy/build_runtime_root.sh \
    && /tmp/runtime-source/deploy/build_runtime_root.sh /opt/holaboss-runtime

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
