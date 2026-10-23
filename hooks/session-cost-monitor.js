#!/usr/bin/env node
// Session cost monitor - UserPromptSubmit hook.
//
// WHY THIS EXISTS, AND WHY A CONTEXT-FILL MONITOR DOES NOT COVER IT.
//
// A context monitor warns when the context window is running OUT. That is a different failure
// from the one that actually costs money. On 29 Jul 2026 a single session burned 37% of the day's
// usage across all projects, over hundreds of turns, while never coming close to filling a 1M
// window. Nothing warned, for two independent reasons:
//
//   1. The existing monitor was gated on `data.context_window.remaining_percentage`, which that
//      Claude Code build did not supply, so it read nothing and exited silently every single time.
//   2. Even working, it measures FILL. Fill was comfortable all day. The cost was SIZE x TURNS: a
//      400k context is cheap for five turns and ruinous for four hundred, because every turn
//      re-reads the whole thing.
//
// So this reads the transcript directly and depends on nothing the harness may or may not pass.
//
// WHAT IT CANNOT DO: issue /clear. A hook cannot drive the session. What it can do is put the
// number in front of both the user and the model at the moment a decision is possible, which is
// the start of a turn.
//
// THE ADVICE IS DELIBERATELY "AT THE NEXT BOUNDARY", NOT "NOW". Clearing mid-task costs a
// rediscovery cycle that can be worse than the context it saves. The right moment is when an
// expensive session and a finished task coincide.

const fs = require('fs');
const readline = require('readline');

// Weighted against relative token cost: output dominates, cache reads are cheap but relentless.
const W = { out: 5, cacheCreate: 1.25, input: 1, cacheRead: 0.1 };

// Rough starting points, not prices: tune them to your own usage. They are earlier thresholds
// scaled down by about 2.5, the overcount one real transcript showed before the per-message dedupe.
const TIERS = [
  { at: 7.5e6, level: 'HIGH',   verb: 'This session is now one of the most expensive of the day.' },
  { at: 4.5e6, level: 'MEDIUM', verb: 'This session has become expensive.' },
  { at: 2e6,   level: 'NOTICE', verb: 'This session is getting long.' },
];

const STATE_DIR = require('os').tmpdir();

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

let input = '';
const timeout = setTimeout(() => process.exit(0), 8000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  clearTimeout(timeout);
  try {
    const data = JSON.parse(input || '{}');
    const transcript = data.transcript_path;
    const session = String(data.session_id || '');
    if (!transcript || !fs.existsSync(transcript)) process.exit(0);
    if (/[/\\]|\.\./.test(session)) process.exit(0);

    // The transcript writes one line per content block (thinking, text, tool use), each
    // carrying the same message's usage. Keep one usage per message id so a call is counted once.
    const usageById = new Map();
    let anon = 0, lastCtx = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(transcript), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const u = j.message && j.message.usage;
      if (!u) continue;
      usageById.set(j.message.id || `anon-${anon++}`, u);
      // The most recent record describes what the NEXT turn will have to re-read.
      lastCtx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    }
    const turns = usageById.size;
    if (!turns) process.exit(0);
    let weighted = 0;
    for (const u of usageById.values()) {
      weighted += (u.output_tokens || 0) * W.out + (u.cache_creation_input_tokens || 0) * W.cacheCreate +
        (u.input_tokens || 0) * W.input + (u.cache_read_input_tokens || 0) * W.cacheRead;
    }

    const tier = TIERS.find((t) => weighted >= t.at);
    if (!tier) process.exit(0);

    // Warn once per tier per session. Escalation always speaks; a repeat of the same tier does not.
    const statePath = `${STATE_DIR}/claude-cost-${session}.json`;
    let seen = null;
    try { seen = JSON.parse(fs.readFileSync(statePath, 'utf8')).level; } catch {}
    const rank = (l) => ['NOTICE', 'MEDIUM', 'HIGH'].indexOf(l);
    if (seen && rank(tier.level) <= rank(seen)) process.exit(0);
    try { fs.writeFileSync(statePath, JSON.stringify({ level: tier.level, at: Date.now() })); } catch {}

    const msg =
      `CONTEXT COST ${tier.level}. ${tier.verb} ${turns} model calls, roughly ${fmt(Math.round(weighted))} weighted tokens so far. ` +
      `The context now stands at about ${fmt(lastCtx)} tokens, and EVERY further turn re-reads all of it, ` +
      `so the running cost per exchange is now roughly ${fmt(lastCtx)} regardless of how small the question is.\n` +
      `ACTION FOR CLAUDE: do not clear mid-task. At the NEXT natural boundary (a task finished, a commit made, ` +
      `a question answered), tell the user plainly that clearing now would cut the per-turn cost, and offer to write ` +
      `a handoff first so nothing is lost. If the next piece of work is unrelated to this one, say so and recommend it.\n` +
      `Also: prefer delegating large file reads and log scans to a subagent from here on, so their output does not ` +
      `join the context that every later turn pays for.`;

    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg },
      }),
    );
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
