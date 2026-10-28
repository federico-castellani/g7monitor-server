FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/federico-castellani/g7monitor-server" \
      org.opencontainers.image.description="G7 Monitor Server: glicemie dal Dexcom G7 via G7 Monitor" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node

# Version shown by /healthz and in the log (passed by the build workflow).
ARG VERSION=dev
ENV G7_VERSION=$VERSION \
    G7_HOST=0.0.0.0 \
    G7_PORT=8080 \
    G7_DB=/data/g7.db
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "src/server.ts"]
