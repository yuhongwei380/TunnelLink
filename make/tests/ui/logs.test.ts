import test from 'node:test';
import assert from 'node:assert/strict';
import { filterLogs, formatLogs, isErrorLog } from '../../../ui/src/logs.ts';

const event = (line: string, source = 'openvpn') => ({ ts: '2026-10-23T10:00:00Z', source, line });

test('diagnostics include OpenVPN authentication and tunnel failures', () => {
  for (const line of [
    'EVENT: AUTH_FAILED',
    'TUN_SETUP_FAILED',
    'TLS Error: negotiation failed',
    'FATAL: driver unavailable',
    'FAIL: transport',
  ]) {
    assert.equal(isErrorLog(event(line)), true, line);
  }
});

test('normal state transitions and unrelated words remain neutral', () => {
  for (const line of [
    'EVENT: CONNECTED',
    'Connection requested.',
    'Reconnecting after timeout',
    'errorcount=0',
    'failover enabled',
  ]) {
    assert.equal(isErrorLog(event(line)), false, line);
  }
});

test('native lastError entries stay visible even without English keywords', () => {
  assert.equal(isErrorLog(event('未找到适用的网络适配器', 'status')), true);
});

test('diagnostic search combines error filtering with case-insensitive field matching', () => {
  const connected = event('EVENT: CONNECTED');
  const failed = event('EVENT: AUTH_FAILED');
  const status = { ts: '', source: 'status', line: '未找到网络适配器' };
  const entries = [connected, failed, status];

  assert.deepEqual(filterLogs(entries, 'auth', 'errors'), [failed]);
  assert.deepEqual(filterLogs(entries, 'OPENVPN', 'all'), [connected, failed]);
  assert.deepEqual(filterLogs(entries, '2026-10-23', 'errors'), [failed]);
  assert.deepEqual(filterLogs(entries, '网络', 'errors'), [status]);
  assert.deepEqual(entries, [connected, failed, status]);
});

test('copying diagnostics includes all matching events and errors without a timestamp', () => {
  const entries = Array.from({ length: 12 }, (_, index) => event(`Failure ${index}`));
  entries.push({ ts: '', source: 'status', line: '连接失败' });
  const text = formatLogs(filterLogs(entries, '', 'errors'));

  assert.equal(text.split('\n').length, 13);
  assert.ok(text.startsWith('[2026-10-23T10:00:00Z] [openvpn] Failure 0\n'));
  assert.ok(text.endsWith('[status] 连接失败'));
  assert.equal(formatLogs([]), '');
});
