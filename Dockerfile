# Lorehouse as a container: the single compiled binary (prompts, migrations and the
# Slack manifest `lorehouse doctor` checks scopes against are built in) on a slim base.
# Everything it keeps goes under /data, so mount a volume there. Configuration is all
# environment variables; see the README.

FROM oven/bun:1.3 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY migrations ./migrations
COPY slack ./slack
RUN bun run build

FROM debian:bookworm-slim
# TLS roots for Slack and Anthropic
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist/lorehouse /usr/local/bin/lorehouse
# The volume is the data directory: settings.json in it, the tenant's databases in
# /data/<tenant>/ (src/tenant.ts). An image that set LOREHOUSE_DB and SESSIONS_DB here
# kept them in /data itself: the first start of this one moves them (by link and rename), and
# leaves a symlink at each old path, so rolling back to such an image still works.
ENV PORT=3000 LOREHOUSE_DATA_DIR=/data
EXPOSE 3000
CMD ["lorehouse"]
