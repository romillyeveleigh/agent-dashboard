#!/bin/bash
set -euo pipefail
# This file is baked into the Docker image. After editing, rebuild:
#   docker build --no-cache -t agent-worker:local -f docker/Dockerfile .

ENTRYPOINT_START=$SECONDS

# ─── Validate required env vars ───
for var in CLAUDE_CODE_OAUTH_TOKEN TASK_ID DASHBOARD_URL AGENT_PROMPT REPO_URL; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is required" >&2
    exit 1
  fi
done

# ─── Workspace path (co-located with the shared pnpm store) ───
# docker.ts already created and chown'd /agent-work/tasks/${TASK_ID} before
# this container started, and set it as the container's WorkingDir — so
# $PWD is already correct from the moment this script starts. No mkdir/ln
# needed here.
export WORKSPACE_DIR="/agent-work/tasks/${TASK_ID}"

# corepack's shims may download the packageManager version on first use —
# never prompt (no TTY in containers; a prompt would hang startup / agent shells).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# ─── Resume fast-path: reuse an existing workspace instead of re-cloning ───
# RESUME_SESSION_ID is set when the dashboard is resuming a suspended
# task in a fresh container. The workspace dir + session transcripts (see the
# claude-sessions symlink block after setup, below) must already be sitting
# on the shared volume for this to do anything useful — docker.ts's
# pre-creation step is resume-aware: it skips the rm -rf wipe when
# RESUME_SESSION_ID is set, so a preserved workspace survives to this point.
if [ -n "${RESUME_SESSION_ID:-}" ] && [ -d "$WORKSPACE_DIR" ]; then
  echo "Resuming task ${TASK_ID} (session ${RESUME_SESSION_ID}) — reusing workspace"
  rm -f "$WORKSPACE_DIR/.suspended" /workspace/.suspended
  RESUME_FAST_PATH=1
else
  RESUME_FAST_PATH=0
fi

# Single EXIT trap for the whole script. Bash REPLACES (does not stack) EXIT
# handlers, so this must be the ONLY place this script traps EXIT — do not add
# a second `trap ... EXIT` anywhere below; extend cleanup() instead.
cleanup() {
  # A suspended task keeps its workspace + session transcripts for resume.
  # The supervisor (docker/supervisor/src/index.ts) currently writes its
  # suspend marker to the literal /workspace/.suspended path; check both that
  # and $WORKSPACE_DIR/.suspended so cleanup is correct however that marker
  # ends up being written.
  if [ ! -f "$WORKSPACE_DIR/.suspended" ] && [ ! -f /workspace/.suspended ]; then
    rm -rf "$WORKSPACE_DIR"
  fi
  [ -n "${MCP_CONFIG_FILE:-}" ] && rm -f "$MCP_CONFIG_FILE"
}
trap cleanup EXIT

# ─── Diagnostic buffer + error trap ───
# AutoRemove=true on the container means the dashboard cannot inspect
# post-mortem state. This trap catches any set -e failure during setup and
# POSTs the failing command + recent stdout/stderr to the dashboard's
# /api/tasks/:id/logs endpoint before the container dies.
SETUP_LOG=/tmp/setup.log
: > "$SETUP_LOG"
exec > >(tee -a "$SETUP_LOG") 2> >(tee -a "$SETUP_LOG" >&2)

on_setup_error() {
  local exit_code=$?
  local line_no=$1
  local cmd=$2
  local tail_text
  tail_text=$(tail -n 100 "$SETUP_LOG" 2>/dev/null || echo '(no log captured)')
  local payload
  payload=$(python3 -c '
import json, sys
line_no, exit_code, cmd, tail = sys.argv[1:]
print(json.dumps([{
  "type": "error",
  "content": f"Entrypoint failed at line {line_no}, exit {exit_code}\nCommand: {cmd}\n---\n{tail}"
}]))
' "$line_no" "$exit_code" "$cmd" "$tail_text" 2>/dev/null) || payload=''
  if [ -n "$payload" ]; then
    curl -sf -m 5 -X POST "${DASHBOARD_URL}/api/tasks/${TASK_ID}/logs" \
      -H "Content-Type: application/json" \
      -H "x-agent-token: ${AGENT_TOKEN:-}" \
      -d "$payload" > /dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap 'on_setup_error $LINENO "$BASH_COMMAND"' ERR

# ─── Configure git ───
STEP_START=$SECONDS
GH_NAME=$(GH_TOKEN="$GITHUB_TOKEN" gh api user --jq '.name // .login')
GH_EMAIL=$(GH_TOKEN="$GITHUB_TOKEN" gh api user --jq '.email // "\(.id)+\(.login)@users.noreply.github.com"')
git config --global user.name "$GH_NAME"
git config --global user.email "$GH_EMAIL"
git config --global --add safe.directory "$WORKSPACE_DIR"
echo "[timing] git config: $((SECONDS - STEP_START))s"

# ─── Configure GitHub CLI ───
STEP_START=$SECONDS
if [ -n "${GITHUB_TOKEN:-}" ]; then
  if ! gh_out=$(echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>&1); then
    echo "WARN: gh auth login failed — PR/comment fetches will fail later: $gh_out" >&2
  fi
fi
echo "[timing] gh auth: $((SECONDS - STEP_START))s"

# ─── Top up any plugins not already baked into the image ───
# AGENT_PLUGINS: comma-separated "marketplace:plugin" pairs. The default set is
# pre-installed at build time (see Dockerfile), so this normally finds nothing to
# do: one `claude plugins list` call, then install only the entries that are
# missing (e.g. an extra plugin a deployment added to AGENT_PLUGINS).
STEP_START=$SECONDS
if [ -n "${AGENT_PLUGINS:-}" ]; then
  # Installed plugin ids are reported as "<plugin>@<marketplace>". Collect once.
  installed=$(claude plugins list --json 2>/dev/null | python3 -c 'import json,sys
try:
    print("\n".join(p.get("id","") for p in json.load(sys.stdin)))
except Exception:
    pass')
  declare -A ADDED_MARKETPLACES
  PLUGIN_FAIL_COUNT=0
  TOPUP_COUNT=0
  IFS=',' read -ra PLUGIN_ENTRIES <<< "${AGENT_PLUGINS}"
  for entry in "${PLUGIN_ENTRIES[@]}"; do
    marketplace="${entry%%:*}"
    plugin="${entry#*:}"
    # Skip if already installed (baked at build time, or an earlier iteration).
    if printf '%s\n' "$installed" | grep -q "^${plugin}@"; then
      continue
    fi
    TOPUP_COUNT=$((TOPUP_COUNT + 1))
    if [ -z "${ADDED_MARKETPLACES[$marketplace]+_}" ]; then
      if ! mp_out=$(claude plugins marketplace add "$marketplace" 2>&1); then
        echo "WARN: failed to add marketplace '$marketplace': $mp_out" >&2
        PLUGIN_FAIL_COUNT=$((PLUGIN_FAIL_COUNT + 1))
      fi
      ADDED_MARKETPLACES[$marketplace]=1
    fi
    if ! pl_out=$(claude plugins install "$plugin" 2>&1); then
      echo "WARN: failed to install plugin '$plugin': $pl_out" >&2
      PLUGIN_FAIL_COUNT=$((PLUGIN_FAIL_COUNT + 1))
    fi
  done
  echo "Plugins: ${TOPUP_COUNT} topped up, ${PLUGIN_FAIL_COUNT} failed (rest pre-baked)"
fi
echo "[timing] plugin install: $((SECONDS - STEP_START))s"

if [ "$RESUME_FAST_PATH" != "1" ]; then
# ─── Clone repo (use host mount as local reference if available) ───
# git refuses --reference against a shallow repo. If the host repo got
# shallow (e.g. a depth-limited fetch), fall back to a plain
# remote clone so dispatches don't break silently.
STEP_START=$SECONDS
if [ -d "/repo-cache/.git" ] && [ "$(git -C /repo-cache rev-parse --is-shallow-repository 2>/dev/null)" = "false" ]; then
  echo "Cloning from host mount (local reference)..."
  git clone --reference /repo-cache "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" "$WORKSPACE_DIR"
  echo "[timing] git clone --reference: $((SECONDS - STEP_START))s"
else
  if [ -d "/repo-cache/.git" ]; then
    echo "WARN: /repo-cache is shallow — skipping --reference and cloning from remote"
  else
    echo "No host mount found, cloning from remote..."
  fi
  # Clone and checkout are timed separately so startup cost can be attributed.
  # `--no-checkout` then `reset --hard` materializes the tree as a separate step
  # (a bare `checkout HEAD` would no-op on the empty tree).
  CLONE_START=$SECONDS
  git clone --no-checkout "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_URL}.git" "$WORKSPACE_DIR"
  echo "[timing] git clone fetch/objects: $((SECONDS - CLONE_START))s"
  CHECKOUT_START=$SECONDS
  git -C "$WORKSPACE_DIR" reset --hard HEAD
  echo "[timing] git clone checkout (working tree): $((SECONDS - CHECKOUT_START))s"
fi
fi

# ─── Exclude runtime-generated files from git (local-only, never committed) ───
# Belt-and-suspenders: set both repo-level and global excludes so `git add --all`
# never stages skill files, AGENTS.md, or .claude/ changes
echo '.claude/' >> "$WORKSPACE_DIR/.git/info/exclude"
echo '.agents/' >> "$WORKSPACE_DIR/.git/info/exclude"
echo 'AGENTS.md' >> "$WORKSPACE_DIR/.git/info/exclude"
echo '.agent-install-failed' >> "$WORKSPACE_DIR/.git/info/exclude"
echo 'claude-sessions/' >> "$WORKSPACE_DIR/.git/info/exclude"
printf '.claude/\n.agents/\nAGENTS.md\nclaude-sessions/\n' > /tmp/agent-excludes
git config --global core.excludesFile /tmp/agent-excludes

# ─── Install dependencies (co-located pnpm store) ───
# agent-work/store is a named Docker volume shared across all containers
# (mounted in dashboard/src/lib/docker.ts, ownership set in docker/Dockerfile).
# pnpm's store is content-addressable and safe for concurrent writers: the
# first container ever pays the full download, later ones only copy from
# disk. $WORKSPACE_DIR is set as this container's WorkingDir directly (see
# dashboard/src/lib/docker.ts) inside the SAME agent-work volume as the
# store, so pnpm hardlinks cached package files into node_modules instead of
# copying them — installs stay fast (seconds, not minutes) even when several
# containers install at once.
# pnpm_config_store_dir is exported (not pnpm config) so the agent's own pnpm
# invocations inherit the shared store too.
# Failure is NON-fatal: agents can still work without node_modules (and install
# themselves if needed). A marker file tells the agent what happened — the
# container rules in docker/.claude/CLAUDE.md reference it by name.
# The pnpm workspace may live in a subdirectory, so locate the nearest lockfile
# instead of assuming $WORKSPACE_DIR itself is the workspace root.
if [ "$RESUME_FAST_PATH" != "1" ]; then
STEP_START=$SECONDS
PNPM_LOCK=$(find "$WORKSPACE_DIR" -maxdepth 2 -name pnpm-lock.yaml -not -path '*/node_modules/*' -print -quit)
if [ -n "$PNPM_LOCK" ]; then
  PNPM_DIR=$(dirname "$PNPM_LOCK")
  echo "pnpm workspace: $PNPM_DIR"
  # The "Container ready" status only posts after this step — without a status
  # here, a cold-store install looks like a dead container from the dashboard.
  curl -sf -m 5 -X POST "${DASHBOARD_URL}/api/status" \
    -H "Content-Type: application/json" \
    -H "x-agent-token: ${AGENT_TOKEN:-}" \
    -d "{\"task_id\": \"${TASK_ID}\", \"status\": \"running\", \"message\": \"Installing dependencies (shared pnpm store)\"}" \
    > /dev/null 2>&1 || true
  if [ -w /agent-work/store ]; then
    # Both spellings kept for older pnpm; pnpm 10+ only honours pnpm_config_*
    export npm_config_store_dir=/agent-work/store
    export pnpm_config_store_dir=/agent-work/store
  else
    echo "WARN: /agent-work/store not writable — falling back to per-container store (slow)" >&2
  fi
  # corepack's pnpm shim reads packageManager from $PNPM_DIR/package.json, so
  # install uses the same pnpm version as the repo's CI.
  if PKG_MGR=$(node -e "try{process.stdout.write(require(process.argv[1]).packageManager||'')}catch(e){}" "$PNPM_DIR/package.json"); then
    if [ -n "$PKG_MGR" ]; then
      echo "packageManager: $PKG_MGR"
    fi
  fi
  if (cd "$PNPM_DIR" && pnpm install --frozen-lockfile --prefer-offline > /tmp/pnpm-install.log 2>&1); then
    echo "pnpm install: ok"
  else
    tail -n 20 /tmp/pnpm-install.log >&2 || true
    echo "WARN: pnpm install failed — agent must install manually before running checks" >&2
    echo "Entrypoint pnpm install failed at startup. Run pnpm install in the foreground before tests/typecheck; delete this file once it succeeds." > "$WORKSPACE_DIR/.agent-install-failed"
  fi
else
  echo "No pnpm-lock.yaml in repo — skipping dependency install"
fi
echo "[timing] pnpm install: $((SECONDS - STEP_START))s"
fi

# ─── Install headless skills into cloned repo ───
if [ "$RESUME_FAST_PATH" != "1" ]; then
STEP_START=$SECONDS
echo "Installing skills into workspace..."
mkdir -p "$WORKSPACE_DIR/.claude/skills"
cp -r /opt/skills/* "$WORKSPACE_DIR/.claude/skills/"
# Skill source files use /workspace as a literal path. Substitute the real
# path into the copies rather than editing skill source.
find "$WORKSPACE_DIR/.claude/skills" -type f -exec sed -i "s|/workspace|${WORKSPACE_DIR}|g" {} +
echo "[timing] install skills: $((SECONDS - STEP_START))s"
fi

# ─── Write container rules to the user-level CLAUDE.md ───
# User-level, not in the repo: a CLAUDE.md anywhere in the repo switches off
# Claude Code's AGENTS.md loading. Runs on resume too —
# $HOME is fresh each container start.
if [ -f /opt/claude-md/CLAUDE.md ]; then
  mkdir -p "$HOME/.claude"
  # CLAUDE.md's source (docker/.claude/CLAUDE.md) is human-authored and reads
  # "/workspace" for readability — substitute the real path at injection time
  # instead of hand-editing the source, so the doc keeps reading naturally.
  sed "s|/workspace|${WORKSPACE_DIR}|g" /opt/claude-md/CLAUDE.md > "$HOME/.claude/CLAUDE.md"
  echo "Wrote container rules to ~/.claude/CLAUDE.md"
fi

# ─── Persist Claude Code session transcripts on the shared volume ───
# A suspended task can then be resumed by a later container. ~/.claude/projects
# is where the harness writes session JSONL; point it at the workspace dir.
# Runs AFTER the clone (git refuses to clone into a non-empty directory — a
# pre-clone claude-sessions/ dir hard-fails the clone with exit 128) and
# OUTSIDE the RESUME_FAST_PATH guard: on resume the dir already holds the
# suspended session's transcripts and mkdir -p / re-linking are idempotent.
# claude-sessions/ is covered by the git-excludes block above so it never
# shows as untracked. (~/.claude is verified empty of projects/ at image
# build time — only plugins/, settings.json, backups/ are baked — so the
# rm -rf never clobbers baked content.)
mkdir -p "$WORKSPACE_DIR/claude-sessions" "$HOME/.claude"
rm -rf "$HOME/.claude/projects"
ln -s "$WORKSPACE_DIR/claude-sessions" "$HOME/.claude/projects"

# ─── Hide tracked files modified at runtime from git ───
git -C "$WORKSPACE_DIR" update-index --assume-unchanged AGENTS.md 2>/dev/null || true

# assume-unchanged hides dirt from `git status`, not from checkout. If the
# target branch has a different AGENTS.md/.claude/CLAUDE.md blob, git aborts.
# Wrap git so injected copies are restored around the switch. Runs on
# resume too — wrappers live in $HOME, which is fresh each container start.
# shellcheck source=/opt/protect-injected.sh
AGENT_PROTECT_SRC=/opt/protect-injected.sh
source "$AGENT_PROTECT_SRC"
AGENT_BIN="$HOME/bin"
install_injected_file_guards "$AGENT_BIN" "$(command -v git)"
export PATH="$AGENT_BIN:$PATH"

# ─── Report ready to dashboard ───
STEP_START=$SECONDS
curl -sf -X POST "${DASHBOARD_URL}/api/status" \
  -H "Content-Type: application/json" \
  -H "x-agent-token: ${AGENT_TOKEN:-}" \
  -d "{\"task_id\": \"${TASK_ID}\", \"status\": \"running\", \"message\": \"Container ready, starting Claude Code\"}" \
  || echo "Warning: Could not reach dashboard at ${DASHBOARD_URL}"
echo "[timing] dashboard report: $((SECONDS - STEP_START))s"

# ─── Resolve model from task mode ───
# Mechanical modes run on a faster model; high-stakes modes (plan, review,
# ship) on the strongest. A global AGENT_MODEL overrides everything (escape
# hatch); each mapped mode also has its own AGENT_MODEL_<MODE> override so the
# mapping can be retuned via env without rebuilding the image. Aliases
# (haiku/sonnet/opus) resolve to the container's installed Claude Code latest
# for that tier.
resolve_model() {
  if [ -n "${AGENT_MODEL:-}" ]; then echo "$AGENT_MODEL"; return; fi
  case "${MODE:-}" in
    housekeeping) echo "${AGENT_MODEL_HOUSEKEEPING:-haiku}" ;;
    plan)         echo "${AGENT_MODEL_PLAN:-opus}" ;;
    review)       echo "${AGENT_MODEL_REVIEW:-opus}" ;;
    ship)         echo "${AGENT_MODEL_SHIP:-opus}" ;;
    *)            echo "${AGENT_MODEL_DEFAULT:-sonnet}" ;;
  esac
}
AGENT_MODEL_RESOLVED="$(resolve_model)"
echo "[model] MODE=${MODE:-<none>} -> ${AGENT_MODEL_RESOLVED}"

# ─── Run the supervisor (owns Claude Code, MCP config, logs, final status) ───
echo "[timing] total startup: $((SECONDS - ENTRYPOINT_START))s"
echo "Starting supervisor${MODE:+ in ${MODE} mode} on model ${AGENT_MODEL_RESOLVED}..."
# Disable the setup ERR trap — the supervisor's exit is captured directly below
# and reported to the dashboard as a regular final-status update. It also owns
# posting its own status/logs to the dashboard, so on_setup_error firing after
# this point would be redundant at best.
trap - ERR
export AGENT_MODEL_RESOLVED
# Deliberately NOT `exec`: bash `exec` replaces the shell process and skips
# the EXIT trap, which is what makes the suspend-aware cleanup() above run.
# Plain invocation + explicit exit keeps the trap intact for every exit path
# (normal completion, suspend, and any non-zero supervisor exit).
node /opt/supervisor/dist/index.js
exit $?
