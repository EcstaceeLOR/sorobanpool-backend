import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('..', import.meta.url));
const catalogue = readFileSync(new URL('../../docs/errors.md', import.meta.url), 'utf8');

/** Error codes the API can return: `{ error: 'CODE' }` bodies and the typed errors the exception filter maps. */
const PATTERNS = [
  /error: '([A-Z][A-Z0-9_]+)'/g,
  /new (?:AuthError|AnchorError|SponsorshipError|TxRejected|WalletKeyError)\('([A-Z][A-Z0-9_]+)'/g,
];

function thrownCodes(): Set<string> {
  const codes = new Set<string>();
  const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.split(/[\\/]/).includes('generated'));
  for (const f of files) {
    const text = readFileSync(join(srcDir, f), 'utf8');
    for (const re of PATTERNS) for (const m of text.matchAll(re)) codes.add(m[1]!);
  }
  return codes;
}

describe('docs/errors.md', () => {
  it('documents every error code the code throws', () => {
    const codes = thrownCodes();
    // Guards the scan itself: a broken pattern must not pass by finding nothing.
    expect(codes.size).toBeGreaterThan(40);
    const missing = [...codes].filter((c) => !catalogue.includes(`\`${c}\``)).sort();
    expect(missing, 'add these codes to docs/errors.md').toEqual([]);
  });

  it('references the contract error list instead of copying it', () => {
    expect(catalogue).toContain('src/chain/artifacts/errors.json');
    expect(catalogue).not.toMatch(/\| `?NotAdmin`? \|/);
  });
});
