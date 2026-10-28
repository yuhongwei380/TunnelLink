import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, formatTime } from '../../../src/format.ts';

test('session metrics preserve byte unit boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1024 ** 2), '1.00 MB');
  assert.equal(formatBytes(1024 ** 3), '1.00 GB');
});

test('session duration carries minutes and hours without wrapping after a day', () => {
  assert.equal(formatTime(0), '00:00:00');
  assert.equal(formatTime(59), '00:00:59');
  assert.equal(formatTime(60), '00:01:00');
  assert.equal(formatTime(3661), '01:01:01');
  assert.equal(formatTime(90061), '25:01:01');
});
