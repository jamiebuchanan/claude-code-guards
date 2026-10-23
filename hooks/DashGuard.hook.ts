#!/usr/bin/env bun
/**
 * DashGuard.hook.ts - Enforce a no em/en dash rule (PreToolUse)
 *
 * PURPOSE:
 * A CLAUDE.md line that bans em and en dashes is advice, and the model drifts back to
 * them. If you want them out of everything published under your name, a hook is the
 * deterministic version of that rule: it always runs, rather than relying on the model
 * to remember.
 *
 * DECISION LOGIC (deny with a reason, so the model rewrites and retries):
 * - Write: deny if the new content has MORE dashes than the file already had.
 *   Rewriting a file that already contains dashes is allowed as long as none are added.
 * - Edit / MultiEdit: deny if new_string adds dashes relative to old_string.
 * - Bash: only outward text (git commit, gh pr/issue create|edit|comment, and any CLI
 *   named in DASHGUARD_OUTWARD_CLIS) is checked; any dash in the command is denied.
 * - Slack and Gmail claude.ai connector send/draft tools: any dash in the input is denied.
 *
 * CONFIG: DASHGUARD_OUTWARD_CLIS, a space-separated list of your own CLIs that send text
 * to other people (mail helpers, chat posters). Letters, digits, _ and - only.
 *
 * ESCAPE: quoting someone else's words verbatim may need their dashes. Include the
 * marker `verbatim-dash-ok` in the added text and the check is skipped.
 *
 * Fails open: parse errors or unexpected input exit 0 without a decision.
 * Dash characters are written as \u escapes so this file itself contains none.
 */

import { existsSync, readFileSync, statSync } from "fs";

const DASH = /[\u2013\u2014]/g;
const MARKER = "verbatim-dash-ok";
const count = (s: unknown): number =>
  typeof s === "string" ? (s.match(DASH) || []).length : 0;

const extraClis = (process.env.DASHGUARD_OUTWARD_CLIS || "")
  .split(/\s+/)
  .filter((n) => /^[A-Za-z0-9_-]+$/.test(n));
const OUTWARD_BASH = new RegExp(
  [
    "\\bgit\\s+commit\\b",
    "\\bgh\\s+(pr|issue)\\s+(create|edit|comment)\\b",
    ...extraClis.map((n) => `(^|[^A-Za-z0-9_-])${n}([^A-Za-z0-9_-]|$)`),
  ].join("|"),
);
const OUTWARD_MCP =
  /^mcp__claude_ai_(Slack__slack_(send_message|send_message_draft|schedule_message|create_canvas|update_canvas)|Gmail__(create_draft|update_draft|send_message|reply|forward))$/;

function deny(added: number, where: string): never {
  const reason =
    `Blocked by DashGuard: this ${where} adds ${added} em/en dash character(s). ` +
    `This hook bans them in everything written or sent. ` +
    `Replace each with a comma, full stop, colon, parentheses or a normal hyphen, then retry. ` +
    `If you are quoting someone else's words verbatim, include the marker ${MARKER} in the added text.`;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  let data: any;
  try {
    data = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
  const tool: string = data?.tool_name || "";
  const input = data?.tool_input || {};

  if (tool === "Write") {
    const content: string = input.content ?? "";
    if (content.includes(MARKER)) process.exit(0);
    let before = 0;
    const p: string = input.file_path ?? "";
    try {
      if (p && existsSync(p) && statSync(p).size < 5_000_000) before = count(readFileSync(p, "utf-8"));
    } catch {}
    const added = count(content) - before;
    if (added > 0) deny(added, `write to ${p}`);
  } else if (tool === "Edit") {
    if (String(input.new_string ?? "").includes(MARKER)) process.exit(0);
    const added = count(input.new_string) - count(input.old_string);
    if (added > 0) deny(added, "edit");
  } else if (tool === "MultiEdit") {
    const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
    if (edits.some((e) => String(e?.new_string ?? "").includes(MARKER))) process.exit(0);
    const added = edits.reduce((n, e) => n + count(e?.new_string) - count(e?.old_string), 0);
    if (added > 0) deny(added, "multi-edit");
  } else if (tool === "Bash") {
    const cmd: string = input.command ?? "";
    if (OUTWARD_BASH.test(cmd) && !cmd.includes(MARKER)) {
      const n = count(cmd);
      if (n > 0) deny(n, "outward command (commit, PR, issue or message)");
    }
  } else if (OUTWARD_MCP.test(tool)) {
    const text = JSON.stringify(input);
    if (!text.includes(MARKER)) {
      const n = count(text);
      if (n > 0) deny(n, "outbound message");
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
