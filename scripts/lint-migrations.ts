// Fails CI on migration statements that are dangerous on a populated database (#151), unless annotated.
//
// Usage: node scripts/lint-migrations.ts [migrations-dir]   (Node 24 runs this file directly; no build step)
//
// Annotation, on the flagged line or the line directly above it, with a reason:
//   -- migration-lint: allow <rule> <why this is safe here>
// Migrations listed in scripts/migration-lint-baseline.json predate the linter and are not scanned.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Finding = { migration: string; line: number; rule: string; message: string };

type Rule = { id: string; message: string; match: (line: string, sql: string) => boolean };

const tablesCreatedIn = (sql: string) => new Set([...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((m) => m[1]!.toLowerCase()));

export const RULES: Rule[] = [
  {
    id: 'drop-column',
    message: 'drops a column; ship code that stops reading it first, then drop it in a later release',
    match: (l) => /\bDROP\s+COLUMN\b/i.test(l),
  },
  {
    id: 'drop-table',
    message: 'drops a table and its data',
    match: (l) => /\bDROP\s+TABLE\b/i.test(l),
  },
  {
    id: 'not-null-without-default',
    message: 'adds a NOT NULL column without a DEFAULT, which fails on a populated table',
    match: (l) => /\bADD\s+COLUMN\b/i.test(l) && /\bNOT\s+NULL\b/i.test(l) && !/\bDEFAULT\b/i.test(l),
  },
  {
    id: 'non-concurrent-index',
    message: 'creates an index on an existing table without CONCURRENTLY, locking writes while it builds',
    match: (l, sql) => {
      const m = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)[^;]*?\bON\s+"?(\w+)"?/i.exec(l);
      return !!m && !tablesCreatedIn(sql).has(m[1]!.toLowerCase());
    },
  },
  {
    id: 'alter-column-type',
    message: 'changes a column type, which can rewrite the whole table',
    match: (l) => /\bALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(l),
  },
];

const ANNOTATION = /--\s*migration-lint:\s*allow\s+([\w-]+)\s+\S/i;

/** Lints one migration's SQL. Comment-only lines are ignored; an annotation exempts its own line and the next one. */
export function lintSql(migration: string, sql: string): Finding[] {
  const lines = sql.split(/\r?\n/);
  const findings: Finding[] = [];
  lines.forEach((raw, i) => {
    const code = raw.replace(/--.*$/, '');
    if (!code.trim()) return;
    for (const rule of RULES) {
      if (!rule.match(code, sql)) continue;
      const allowed = [raw, lines[i - 1] ?? ''].some((l) => ANNOTATION.exec(l)?.[1]?.toLowerCase() === rule.id);
      if (!allowed) findings.push({ migration, line: i + 1, rule: rule.id, message: rule.message });
    }
  });
  return findings;
}

/** Lints every migration directory under `dir` that is not in `baseline`. */
export function lintMigrations(dir: string, baseline: readonly string[]): Finding[] {
  const skip = new Set(baseline);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !skip.has(d.name))
    .map((d) => d.name)
    .sort()
    .flatMap((name) => {
      const file = join(dir, name, 'migration.sql');
      return existsSync(file) ? lintSql(name, readFileSync(file, 'utf8')) : [];
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? 'prisma/migrations';
  const baseline = JSON.parse(readFileSync(new URL('./migration-lint-baseline.json', import.meta.url), 'utf8')) as string[];
  const findings = lintMigrations(dir, baseline);
  for (const f of findings) console.error(`${f.migration}/migration.sql:${f.line}  [${f.rule}] ${f.message}`);
  if (findings.length) {
    console.error(`\n${findings.length} dangerous statement(s). If one is safe here, annotate it:\n  -- migration-lint: allow <rule> <reason>`);
    process.exit(1);
  }
  console.log('migration lint: ok');
}
