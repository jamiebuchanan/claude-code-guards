#!/usr/bin/env bash
# MailSendGuard.hook.sh  (PreToolUse, Bash)
#
# HARD BLOCK on an agent sending mail from a mailbox that should only ever get drafts.
#
# Why this exists: to let an agent create Gmail drafts, its OAuth token needs
# gmail.compose. Google has no draft-only scope, and compose also grants send, so the
# scope is NOT the safeguard. Neither is the helper script's command surface: the token
# sits on disk or in the keychain, and the send API is one curl away. A prose rule
# ("never send") is advice, not a control. This hook is the control.
#
# The cost it protects against: a wrong send in your name to a client, a supplier or a
# regulator cannot be recalled. Drafting is fine; sending is a human's
# job, by hand, in Gmail.
#
# CONFIG: MAIL_SEND_GUARD_CLIS, a space-separated list of your own mail helper names
# (letters, digits, _ and - only, extension optional), e.g. "work-mail personal-mail".
# For each name, `<name> send` and `<name>.<ext> send` are blocked. The Gmail REST send
# endpoints (users/<id>/messages/send and users/<id>/drafts/send) are blocked whatever
# the setting.
#
# Fails CLOSED when jq is missing: a guard that cannot run must block. Parse errors on a
# single input still pass, and a match always blocks.

set -u
command -v jq >/dev/null 2>&1 || PATH="/usr/bin:/opt/homebrew/bin:$PATH"
command -v jq >/dev/null 2>&1 || { echo "BLOCKED: MailSendGuard cannot run because jq was not found. Refusing the call rather than skipping the check." >&2; exit 2; }
input=$(cat 2>/dev/null) || exit 0
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$tool" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

deny() {
  jq -n --arg r "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  exit 0
}

# 1) The send subcommand of any configured draft-only helper. Word-bounded, so
#    `work-mail search "...send..."` is unaffected.
for name in ${MAIL_SEND_GUARD_CLIS:-}; do
  case "$name" in *[!A-Za-z0-9_-]*) continue ;; esac
  if printf '%s' "$cmd" | grep -Eq "(^|[^A-Za-z0-9_-])${name}(\.[A-Za-z]+)?[[:space:]]+send([[:space:]]|$)"; then
    deny "Blocked by MailSendGuard: $name is a draft-only mail helper, by design. Create a draft instead and let the user review and send it in Gmail. Sending from this mailbox is the user's job, not the agent's."
  fi
done

# 2) Gmail REST send endpoints (messages.send, drafts.send), however they're called. The
#    user id can be `me` or a full address, so any id segment matches.
if printf '%s' "$cmd" | grep -Eq 'users/[^/[:space:]]+/(messages|drafts)/send'; then
  deny "Blocked by MailSendGuard: direct calls to the Gmail send API are not permitted from this machine. A token that can draft can also send (gmail.compose includes send), so this hook is the boundary rather than the scope. Create a draft and let the user send it by hand."
fi

exit 0
