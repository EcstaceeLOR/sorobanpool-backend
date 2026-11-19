import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintMigrations, lintSql } from './lint-migrations.js';

const rules = (sql: string) => lintSql('fixture', sql).map((f) => f.rule);

describe('migration linter (#151)', () => {
  it('flags each dangerous pattern', () => {
    expect(rules('ALTER TABLE "User" DROP COLUMN "legacy";')).toEqual(['drop-column']);
    expect(rules('DROP TABLE "Old";')).toEqual(['drop-table']);
    expect(rules('ALTER TABLE "Pool" ADD COLUMN "fee" INTEGER NOT NULL;')).toEqual(['not-null-without-default']);
    expect(rules('CREATE INDEX "Pool_state_idx" ON "Pool"("state");')).toEqual(['non-concurrent-index']);
    expect(rules('ALTER TABLE "Pool" ALTER COLUMN "fee" SET DATA TYPE BIGINT;')).toEqual(['alter-column-type']);
  });

  it('allows the safe forms', () => {
    expect(rules('ALTER TABLE "Pool" ADD COLUMN "fee" INTEGER NOT NULL DEFAULT 0;')).toEqual([]);
    expect(rules('CREATE INDEX CONCURRENTLY "Pool_state_idx" ON "Pool"("state");')).toEqual([]);
    // An index on a table created in the same migration has nothing to lock.
    expect(rules('CREATE TABLE "Thing" ("id" TEXT NOT NULL);\nCREATE INDEX "Thing_id_idx" ON "Thing"("id");')).toEqual([]);
    expect(rules('-- DROP COLUMN in a comment is not a statement')).toEqual([]);
  });

  it('honours an annotation with a reason on the line or the line above', () => {
    expect(rules('-- migration-lint: allow drop-column unused since v1.4\nALTER TABLE "User" DROP COLUMN "legacy";')).toEqual([]);
    expect(rules('ALTER TABLE "User" DROP COLUMN "legacy"; -- migration-lint: allow drop-column unused since v1.4')).toEqual([]);
    // Wrong rule id, or no reason, does not exempt it.
    expect(rules('-- migration-lint: allow drop-table oops\nALTER TABLE "User" DROP COLUMN "legacy";')).toEqual(['drop-column']);
    expect(rules('-- migration-lint: allow drop-column\nALTER TABLE "User" DROP COLUMN "legacy";')).toEqual(['drop-column']);
  });

  it('fails on a dangerous fixture migration and skips baselined ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-lint-'));
    try {
      for (const name of ['0001_old', '0002_new']) mkdirSync(join(dir, name));
      writeFileSync(join(dir, '0001_old', 'migration.sql'), 'ALTER TABLE "A" DROP COLUMN "b";\n');
      writeFileSync(join(dir, '0002_new', 'migration.sql'), 'SELECT 1;\nALTER TABLE "A" ADD COLUMN "c" TEXT NOT NULL;\n');
      const findings = lintMigrations(dir, ['0001_old']);
      expect(findings).toEqual([expect.objectContaining({ migration: '0002_new', line: 2, rule: 'not-null-without-default' })]);
      expect(lintMigrations(dir, []).map((f) => f.migration)).toEqual(['0001_old', '0002_new']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes on the committed migrations with the baseline', () => {
    const baseline = JSON.parse(readFileSync(new URL('./migration-lint-baseline.json', import.meta.url), 'utf8')) as string[];
    expect(lintMigrations(fileURLToPath(new URL('../prisma/migrations', import.meta.url)), baseline)).toEqual([]);
  });
});
