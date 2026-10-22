# Runs the conformance suite against a REAL broker.
#
# Same shape as the other three SDKs' images, so a failure means the IMPLEMENTATION
# differs rather than the environment. The broker version matches docker-compose.yml.
#
# Build context is the repository root.
FROM node:22-slim

ARG NATS_VERSION=2.15.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
 && curl -fsSL -o /tmp/nats.tgz \
      "https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-linux-amd64.tar.gz" \
 && tar -xzf /tmp/nats.tgz -C /tmp \
 && mv /tmp/nats-server-v${NATS_VERSION}-linux-amd64/nats-server /usr/local/bin/ \
 && rm -rf /tmp/nats.tgz /tmp/nats-server-v${NATS_VERSION}-linux-amd64 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Dependency layer first: package.json changes far less often than src/.
# `npm ci` (not install) so the lockfile decides exactly what runs.
COPY package.json package-lock.json ./
RUN npm ci

# No vitest.config in this repo: vitest discovers tests/ by convention, and copying
# a glob that matches nothing fails the build.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY tests ./tests
COPY conformance-cases ./conformance-cases

RUN useradd -m -u 10001 runner && chown -R runner /src
USER runner

ENTRYPOINT ["npx", "vitest", "run"]
