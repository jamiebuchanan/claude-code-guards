#!/usr/bin/env bash
# test/run.sh: feeds sample tool calls to each hook and checks the decision it returns.
# Needs jq, bun and node. Run from anywhere: bash test/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
hooks="$here/../hooks"
run_guard="$hooks/lib/guard-run.sh"
pass=0; fail=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
# Dashes are built from bytes so this file contains none (DashGuard would refuse to write it).
EM=$(printf '\xe2\x80\x94'); EN=$(printf '\xe2\x80\x93')

check() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); printf 'ok    %s\n' "$1"
  else fail=$((fail+1)); printf 'FAIL  %s (expected %s, got %s)\n' "$1" "$2" "${3:-<nothing>}"; fi
}
decision() { jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null; }
bash_call() { jq -cn --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}'; }

echo "== MailSendGuard"
mail() { bash_call "$1" | MAIL_SEND_GUARD_CLIS="my-mail" bash "$hooks/MailSendGuard.hook.sh" | decision; }
check "configured helper send is denied"          deny "$(mail 'node ~/bin/my-mail.mjs send --to a@example.com')"
check "configured helper bare send is denied"     deny "$(mail 'my-mail send')"
check "configured helper search is allowed"       ""   "$(mail 'my-mail search "send the report"')"
check "unconfigured helper is allowed"            ""   "$(mail 'other-mail send')"
check "Gmail API messages.send is denied"         deny "$(mail 'curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send')"
check "Gmail API drafts.send is denied"           deny "$(mail 'curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts/send')"
check "send with an address as user id denied"    deny "$(mail 'curl -X POST https://gmail.googleapis.com/gmail/v1/users/someone@example.com/messages/send')"
check "Gmail API drafts.create is allowed"        ""   "$(mail 'curl -X POST https://gmail.googleapis.com/gmail/v1/users/me/drafts')"
check "unrelated command is allowed"              ""   "$(mail 'ls -la')"

echo "== ConnectorSendGuard"
check "connector send asks the user" ask \
  "$(jq -cn '{tool_name:"mcp__claude_ai_Gmail__send_message",tool_input:{to:"a@example.com"}}' | bash "$hooks/ConnectorSendGuard.hook.sh" | decision)"

echo "== DashGuard"
dash() { DASHGUARD_OUTWARD_CLIS="my-mail" "$run_guard" DashGuard.hook.ts | decision; }
printf 'one %s here\n' "$EM" > "$tmp/existing.md"
check "write adding an em dash is denied"      deny "$(jq -cn --arg p "$tmp/new.md" --arg c "a $EM b" '{tool_name:"Write",tool_input:{file_path:$p,content:$c}}' | dash)"
check "write with a hyphen is allowed"         ""   "$(jq -cn --arg p "$tmp/new.md" --arg c "a - b" '{tool_name:"Write",tool_input:{file_path:$p,content:$c}}' | dash)"
check "rewrite keeping existing dash allowed"  ""   "$(jq -cn --arg p "$tmp/existing.md" --arg c "two $EM there" '{tool_name:"Write",tool_input:{file_path:$p,content:$c}}' | dash)"
check "edit adding an en dash is denied"       deny "$(jq -cn --arg n "x $EN y" '{tool_name:"Edit",tool_input:{old_string:"x y",new_string:$n}}' | dash)"
check "edit with verbatim marker is allowed"   ""   "$(jq -cn --arg n "x $EN y verbatim-dash-ok" '{tool_name:"Edit",tool_input:{old_string:"x y",new_string:$n}}' | dash)"
check "git commit with a dash is denied"       deny "$(bash_call "git commit -m \"fix $EM typo\"" | dash)"
check "local echo with a dash is allowed"      ""   "$(bash_call "echo \"a $EM b\"" | dash)"
check "configured outward CLI is denied"       deny "$(bash_call "my-mail draft --body \"hi $EM there\"" | dash)"
check "CLI name inside another word allowed"   ""   "$(bash_call "echo \"a $EM b\" > gmy-mail-notes.txt" | dash)"
check "Gmail connector draft is denied"        deny "$(jq -cn --arg b "hi $EM there" '{tool_name:"mcp__claude_ai_Gmail__create_draft",tool_input:{body:$b}}' | dash)"

echo "== SqlSafetyGuard"
sql_exit() { bash_call "$1" | "$run_guard" SqlSafetyGuard.hook.ts >"$tmp/sql.out" 2>/dev/null; echo $?; }
printf 'DELETE FROM users;\n' > "$tmp/danger.sql"
printf 'DELETE FROM users\nWHERE id = 2;\n' > "$tmp/scoped.sql"
check "DROP TABLE on a Supabase host blocks"   2 "$(sql_exit 'psql "postgres://u@db.abc.supabase.co/postgres" -c "DROP TABLE users;"')"
check "file DELETE on a Neon host blocks"      2 "$(sql_exit "psql -h ep-x.neon.tech -f $tmp/danger.sql")"
check "file DELETE with WHERE is allowed"      0 "$(sql_exit "psql -h ep-x.neon.tech -f $tmp/scoped.sql")"
check "UPDATE without WHERE blocks"            2 "$(sql_exit 'psql -h db.abc.supabase.co -c "UPDATE users SET a = 1;"')"
check "UPDATE with WHERE is allowed"           0 "$(sql_exit 'psql -h db.abc.supabase.co -c "UPDATE users SET a = 1 WHERE id = 2;"')"
check "bare TRUNCATE blocks"                   2 "$(sql_exit 'psql -h db.abc.supabase.co -c "TRUNCATE users;"')"
check "dry run on production is allowed"       0 "$(sql_exit 'psql "postgres://u@db.abc.supabase.co/postgres" -c "DROP TABLE users;" --dry-run')"
check "SELECT on production is allowed"       0 "$(sql_exit 'psql -h db.abc.supabase.co -c "SELECT 1"')"
sql_exit 'psql -h localhost -c "DROP TABLE users;"' >/dev/null
check "DROP TABLE on localhost warns" yes "$(jq -r 'if (.hookSpecificOutput.additionalContext // "") != "" then "yes" else "no" end' "$tmp/sql.out" 2>/dev/null)"

echo "== guard-run.sh"
echo '{}' | "$run_guard" NoSuchGuard.hook.ts >/dev/null 2>&1
check "missing guard blocks (exit 2)" 2 "$?"

echo "== session-cost-monitor"
cost() { # transcript session
  jq -cn --arg t "$1" --arg s "$2" '{transcript_path:$t,session_id:$s}' \
    | TMPDIR="$tmp" node "$hooks/session-cost-monitor.js" \
    | jq -r '.hookSpecificOutput.additionalContext // empty' | head -n1 | cut -c1-19
}
echo '{"message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":500000}}}' > "$tmp/big.jsonl"
echo '{"message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":100}}}' > "$tmp/small.jsonl"
# One message written as three content-block lines: 300k output counted once is 1.5M weighted, under NOTICE.
for i in 1 2 3; do echo '{"message":{"id":"m2","usage":{"input_tokens":10,"output_tokens":300000}}}'; done > "$tmp/dup.jsonl"
check "expensive session gets a notice"     "CONTEXT COST NOTICE" "$(cost "$tmp/big.jsonl" test-a)"
check "same tier is not repeated"           ""                    "$(cost "$tmp/big.jsonl" test-a)"
check "cheap session stays silent"          ""                    "$(cost "$tmp/small.jsonl" test-b)"
check "repeated lines of one call count once" ""                  "$(cost "$tmp/dup.jsonl" test-c)"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
