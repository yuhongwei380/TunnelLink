import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthenticationError, localizeConnectionError } from '../../../ui/src/errors.ts';
import { MESSAGES } from '../../../ui/src/messages.ts';

test('authentication failures use the active locale copy', () => {
  const error = 'Authentication failed. Check your username and password.';

  assert.equal(isAuthenticationError(error), true);
  assert.equal(
    localizeConnectionError(error, MESSAGES.zh.authenticationFailed),
    MESSAGES.zh.authenticationFailed,
  );
  assert.equal(
    localizeConnectionError(error, MESSAGES.en.authenticationFailed),
    MESSAGES.en.authenticationFailed,
  );
});

test('unrelated connection errors remain unchanged', () => {
  const error = 'Connection timed out. Check the connection logs.';

  assert.equal(isAuthenticationError(error), false);
  assert.equal(localizeConnectionError(error, MESSAGES.zh.authenticationFailed), error);
});
