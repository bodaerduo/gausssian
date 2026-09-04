import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const editorSource = readFileSync(new URL('../app/editor/page.tsx', import.meta.url), 'utf8');

test('editor adds a PLY filename to extensionless download URLs', () => {
  assert.match(editorSource, /load\.replace\(\/\\\/download\(\?=\(\$\|\[\?#\]\)\)\//);
  assert.match(editorSource, /download\/\$\{encodeURIComponent\(jobId\)\}\.ply/);
});
