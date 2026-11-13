# Lab Console - small + unprivileged production image
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first for layer caching: --omit=optional skips ssh2's native
# cpu-features addon, so no compiler is needed (ssh2 falls back to pure JS)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY diagrams ./diagrams
COPY config ./config

# State lives in DATA_DIR and nowhere else: run the container with a read-only
# root filesystem (`read_only: true`) and a volume on /data. The directory is
# created here, owned by the unprivileged user, so that a fresh named volume
# inherits that ownership; a bind-mounted host folder must be writable by
# uid 1000 (node) itself
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "src/server.js"]
