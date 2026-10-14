# Identity and Visitor Manager
# Small Express app; no build step, so a single stage keeps it simple.
FROM node:24-alpine

# tini: correct signal handling so `docker stop` exits promptly rather than
#       waiting out the 10s kill timeout.
# openssl: used to generate a self-signed certificate when TLS_ENABLED=true.
RUN apk add --no-cache tini openssl

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
# better-sqlite3-multiple-ciphers ships its binaries inside the npm package, Alpine
# (musl) for amd64 and arm64 included, so nothing needs compiling; --ignore-scripts
# stops `npm ci` from trying node-gyp anyway. No dependency here needs an install script.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Every top-level module, so a new file cannot be left out of the image by mistake
# (test/ and scripts/ are directories and do not match the glob), plus the key scripts.
COPY *.js ./
COPY scripts ./scripts
COPY public ./public

# Fail the build, not the first container start, if a module is missing or the cipher
# library does not load: server.js only listens when it is the main module, so requiring
# it opens a throwaway encrypted database with a throwaway key and resolves every module.
RUN DATA_DIR=/tmp/smoke DB_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" node -e "require('./server.js')" && rm -rf /tmp/smoke

# Where the image came from, for `docker inspect` and GitHub Container Registry (the
# source label links the package to the repository). The workflow passes the commit and
# build time; a local build leaves them empty.
ARG GIT_SHA=""
ARG BUILD_DATE=""
LABEL org.opencontainers.image.title="Identity and Visitor Manager" \
      org.opencontainers.image.description="Tenant directory and visitor check-in across sites, with badges, clearance validation and an encrypted database" \
      org.opencontainers.image.source="https://github.com/spicy384/tenant-identity-visitor-manager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"

# The image ships no data and no key; /data is a volume that outlives the container and
# the key arrives as the Docker secret db_key (/run/secrets/db_key).
# node:alpine already provides an unprivileged `node` user (uid 1000).
RUN mkdir -p /data && chown node:node /data

USER node
# 3000: the staff pages and APIs. 3001: the lobby kiosks, when KIOSK_PORT=3001 (docker-compose sets it).
EXPOSE 3000 3001
VOLUME ["/data"]

# Probes /api/auth/me: it answers 200 whether or not anyone is signed in. Follows the
# app's own scheme and skips verification, since a self-signed certificate is expected.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const tls=(process.env.TLS_ENABLED||'').toLowerCase()==='true'||!!process.env.TLS_CERT;require(tls?'https':'http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/api/auth/me',timeout:4000,rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('timeout',()=>process.exit(1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
