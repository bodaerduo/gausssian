import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const previewSource = readFileSync(new URL('../app/ply-preview.tsx', import.meta.url), 'utf8');

test('PLY preview explicitly identifies extensionless API responses', () => {
  assert.match(previewSource, /format:\s*SceneFormat\.Ply/);
});
