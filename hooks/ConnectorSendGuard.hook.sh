#!/bin/bash
# ConnectorSendGuard.hook.sh (PreToolUse)
#
# MailSendGuard only sees Bash, so the claude.ai Gmail and Drive connectors could send
# mail or share files in the user's name with no check from it. This hook makes every
# outbound connector verb ask the user first. The matcher in settings.json limits it to
# Gmail send_message, reply, forward and Drive share_file; read verbs never reach it.
#
# "ask" puts the call in front of the user as a permission prompt, so a send needs a
# human to approve it. Plain bash with a fixed reply, so there is no runtime that could
# be missing and fail open.

cat >/dev/null
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"ConnectorSendGuard: this sends mail or shares a file in the user's name through a claude.ai connector. Drafts are fine. Approve only if the user asked for this exact send in this conversation."}}
JSON
exit 0
