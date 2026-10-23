#!/bin/bash
# guard-run.sh: fail-closed runner for the bun PreToolUse guards.
#
# Claude Code treats exit 2 as a block and any other non-zero exit as a non-blocking
# error. A guard started through its `#!/usr/bin/env bun` shebang therefore PASSES the
# tool call when bun is not on PATH (env exits 127). In practice that is how hundreds of
# guard runs failed open on one machine before anyone noticed. This runner finds bun
# without trusting PATH and blocks when it cannot.
#
# Usage in settings.json: "\"$HOME/.claude/hooks/lib/guard-run.sh\" DashGuard.hook.ts"

hook="${1:-}"
hooks_dir="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$hook" ] || [ ! -f "$hooks_dir/$hook" ]; then
  echo "BLOCKED: guard '${hook:-<none>}' not found in $hooks_dir. Refusing the tool call rather than skipping the check." >&2
  exit 2
fi

bun_bin="$(command -v bun 2>/dev/null)"
[ -n "$bun_bin" ] && [ -x "$bun_bin" ] || bun_bin="$HOME/.bun/bin/bun"
if [ ! -x "$bun_bin" ]; then
  echo "BLOCKED: guard $hook cannot run because bun was not found (PATH or ~/.bun/bin). Refusing the tool call rather than skipping the check." >&2
  exit 2
fi

exec "$bun_bin" "$hooks_dir/$hook"
