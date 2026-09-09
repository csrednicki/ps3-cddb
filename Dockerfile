# syntax=docker/dockerfile:1

# PS3 CDDB proxy - DNS :53 + HTTP :80 in a single container.
# Ports 53/80 are privileged (<1024), so the container runs as root.

FROM node:22-alpine

# bind-tools (dig) is handy for testing the DNS endpoint from inside the container
RUN apk add --no-cache bind-tools

WORKDIR /app

# install production dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# application code + default config
COPY api/src api/src
COPY api/config.json api/config.json

# writable runtime dirs (mount volumes over them to persist data)
RUN mkdir -p cache dumps logs

ENV NODE_ENV=production \
    CDDB_LOG_COLOR=false

EXPOSE 53/udp 53/tcp 80/tcp

CMD ["node", "api/src/index.js"]
