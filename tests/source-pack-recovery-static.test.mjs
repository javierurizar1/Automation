import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isValidSourcePackNumber,
  sourcePackFilename,
} from '../src/protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_PATTERNS = [
  /#upload-files/i,
  /setInputFiles\s*\(/,
  /project-sources-upload/i,
  /attachPackToChatComposer/i,
  /exposePackToProjectSources/i,
  /deliverExactSourcePack/i,
  /downloadExactPackFromDriveFolder/i,
  /page\.goto\([^)]*drive\.google\.com/i,
  /context\.newPage\(\)[\s\S]{0,200}drive\.google\.com/i,
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('source-pack recovery code does not reintroduce direct upload or Drive browser transport', () => {
  const files = ['src/controller.mjs', 'src/protocol.mjs'];
  for (const file of files) {
    const source = read(file);
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${file} must not contain ${pattern}`,
      );
    }
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'src/source-pack-delivery.mjs')), false);
});

test('generated continuation filenames never emit pack_000000 for buckets with startPack > 0', () => {
  for (const [bucket, shard] of Object.entries({
    0: 51, 1: 50, 2: 49, 3: 53, 4: 18, 5: 8,
  })) {
    assert.notEqual(sourcePackFilename(0, Number(bucket)), 'pack_000000.jsonl');
    assert.equal(isValidSourcePackNumber(Number(bucket), 0), false);
    assert.ok(shard > 0);
  }
});
