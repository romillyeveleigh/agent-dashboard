# Agent Worker — Docker image for headless Claude Code sessions
#
# Build: docker build -t agent-worker:local -f docker/Dockerfile .
# Contains CLI tooling (Claude Code, corepack/pnpm, gh), pre-installed plugins,
# and the supervisor (Agent SDK runner). The target repo is cloned into
# /agent-work/tasks/<task-id> at runtime (set as the container's WorkingDir by
# dashboard/src/lib/docker.ts) — the dashboard itself is NOT baked into this image.
#
# Runtime env vars (passed by dashboard):
#   CLAUDE_CODE_OAUTH_TOKEN — long-lived OAuth token from `claude setup-token`
#   GITHUB_TOKEN            — GitHub PAT with repo scope
#   LINEAR_API_KEY          — Linear API key for MCP server (optional)
#   AGENT_PROMPT            — The full prompt for Claude Code
#   TASK_ID                 — UUID for this task (used by the supervisor)
#   DASHBOARD_URL           — URL of the dashboard (required)
#   REPO_URL                — GitHub repo (e.g. org/repo)
#   MODE                    — Primary tag for logging (optional)
#   TICKET_ID               — Linear ticket ID (optional)
#   PR_NUMBER               — PR number (optional)

FROM node:24-slim

# Install git, python3, and other essentials
RUN apt-get update && apt-get install -y --no-install-recommends git curl bash openssh-client python3 ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Claude Code plugins are pre-installed at build time further down (after USER
# agent). `claude plugins install` only needs network — it clones the public
# marketplace repo — NOT auth, so it runs fine during build with a placeholder
# token. This moves ~7s off every container startup.

# Enable corepack shims for pnpm/yarn. Inside the cloned repo they select the
# version from package.json's packageManager field, so installs match the
# target repo's CI without pinning a version here.
RUN corepack enable \
    && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@latest --activate \
    && pnpm --version

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# Install supervisor v2 (Agent SDK runner) dependencies. Manifest files first
# (so this layer only rebuilds when dependencies change), install, then
# source + build as a separate layer — avoids copying the host's local
# node_modules/dist (present from building the package outside Docker) into
# the image, since there's no root-level .dockerignore to filter them out of
# the build context.
COPY docker/supervisor/package.json docker/supervisor/package-lock.json docker/supervisor/tsconfig.json /opt/supervisor/
RUN (cd /opt/supervisor && npm ci)

# Copy supervisor source and build. Owns Claude Code, MCP config, log
# forwarding, and final status posting (see docker/entrypoint.sh's tail and
# docker/supervisor/src/index.ts). Built as root before the chown/USER steps
# below — no explicit chown needed since nothing here is ever written to at
# runtime, only read+executed by `agent`.
COPY docker/supervisor/src /opt/supervisor/src
RUN (cd /opt/supervisor && npm run build && npm prune --omit=dev)

# Skills are mounted at runtime via bind mount (SKILLS_PATH:/opt/skills:ro)
# so updates take effect without rebuilding the Docker image.
RUN mkdir -p /opt/skills

# Copy entrypoint
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/protect-injected.sh /opt/protect-injected.sh
RUN chmod +x /entrypoint.sh

# ─── Create non-root user ───
# Defence-in-depth: if the agent runs a malicious Bash command, it doesn't have
# root inside the container. The agent still has full access to its workspace
# (/agent-work/tasks/<task-id>, the cloned repo) and its own HOME, which is
# everything it needs.
# /agent-work is the mountpoint for the shared agent-work volume (see
# dashboard/src/lib/docker.ts): agent-work/store is the shared pnpm store,
# agent-work/tasks/<task-id> is this container's workspace — set directly as
# the container's WorkingDir by dashboard/src/lib/docker.ts. Both live under
# one volume so pnpm can hardlink packages into node_modules instead of copying them.
# Creating it here, owned by agent, matters: Docker populates a fresh named
# volume from the image's mountpoint content AND ownership, so the volume
# arrives agent-writable without any runtime chown (the entrypoint runs as
# agent and cannot chown a root-owned volume).
RUN groupadd --system agent \
    && useradd --system --gid agent --create-home --shell /bin/bash agent \
    && mkdir -p /workspace /home/agent/.claude /agent-work/store /agent-work/tasks \
    && chown -R agent:agent /workspace /home/agent /agent-work

# Working directory for the repo clone
WORKDIR /workspace

USER agent

# ─── Pre-install the default plugin set at build time ───
# Runs as `agent` so plugins land in /home/agent/.claude/{plugins,settings.json}.
# Neither is touched by the read-only ~/.claude/.claude.json mount at runtime, so
# the baked install + enablement survive. The entrypoint only tops up plugins NOT
# already present, so AGENT_PLUGINS can still add extras at runtime without a
# rebuild. Keep BAKED_PLUGINS in sync with AGENT_PLUGINS in .env.example.
ARG BAKED_PLUGINS="anthropics/claude-plugins-official:superpowers,anthropics/claude-plugins-official:code-simplifier,anthropics/claude-plugins-official:frontend-design,anthropics/claude-plugins-official:figma"
RUN CLAUDE_CODE_OAUTH_TOKEN=dummy bash -c '\
  declare -A seen; \
  IFS="," read -ra entries <<< "$BAKED_PLUGINS"; \
  for e in "${entries[@]}"; do \
    mp="${e%%:*}"; pl="${e#*:}"; \
    if [ -z "${seen[$mp]+x}" ]; then claude plugins marketplace add "$mp"; seen[$mp]=1; fi; \
    claude plugins install "$pl"; \
  done'

ENTRYPOINT ["/entrypoint.sh"]
