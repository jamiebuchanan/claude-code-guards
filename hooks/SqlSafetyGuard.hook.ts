#!/usr/bin/env bun
/**
 * SqlSafetyGuard.hook.ts: PreToolUse hook on Bash.
 *
 * Catches destructive SQL operations against production database indicators
 * BEFORE the command runs. Hard-blocks when a dangerous SQL pattern is paired
 * with a production target marker. Soft-warns (additionalContext) when a
 * dangerous pattern appears with no clear production marker.
 *
 * Written after a setup script containing `DISABLE TRIGGER ALL` and
 * `DELETE FROM` was nearly run against a production database. A
 * conversational safety rule in CLAUDE.md covers behaviour; this hook covers
 * the execution gate.
 *
 * INPUT (stdin JSON):
 *   {
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "sqlcmd ..." },
 *     ...
 *   }
 *
 * OUTPUT:
 *   exit 0 (silent)                   safe, allow
 *   exit 0 + JSON additionalContext   warn but allow (inside hookSpecificOutput)
 *   exit 2 + stderr                   hard block
 *
 * CONFIG:
 *   Optional sql-safety-config.json next to this file, with extra production
 *   indicators (regex strings), extra dangerous patterns and allowlisted
 *   commands. Defaults cover common managed-database hosts and naming
 *   conventions; add your own production hosts and database names there.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';

interface ToolCallInput {
  tool_name?: string;
  tool_input?: { command?: string };
}

interface SafetyConfig {
  extra_production_indicators?: string[];   // regex strings (case-insensitive)
  extra_dangerous_patterns?: { name: string; regex: string }[];
  allowlist_commands?: string[];            // regex strings, matched against the command verbatim to skip
}

// Heuristic: command starts with one of these binaries (after optional `env`, `time`, etc.).
const SQL_EXECUTORS = [
  /\bsqlcmd\b/,
  /\bpsql\b/,
  /\bmysql\b/,
  /\bmariadb\b/,
  /\bmongosh\b/,
  /\bmongo\b/,
  /\bredis-cli\b/,
  /\bbq\s+query\b/,
  /\bsqlite3\b/,
];

// Default production indicators. Extend via sql-safety-config.json.
const DEFAULT_PRODUCTION_INDICATORS: RegExp[] = [
  /_Production\b/,                                        // database suffix convention
  /\bprod(?:uction)?_db\b/i,
  /(?:--db|-d)\s+\S*[Pp]roduction/,                       // -d X_Production
  /\.railway\.app\b/,
  /\.supabase\.co\b/,
  /\.planetscale\.\w+/,
  /\.neon\.tech\b/,
  /\.rds\.amazonaws\.com\b/,
  /\.cloud\.databricks\.com\b/,
  /\.cosmos\.azure\.com\b/,
  /production\.\S+\.fly\.dev\b/,
];

const DEFAULT_DANGEROUS_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'DISABLE TRIGGER ALL', re: /\bDISABLE\s+TRIGGER\s+ALL\b/i },
  { name: 'DROP DATABASE',       re: /\bDROP\s+DATABASE\b/i },
  { name: 'DROP SCHEMA',         re: /\bDROP\s+SCHEMA\b(?!\s+IF\s+EXISTS\s+\w+_test)/i },
  { name: 'DROP TABLE',          re: /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+#)/i },     // allow temp tables (#)
  { name: 'TRUNCATE',            re: /\bTRUNCATE\b/i },
  { name: 'DROP TRIGGER (mass)', re: /\bDROP\s+TRIGGER\s+(?:ALL|\*)\b/i },
  { name: 'SET IDENTITY_INSERT ... ON without scoping', re: /\bSET\s+IDENTITY_INSERT\s+\w+\.\w+\s+ON\b/i },
];

const SKIP_IF_CONTAINS = [
  /--dry-run\b/,
  /--explain-only\b/,
  /--print-only\b/,
  /\bWHATIF\b/i,
];

function readStdinSync(): string {
  try {
    return readFileSync('/dev/stdin', 'utf8');
  } catch {
    return '';
  }
}

function loadConfig(): SafetyConfig {
  const cfgPath = resolve(import.meta.dir, 'sql-safety-config.json');
  if (!existsSync(cfgPath)) return {};
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function isSqlExecutor(command: string): boolean {
  return SQL_EXECUTORS.some(re => re.test(command));
}

function safeReadFile(path: string, maxBytes = 200_000): string {
  try {
    if (!existsSync(path)) return '';
    const stat = statSync(path);
    if (stat.size > maxBytes) {
      // For huge SQL files, keep the first chunk only: dangerous patterns
      // typically appear near the top (setup/teardown sections).
      const fd = readFileSync(path, { encoding: 'utf8', flag: 'r' });
      return fd.slice(0, maxBytes);
    }
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function extractInlineSql(command: string): string {
  const matches: string[] = [];
  // -Q "..." / -c "..." / -e "..." / --query "..." / --command "..."
  for (const re of [
    /(?:-Q|--query)\s+(["'])([\s\S]*?)\1/g,
    /(?:-c|--command)\s+(["'])([\s\S]*?)\1/g,
    /(?:-e|--execute)\s+(["'])([\s\S]*?)\1/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(command)) !== null) matches.push(m[2]);
  }
  // Heredoc: `sqlcmd ... <<EOF ... EOF`
  const heredoc = command.match(/<<[-]?\s*['"]?(\w+)['"]?\n([\s\S]*?)\n\1/);
  if (heredoc) matches.push(heredoc[2]);
  return matches.join('\n');
}

function extractFileSql(command: string, cwd: string): string {
  // -i <path> / -f <path> / --input-file <path>
  const fileMatch = command.match(/(?:-i|-f|--input-file)\s+(\S+)/);
  if (!fileMatch) return '';
  let path = fileMatch[1].replace(/^["']|["']$/g, '');
  // Resolve relative paths against cwd
  if (!path.startsWith('/')) path = resolve(cwd, path);
  return safeReadFile(path);
}

// UPDATE and DELETE are only dangerous without a WHERE, so they are judged one
// statement at a time (split on `;` and on T-SQL `GO` lines). A WHERE that only
// appears inside a subquery still counts as scoped: this is a heuristic.
function unscopedWrites(sql: string): string[] {
  const hits = new Set<string>();
  for (const stmt of sql.split(/;|^\s*GO\s*$/im)) {
    if (/\bWHERE\b/i.test(stmt)) continue;
    if (/\bDELETE\s+FROM\s+[\w."\[\]]+/i.test(stmt)) hits.add('DELETE without WHERE');
    if (/\bUPDATE\s+[\w."\[\]]+\s+SET\b/i.test(stmt)) hits.add('UPDATE without WHERE');
  }
  return [...hits];
}

function findDangerous(sql: string, extra: { name: string; re: RegExp }[]): string[] {
  const all = [...DEFAULT_DANGEROUS_PATTERNS, ...extra];
  const hits: string[] = [];
  for (const p of all) {
    if (p.re.test(sql)) hits.push(p.name);
  }
  return [...hits, ...unscopedWrites(sql)];
}

// A bad regex in the config must not crash the guard (a crash exits 1, which
// Claude Code treats as non-blocking, so the whole guard would fail open).
function compileAll(sources: string[], flags: string, field: string): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try {
      out.push(new RegExp(s, flags));
    } catch {
      console.error(`SqlSafetyGuard: skipping invalid regex in ${field}: ${s}`);
    }
  }
  return out;
}

function matchesProduction(command: string, sql: string, extra: RegExp[]): { match: boolean; indicator?: string } {
  const all = [...DEFAULT_PRODUCTION_INDICATORS, ...extra];
  const combined = command + '\n' + sql;
  for (const re of all) {
    const m = combined.match(re);
    if (m) return { match: true, indicator: m[0] };
  }
  return { match: false };
}

function isAllowlisted(command: string, extra: RegExp[]): boolean {
  return extra.some(re => re.test(command)) || SKIP_IF_CONTAINS.some(re => re.test(command));
}

function main() {
  const raw = readStdinSync().trim();
  if (!raw) process.exit(0);

  let payload: ToolCallInput;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  if (payload.tool_name !== 'Bash') process.exit(0);

  const command = payload.tool_input?.command?.trim() ?? '';
  if (!command) process.exit(0);
  if (!isSqlExecutor(command)) process.exit(0);

  const config = loadConfig();
  const extraProd = compileAll(config.extra_production_indicators ?? [], 'i', 'extra_production_indicators');
  const extraDanger = (config.extra_dangerous_patterns ?? []).flatMap(p =>
    compileAll([p.regex], 'i', 'extra_dangerous_patterns').map(re => ({ name: p.name, re })),
  );
  const extraAllow = compileAll(config.allowlist_commands ?? [], '', 'allowlist_commands');

  if (isAllowlisted(command, extraAllow)) process.exit(0);

  // Gather all SQL in scope: inline + file-referenced.
  const inline = extractInlineSql(command);
  const fileSql = extractFileSql(command, process.cwd());
  const allSql = `${inline}\n${fileSql}`.trim();

  // No SQL extracted (might be psql -l, redis-cli ping, etc.): pass through.
  if (!allSql) process.exit(0);

  const dangerous = findDangerous(allSql, extraDanger);
  if (dangerous.length === 0) process.exit(0);

  const prod = matchesProduction(command, allSql, extraProd);

  if (prod.match) {
    // HARD BLOCK
    console.error(`✗ SqlSafetyGuard: blocked destructive SQL against production target.`);
    console.error(``);
    console.error(`  Production indicator: ${prod.indicator}`);
    console.error(`  Dangerous patterns:   ${dangerous.join(', ')}`);
    console.error(``);
    console.error(`  To proceed:`);
    console.error(`    1. Dry-run the script (--dry-run / --print-only / WHATIF) first.`);
    console.error(`    2. Print the affected row counts BEFORE the destructive call.`);
    console.error(`    3. If still needed, scope explicitly with WHERE clauses and re-run.`);
    console.error(`    4. For a trusted command that must run as is, add it to allowlist_commands`);
    console.error(`       in sql-safety-config.json.`);
    process.exit(2);
  }

  // Soft warn: dangerous pattern present, but no obvious production marker.
  // Inject reasoning context so Claude considers it before proceeding.
  const warning = `SqlSafetyGuard notice: detected destructive SQL pattern(s) [${dangerous.join(', ')}] in this command. No explicit production indicator matched, but verify the target database and that you have a backup/dry-run before letting this run.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }));
  process.exit(0);
}

main();
