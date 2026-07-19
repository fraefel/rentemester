# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
ARG BUN_IMAGE=oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04
ARG RENTEMESTER_VERSION
ARG RENTEMESTER_GIT_COMMIT
ARG RENTEMESTER_BUILT_AT
ARG SOURCE_DATE_EPOCH

FROM ${BUN_IMAGE} AS cockpit-build
ARG RENTEMESTER_BUILT_AT
WORKDIR /build/app
COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile
COPY app/ ./
RUN bun run build \
    && find dist -print0 | xargs -0 touch -d "${RENTEMESTER_BUILT_AT}"

FROM ${BUN_IMAGE} AS runtime-dependencies
ARG RENTEMESTER_BUILT_AT
WORKDIR /build/runtime
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production \
    && find node_modules -print0 | xargs -0 touch -d "${RENTEMESTER_BUILT_AT}"

FROM ${BUN_IMAGE} AS runtime-files
ARG RENTEMESTER_BUILT_AT
WORKDIR /prepared
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY rules ./rules
COPY sources ./sources
COPY docs ./docs
RUN find /prepared -print0 | xargs -0 touch -d "${RENTEMESTER_BUILT_AT}"

FROM ${BUN_IMAGE} AS runtime

ARG RENTEMESTER_VERSION
ARG RENTEMESTER_GIT_COMMIT
ARG RENTEMESTER_BUILT_AT

LABEL org.opencontainers.image.title="Rentemester" \
      org.opencontainers.image.description="Versioneret dansk bogføringsruntime med cockpit" \
      org.opencontainers.image.source="https://github.com/mikkelkrogsholm/rentemester" \
      org.opencontainers.image.version="${RENTEMESTER_VERSION}" \
      org.opencontainers.image.revision="${RENTEMESTER_GIT_COMMIT}" \
      org.opencontainers.image.created="${RENTEMESTER_BUILT_AT}"

WORKDIR /app
COPY --from=runtime-dependencies --chown=bun:bun /build/runtime/node_modules ./node_modules
COPY --from=runtime-files --chown=bun:bun /prepared/ ./
COPY --from=cockpit-build --chown=bun:bun /build/app/dist ./app/dist
RUN mkdir -p /workspace /import \
    && chown -R bun:bun /workspace /import \
    && touch -d "${RENTEMESTER_BUILT_AT}" /app /workspace /import

ENV RENTEMESTER_WORKSPACE=/workspace \
    RENTEMESTER_APP_HOST=0.0.0.0 \
    RENTEMESTER_APP_PORT=4319 \
    RENTEMESTER_APP_AUTH=required \
    RENTEMESTER_VERSION=${RENTEMESTER_VERSION} \
    RENTEMESTER_GIT_COMMIT=${RENTEMESTER_GIT_COMMIT} \
    RENTEMESTER_BUILT_AT=${RENTEMESTER_BUILT_AT}

VOLUME ["/workspace", "/import"]
EXPOSE 4319
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const token=process.env.RENTEMESTER_APP_TOKEN; const headers=token?{Authorization:`Bearer ${token}`}:{ }; const r=await fetch('http://127.0.0.1:4319/api/health',{headers}); if(!r.ok) process.exit(1)"]

ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve", "--workspace", "/workspace", "--host", "0.0.0.0", "--port", "4319"]
