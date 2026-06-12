FROM oven/bun:1.2.23-slim
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY rules ./rules

# SEC-7 (Audit 2026-06-11): run as a non-root user. The image previously ran as
# root, so a process escape (or a bug in any dependency) would act as root, and
# any bind-mounted host volume would be written root-owned. The official
# `oven/bun` image already ships an unprivileged `bun` user (uid/gid 1000); we
# pre-create the mount points and hand /app + the volumes to that user so the
# ledger/import data is owned by the runtime account rather than root.
RUN mkdir -p /company /import \
    && chown -R bun:bun /app /company /import

ENV RENTEMESTER_COMPANY=/company
VOLUME ["/company", "/import"]

# Drop privileges before the entrypoint runs. A new bind-mounted volume inherits
# the host path's ownership; mount it with the matching uid (1000) or run the
# container with `--user` so /company and /import stay writable.
USER bun

ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["system", "healthcheck"]
