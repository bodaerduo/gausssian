import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const previewSource = readFileSync(new URL('../app/ply-preview.tsx', import.meta.url), 'utf8');

test('PLY preview explicitly identifies extensionless API responses', () => {
  assert.match(previewSource, /format:\s*SceneFormat\.Ply/);
});

test('PLY preview applies the vertical-axis correction', () => {
  assert.match(previewSource, /rotation:\s*\[1, 0, 0, 0\]/);
});
