import { describe, expect, it } from 'vitest';
import { parseChangelog } from '../src/admin/changelog.ts';

// VERSION and CHANGELOG.md as built into the page (vite.config.ts).
const version = __APP_VERSION__;
const releases = parseChangelog(__CHANGELOG__);

describe('changelog (Beheer → Wijzigingen)', () => {
  it('has an entry for the current VERSION at the top: every release updates CHANGELOG.md', () => {
    expect(releases[0]?.version).toBe(version);
  });

  it('lists every release once, newest first, each with at least one bullet', () => {
    const key = (v: string) => v.split('.').map(Number);
    for (const [i, r] of releases.entries()) {
      expect(r.items.length, r.version).toBeGreaterThan(0);
      const next = releases[i + 1];
      if (next) {
        const [a, b] = [key(r.version), key(next.version)];
        expect(a[0]! * 1e6 + a[1]! * 1e3 + a[2]! > b[0]! * 1e6 + b[1]! * 1e3 + b[2]!, `${r.version} after ${next.version}`).toBe(true);
        expect(r.date >= next.date, r.version).toBe(true);
      }
    }
  });

  it('parses headings and bullets', () => {
    expect(parseChangelog('# Wijzigingen\n\ntekst\n\n## 1.2.3 — 2026-11-11\n\n- Eén\n- Twee\n\n## 1.2.2 — 2026-11-10\n\n- Drie\n')).toEqual([
      { version: '1.2.3', date: '2026-11-11', items: ['Eén', 'Twee'] },
      { version: '1.2.2', date: '2026-11-10', items: ['Drie'] },
    ]);
  });
});
