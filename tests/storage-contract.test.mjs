import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('standalone demo preserves its existing persistent browser-storage contract', () => {
  // The private Factory builder currently uses sessionStorage. Do not replace
  // this public demo with that output without a reviewed, non-destructive
  // migration: users may already have saved localStorage catering records.
  assert.match(html, /const STORAGE='feastlab-private-v1'/);
  assert.match(html, /localStorage\.getItem\(STORAGE\)/);
  assert.match(html, /localStorage\.setItem\(STORAGE,/);
  assert.doesNotMatch(html, /\bsessionStorage\b/);
  assert.doesNotMatch(html, /\blocalStorage\.(?:clear|removeItem)\s*\(/);
  assert.match(html, /window\.addEventListener\('storage'/);
});

test('standalone demo retains the private, network-isolated sample-data boundary', () => {
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.doesNotMatch(html, /<script[^>]+src\s*=/i);
});
