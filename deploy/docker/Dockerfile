FROM node:22-slim

# Build context must be repo root:
#   docker build -f deploy/docker/Dockerfile .

# Install git, curl, etc. (unset proxy — debian repos work fine without it and Clash 502s randomly)
RUN http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= \
    apt-get update && \
    http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= \
    apt-get install -y --no-install-recommends git ca-certificates curl bash && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Proxy args — used for GitHub/npm downloads below
ARG http_proxy
ARG https_proxy
ARG all_proxy

# Download cloudflared (uses proxy if set — GitHub is slow without it)
RUN curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

ARG GC_VERSION=latest
RUN git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" && \
    git config --global --add url."https://github.com/".insteadOf "git@github.com:" && \
    npm install -g openclaw@latest @devbond/gc@${GC_VERSION} && \
    openclaw --version && \
    command -v goo-core && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm/_logs

RUN mkdir -p \
      /root/.openclaw/workspace \
      /root/.openclaw/hooks \
      /root/.openclaw/logs \
      /root/.goo-core/data \
      /var/log/sandbox

COPY deploy/docker/openclaw.json /root/.openclaw/openclaw.json
COPY deploy/docker/entrypoint.sh /root/.openclaw/start.sh
COPY deploy/docker/goo-core-wrapper.sh /root/.openclaw/goo-core-wrapper.sh
COPY deploy/docker/control-server.mjs /root/.openclaw/control-server.mjs
COPY deploy/docker/hooks/ /root/.openclaw/hooks/

# Bake openclaw-docs to staging dir (entrypoint copies to workspace on every startup)
COPY openclaw-docs/ /root/.openclaw/docs-template/
# Overlay clawhub skills (single source of truth for skills)
COPY clawhub/skills/ /root/.openclaw/docs-template/skills/

RUN chmod +x /root/.openclaw/start.sh /root/.openclaw/goo-core-wrapper.sh

WORKDIR /root

EXPOSE 18789

ENTRYPOINT ["/bin/bash", "/root/.openclaw/start.sh"]
