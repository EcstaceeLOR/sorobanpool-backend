import { readFileSync, writeFileSync } from 'node:fs';
import { envSchema } from './env.js';
import { defaultCell, ENV_DOCS, renderConfigurationDoc } from './env-docs.js';

const file = new URL('../../docs/configuration.md', import.meta.url);
const schemaKeys = Object.keys(envSchema.shape).sort();

describe('docs/configuration.md', () => {
  it('is up to date (run `pnpm docs:config` after changing env.ts or env-docs.ts)', () => {
    const text = renderConfigurationDoc();
    if (process.env.UPDATE_CONFIG_DOCS) writeFileSync(file, text);
    expect(readFileSync(file, 'utf8')).toBe(text);
  });

  it('documents every schema variable and nothing else', () => {
    expect(Object.keys(ENV_DOCS).sort()).toEqual(schemaKeys);
    const doc = readFileSync(file, 'utf8');
    for (const key of schemaKeys) expect(doc).toContain(`| \`${key}\` |`);
  });

  it('flags secrets and secret references', () => {
    for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'OTP_HMAC_SECRET', 'DATABASE_URL', 'METRICS_TOKEN'] as const) {
      expect(ENV_DOCS[key].sensitivity).toBe('secret');
    }
    for (const key of schemaKeys.filter((k) => k.endsWith('_REF'))) {
      expect(ENV_DOCS[key as keyof typeof ENV_DOCS].sensitivity).toBe('ref');
    }
    expect(ENV_DOCS.ENCRYPTION_KEY_ID.sensitivity).toBe('ref');
  });

  it('bounds the polling, backoff and retention settings (#87, #90)', () => {
    expect(envSchema.shape.INDEXER_EVENT_PAGE_SIZE.safeParse('201').success).toBe(false);
    expect(envSchema.shape.INDEXER_EVENT_PAGE_SIZE.parse('50')).toBe(50);
    expect(envSchema.shape.INDEXER_RETRY_JITTER.safeParse('1.5').success).toBe(false);
    expect(envSchema.shape.INDEXER_RETRIES.parse('0')).toBe(0);
    expect(envSchema.shape.CHAIN_EVENT_RETENTION_DAYS.parse('90')).toBe(90);
  });

  it('derives defaults from the schema', () => {
    expect(defaultCell('PORT')).toBe('`3000`');
    expect(defaultCell('DATABASE_URL')).toBe('**required**');
    expect(defaultCell('METRICS_TOKEN')).toBe('optional');
    expect(defaultCell('SENTRY_DSN')).toBe('`""`');
    expect(defaultCell('MAINNET_ENABLED')).toBe('`false`');
  });
});
