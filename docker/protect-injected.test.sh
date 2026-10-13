#!/usr/bin/env bash
# RED/GREEN tests for docker/protect-injected.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_GIT=$(command -v git)
PASS=0
FAIL=0

assert_eq() {
  local actual=$1 expected=$2 msg=$3
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    echo "PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $msg"
    echo "  expected: $expected"
    echo "  actual:   $actual"
  fi
}

assert_ok() {
  local msg=$1
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    echo "PASS: $msg"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $msg"
  fi
}

setup_repo() {
  local root=$1
  git -C "$root" init -q -b main
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name test
  echo 'main-agents' > "$root/AGENTS.md"
  mkdir -p "$root/.claude"
  echo 'main-claude' > "$root/.claude/CLAUDE.md"
  git -C "$root" add AGENTS.md .claude/CLAUDE.md
  git -C "$root" commit -q -m init
  git -C "$root" checkout -q -b feature
  echo 'feature-agents' > "$root/AGENTS.md"
  echo 'feature-claude' > "$root/.claude/CLAUDE.md"
  git -C "$root" add AGENTS.md .claude/CLAUDE.md
  git -C "$root" commit -q -m feature
  git -C "$root" checkout -q main
  echo 'injected-agents' > "$root/AGENTS.md"
  echo 'injected-claude' > "$root/.claude/CLAUDE.md"
  git -C "$root" update-index --assume-unchanged AGENTS.md .claude/CLAUDE.md
}

# Baseline: dirty injected files block checkout when the blob differs.
baseline=$(mktemp -d)
setup_repo "$baseline"
if git -C "$baseline" checkout -q feature 2>/dev/null; then
  FAIL=$((FAIL + 1))
  echo "FAIL: baseline checkout should abort on dirty AGENTS.md"
else
  PASS=$((PASS + 1))
  echo "PASS: baseline checkout aborts on dirty AGENTS.md"
fi
rm -rf "$baseline"

# Guard: checkout succeeds and injected content is restored.
# shellcheck source=protect-injected.sh
source "$SCRIPT_DIR/protect-injected.sh"

guarded=$(mktemp -d)
setup_repo "$guarded"
bin="$guarded/bin"
install_injected_file_guards "$bin" "$HOST_GIT"
export PATH="$bin:$PATH"

assert_ok "guarded checkout feature succeeds" git -C "$guarded" checkout -q feature
assert_eq "$(git -C "$guarded" branch --show-current)" feature "now on feature"
assert_eq "$(cat "$guarded/AGENTS.md")" injected-agents "AGENTS.md stays injected"
assert_eq "$(cat "$guarded/.claude/CLAUDE.md")" injected-claude "CLAUDE.md stays injected"
if git -C "$guarded" ls-files -v | grep -q '^h AGENTS.md'; then
  PASS=$((PASS + 1))
  echo "PASS: AGENTS.md is assume-unchanged again"
else
  FAIL=$((FAIL + 1))
  echo "FAIL: AGENTS.md is assume-unchanged again"
  git -C "$guarded" ls-files -v || true
fi

assert_ok "second switch back to main succeeds" git -C "$guarded" checkout -q main
assert_eq "$(cat "$guarded/AGENTS.md")" injected-agents "injected content survives second switch"

# Pathspec checkout must still replace the file (pass-through).
git -C "$guarded" checkout HEAD -- AGENTS.md
assert_eq "$(cat "$guarded/AGENTS.md")" main-agents "pathspec checkout is not intercepted"

rm -rf "$guarded"

echo
echo "passed=$PASS failed=$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
