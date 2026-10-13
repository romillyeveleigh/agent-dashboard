#!/usr/bin/env bash
# Guard branch switches so container-injected files cannot block checkout.
# Sourced by entrypoint.sh and by the git wrapper it installs.
#
# assume-unchanged hides dirt from `git status`. It does not hide it from
# checkout/switch/rebase. If the target branch has a different blob for
# AGENTS.md (or .claude/CLAUDE.md), git aborts. These wrappers snapshot the
# working-tree copies, restore HEAD, run the real command, then put the
# injected copies back.

INJECTED_TRACKED_FILES=(
  AGENTS.md
  .claude/CLAUDE.md
)

AGENT_PROTECT_SAVE_DIR="${AGENT_PROTECT_SAVE_DIR:-${TMPDIR:-/tmp}/agent-injected-save}"

_protect_real_git() {
  echo "${AGENT_PROTECT_REAL_GIT:-/usr/bin/git}"
}

_protect_parse_git_command() {
  # Sets: PROTECT_GIT_DIR, PROTECT_GIT_CMD, PROTECT_GIT_HAS_PATHSPEC
  PROTECT_GIT_DIR=""
  PROTECT_GIT_CMD=""
  PROTECT_GIT_HAS_PATHSPEC=0
  local skipping_arg=0
  local arg
  for arg in "$@"; do
    if [ "$skipping_arg" = 1 ]; then
      skipping_arg=0
      continue
    fi
    case "$arg" in
      -C)
        skipping_arg=1
        # next iteration captures the dir via a dedicated pass below
        ;;
      -c|--git-dir|--work-tree|--namespace)
        skipping_arg=1
        ;;
      --)
        PROTECT_GIT_HAS_PATHSPEC=1
        ;;
      -*)
        ;;
      *)
        if [ -z "$PROTECT_GIT_CMD" ]; then
          PROTECT_GIT_CMD=$arg
        fi
        ;;
    esac
  done
  skipping_arg=0
  local prev=""
  for arg in "$@"; do
    if [ "$prev" = "-C" ]; then
      PROTECT_GIT_DIR=$arg
    fi
    prev=$arg
  done
}

_protect_should_guard_git() {
  case "$PROTECT_GIT_CMD" in
    checkout)
      [ "$PROTECT_GIT_HAS_PATHSPEC" = 0 ]
      ;;
    switch|rebase|merge|pull|cherry-pick|reset)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

_protect_repo_root() {
  local real_git
  real_git=$(_protect_real_git)
  if [ -n "$PROTECT_GIT_DIR" ]; then
    "$real_git" -C "$PROTECT_GIT_DIR" rev-parse --show-toplevel 2>/dev/null
  else
    "$real_git" rev-parse --show-toplevel 2>/dev/null
  fi
}

_protect_save_injected() {
  local root=$1
  local f dest
  rm -rf "$AGENT_PROTECT_SAVE_DIR"
  mkdir -p "$AGENT_PROTECT_SAVE_DIR"
  for f in "${INJECTED_TRACKED_FILES[@]}"; do
    if [ -e "$root/$f" ]; then
      dest="$AGENT_PROTECT_SAVE_DIR/$f"
      mkdir -p "$(dirname "$dest")"
      cp -a "$root/$f" "$dest"
    fi
  done
}

_protect_restore_head() {
  local root=$1
  local real_git f
  real_git=$(_protect_real_git)
  for f in "${INJECTED_TRACKED_FILES[@]}"; do
    "$real_git" -C "$root" update-index --no-assume-unchanged "$f" 2>/dev/null || true
    if "$real_git" -C "$root" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      "$real_git" -C "$root" checkout -q HEAD -- "$f" 2>/dev/null || true
    elif [ -e "$root/$f" ]; then
      rm -f "$root/$f"
    fi
  done
}

_protect_restore_injected() {
  local root=$1
  local real_git f
  real_git=$(_protect_real_git)
  for f in "${INJECTED_TRACKED_FILES[@]}"; do
    if [ -e "$AGENT_PROTECT_SAVE_DIR/$f" ]; then
      mkdir -p "$(dirname "$root/$f")"
      cp -a "$AGENT_PROTECT_SAVE_DIR/$f" "$root/$f"
    fi
    "$real_git" -C "$root" update-index --assume-unchanged "$f" 2>/dev/null || true
  done
}

_protect_run_with_guard() {
  local root=$1
  shift
  _protect_save_injected "$root"
  _protect_restore_head "$root"
  local status=0
  AGENT_INJECTED_GUARD=1 "$@" || status=$?
  _protect_restore_injected "$root"
  return "$status"
}

run_guarded_git() {
  local real_git
  real_git=$(_protect_real_git)
  if [ -n "${AGENT_INJECTED_GUARD:-}" ]; then
    "$real_git" "$@"
    return $?
  fi
  _protect_parse_git_command "$@"
  if ! _protect_should_guard_git; then
    "$real_git" "$@"
    return $?
  fi
  local root
  root=$(_protect_repo_root) || true
  if [ -z "$root" ]; then
    "$real_git" "$@"
    return $?
  fi
  _protect_run_with_guard "$root" "$real_git" "$@"
}

install_injected_file_guards() {
  local bindir=$1
  local real_git=$2
  local src="${AGENT_PROTECT_SRC:-}"
  if [ -z "$src" ]; then
    src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/protect-injected.sh"
  fi
  mkdir -p "$bindir"
  local bindir_abs real_git_abs
  bindir_abs=$(cd "$bindir" && pwd)
  real_git_abs=$(cd "$(dirname "$real_git")" && pwd)/$(basename "$real_git")
  if [ "$real_git_abs" = "$bindir_abs/git" ]; then
    echo "install_injected_file_guards: refusing to wrap $real_git (it is the wrapper)" >&2
    return 1
  fi
  real_git=$real_git_abs
  cat > "$bindir/git" <<EOF
#!/bin/bash
export AGENT_PROTECT_REAL_GIT=$(printf '%q' "$real_git")
# shellcheck source=/dev/null
source $(printf '%q' "$src")
run_guarded_git "\$@"
EOF
  chmod +x "$bindir/git"
}
