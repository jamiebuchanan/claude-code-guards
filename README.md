# claude-code-guards

Hooks and agents that turn Claude Code rules into gates. Mail does not go out in your name without you, destructive SQL aimed at a production target is stopped, em dashes do not reach anything you publish, and you get told when a session has quietly become expensive. Plus two testing agents: one that tries to break your app, and one that uses it like a stranger who has never seen the code.

I built these while running Claude Code with real credentials (mailboxes, databases, deploy keys) on real projects. Each one exists because a rule written in `CLAUDE.md` was not enough.

## Why hooks, not instructions

A rule in `CLAUDE.md` is advice. The model follows it most of the time, and for anything that cannot be undone, most of the time is not good enough. If an agent holds a token that can send mail, "never send" in a prompt is not a control. A hook that runs before the tool call, and can refuse it, is.

Three design rules run through everything here:

- **Deny with a reason.** A refusal tells the model what to do instead (draft rather than send, dry-run first, use a comma), so it fixes the call and carries on rather than stalling.
- **Fail closed where it matters.** A guard that cannot run must block, not wave the call through. Claude Code only treats exit code 2 as a block, so a bun hook whose runtime is missing silently passes everything. `guard-run.sh` exists to close that gap.
- **Ask when a human is the right check.** Some actions are fine when the user meant them. Those get a permission prompt, which a headless run cannot answer, so they cannot slip through unattended.

## What's in the box

| Piece | Event | What it does |
|---|---|---|
| `hooks/MailSendGuard.hook.sh` | PreToolUse (Bash) | Blocks the Gmail REST send endpoints (`messages/send`, `drafts/send`, for any user id) and the `send` subcommand of mail helpers you name. A token that can draft can also send (`gmail.compose` includes send), so the scope is not the safeguard. This is. |
| `hooks/ConnectorSendGuard.hook.sh` | PreToolUse (Gmail and Drive connectors) | Makes the claude.ai Gmail send, reply, forward and Drive share tools ask you first. MailSendGuard only sees Bash; this covers the connectors. |
| `hooks/SqlSafetyGuard.hook.ts` | PreToolUse (Bash) | Hard-blocks `DROP DATABASE`, `DROP SCHEMA`, `DROP TABLE`, `TRUNCATE`, `DELETE` or `UPDATE` with no `WHERE`, mass `DROP TRIGGER` and `DISABLE TRIGGER ALL` when the command names a production target. Warns, without blocking, when the target is unclear. Reads inline SQL, heredocs and `-f` files. |
| `hooks/DashGuard.hook.ts` | PreToolUse (Write, Edit, MultiEdit, Bash, Slack and Gmail connectors) | Refuses any write, commit, PR, issue or message that adds an em or en dash. Existing dashes in a file are left alone. A `verbatim-dash-ok` marker lets a genuine quotation through. |
| `hooks/session-cost-monitor.js` | UserPromptSubmit | Reads the transcript, weights token usage by relative cost (once per model call), and warns once per tier when a session gets expensive. It advises clearing at the next natural break, never mid-task. |
| `hooks/lib/guard-run.sh` | (runner) | Starts the bun guards and blocks the call if bun or the guard cannot be found. |
| `agents/Breaker.md` | Subagent | Attacks a running app on preview, staging or localhost with seeded data: double submits, concurrent edits, skipped steps, bad input, other users' ids, light load. Reports each break with repro steps. Its limits (no production, no third-party hosts, no code changes) are instructions in the agent file, not a tool allowlist. |
| `agents/FirstTimeUser.md` | Subagent | A code-blind first-time customer. It has browser tools only (no files, no search, no shell), so it cannot know how the app works. Phone size first, then desktop. Reports every place a stranger would hesitate or leave. |

### Why the cost monitor matters

Context-fill monitors warn when the window is running out. That is not what costs money. One session of mine used 37% of a day's allowance across every project without ever coming close to filling a 1M window. The cost is size times turns: every turn re-reads the whole context, so 400k is cheap for five turns and ruinous for four hundred. This hook measures that, from the transcript, and depends on nothing the harness may or may not pass in.

## Install

Requirements: Claude Code on macOS or Linux (Windows is untested), `jq` (preinstalled on macOS; `apt install jq` or your distro's equivalent on Linux), [bun](https://bun.sh) for the `.ts` guards, and Node for the cost monitor. FirstTimeUser needs the Playwright MCP server registered under the name `playwright`, because its tool list is `mcp__playwright__*`.

The guards fail closed on purpose: without bun or jq, every Bash, Write and Edit call they match is blocked, with a message saying why, until you install them.

```bash
git clone https://github.com/jamiebuchanan/claude-code-guards.git
cd claude-code-guards
bash test/run.sh                      # every case should pass before you install

mkdir -p ~/.claude/hooks/lib ~/.claude/agents
cp hooks/*.sh hooks/*.ts hooks/*.js ~/.claude/hooks/
cp hooks/lib/guard-run.sh ~/.claude/hooks/lib/
cp agents/*.md ~/.claude/agents/
chmod +x ~/.claude/hooks/*.sh ~/.claude/hooks/*.ts ~/.claude/hooks/*.js ~/.claude/hooks/lib/guard-run.sh
```

The `cp` lines overwrite any hook or agent of the same name, so check `~/.claude/hooks` and `~/.claude/agents` first if you already have some. To add your own production targets for SqlSafetyGuard, start from the example config:

```bash
cp examples/sql-safety-config.example.json ~/.claude/hooks/sql-safety-config.json
```

Then merge the `env` and `hooks` blocks from [`examples/settings.json`](examples/settings.json) into `~/.claude/settings.json`. Merge rather than overwrite if you already have hooks. Run `/hooks` in Claude Code to check they loaded.

Take only the pieces you want: each hook stands alone, apart from the two bun guards, which need `guard-run.sh`.

## Configuration

| Setting | Used by | Meaning |
|---|---|---|
| `MAIL_SEND_GUARD_CLIS` | MailSendGuard | Space-separated names of your own mail helpers. `<name> send` is blocked for each one. Letters, digits, `_` and `-` only. |
| `DASHGUARD_OUTWARD_CLIS` | DashGuard | Space-separated names of your own CLIs that send text to other people. Their commands are checked for dashes as well as `git commit` and `gh pr/issue`. |
| `sql-safety-config.json` | SqlSafetyGuard | Lives next to the installed hook (`~/.claude/hooks/sql-safety-config.json`). Your own production hosts and database names, extra dangerous patterns and allowlisted commands, as regex strings. See [`examples/sql-safety-config.example.json`](examples/sql-safety-config.example.json). An invalid regex is skipped with a message; a file that is not valid JSON is ignored and the defaults apply. A copy in this repo's `hooks/` is git-ignored, so your targets stay local. |
| `TIERS` in `session-cost-monitor.js` | Cost monitor | The weighted-token thresholds for NOTICE, MEDIUM and HIGH. Tune them to your own usage. |

Set the two environment variables in the `env` block of `settings.json`, or export them in the shell you start Claude Code from.

## Limits

These guards match patterns in the command text. They stop accidents and an agent's honest mistakes, not a determined attacker: a command assembled at runtime (base64 piped to a shell, say) will not be seen. Use them alongside scoped credentials, not instead of them.

SqlSafetyGuard in particular:

- It reads SQL passed inline, in a heredoc or with `-f`/`-i`. SQL piped in (`echo ... | psql`) or redirected (`psql < file.sql`) is not read.
- `DROP VIEW`, `DROP INDEX`, `ALTER TABLE ... DROP COLUMN` and the like are not in the defaults; add them in the config if you need them. `mongosh` and `redis-cli` are recognised as executors but have no destructive patterns yet.
- Any `supabase.co`, `neon.tech`, `railway.app`, `planetscale` or RDS host counts as production, including your development projects there.
- A `WHERE` anywhere in a statement, even inside a subquery, counts as scoped.
- SQL run through an MCP tool (a database server's `execute_sql`, say) never passes through the Bash matcher.

The cost weights are relative, not prices, and the tiers are starting points.

## Tests

```bash
bash test/run.sh
```

The script feeds sample tool calls to every hook and checks the decision it returns: denials, allows, the ask prompt, exit codes, the warning path and the once-per-tier rule. It writes only to a temporary directory.

## Credits

Breaker and FirstTimeUser are my versions of two practices described in the AI LABS video [Vercel's CEO Just Unveiled The Greatest AI Coding Workflow Ever](https://www.youtube.com/watch?v=y2ifUC9_zuU): an agent that attacks the app on copied data, and a code-blind agent that uses it as a first-time customer would. The hook interface is Claude Code's; see the [hooks documentation](https://code.claude.com/docs/en/hooks).

## Licence

MIT. See [LICENSE](LICENSE).
