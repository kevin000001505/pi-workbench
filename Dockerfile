# syntax=docker/dockerfile:1

# --- web UI ---------------------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY web/ ./
RUN npm run build

# --- Matt Pocock's skills at a pinned commit --------------------------------------------------
FROM node:24-bookworm-slim AS skills
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ARG MATT_SKILLS_REF=a496f5513d4a4cf889bc48e189e579f4b0bdf6aa
RUN git init -q /src && cd /src \
 && git remote add origin https://github.com/mattpocock/skills.git \
 && git fetch -q --depth 1 origin "$MATT_SKILLS_REF" && git checkout -q FETCH_HEAD \
 && mkdir -p /skills && cp -r skills/engineering skills/productivity /skills/

# --- runtime --------------------------------------------------------------------------------
FROM node:24-bookworm-slim
ARG PI_VERSION=1.4.0

# Tools the agent works with: git + gh for GitHub, ripgrep for search, and common build toolchains.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep jq less procps openssh-client \
      python3 python3-venv python3-pip build-essential \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}"

# Every git command in the container (the agent's too) authenticates to github.com with GITHUB_TOKEN.
RUN git config --system credential.https://github.com.helper \
      '!f() { test "$1" = get && echo username=x-access-token && echo "password=${GITHUB_TOKEN:-$GH_TOKEN}"; }; f' \
 && git config --system init.defaultBranch main \
 && git config --system --add safe.directory '*'

WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY shared/ ./shared/
COPY server/src/ ./server/src/
COPY pi-extension/ ./pi-extension/
COPY --from=web /app/web/dist ./web/dist
COPY --from=skills /skills /opt/workbench/skills

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8787 \
    SKILLS_DIR=/opt/workbench/skills \
    PI_EXTENSION=/app/pi-extension/workbench.ts \
    WEB_DIR=/app/web/dist
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/main.ts"]
