import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReconnectPlan } from '../shared/websocketReconnect';

test('computeReconnectPlan increments attempts for unstable connections', () => {
  const plan = computeReconnectPlan({
    reconnectAttempts: 0,
    connectedAt: Date.now() - 1000,
    now: Date.now(),
    baseReconnectDelay: 2000,
    stableConnectionResetMs: 5000,
  });

  assert.deepEqual(plan, {
    attemptBase: 0,
    nextAttempt: 1,
    delayMs: 2000,
  });
});

test('computeReconnectPlan resets attempts after a stable connection', () => {
  const now = Date.now();
  const plan = computeReconnectPlan({
    reconnectAttempts: 7,
    connectedAt: now - 6000,
    now,
    baseReconnectDelay: 2000,
    stableConnectionResetMs: 5000,
  });

  assert.deepEqual(plan, {
    attemptBase: 0,
    nextAttempt: 1,
    delayMs: 2000,
  });
});

test('computeReconnectPlan preserves backoff for repeated unstable reconnects', () => {
  const now = Date.now();
  const plan = computeReconnectPlan({
    reconnectAttempts: 3,
    connectedAt: now - 500,
    now,
    baseReconnectDelay: 2000,
    stableConnectionResetMs: 5000,
  });

  assert.deepEqual(plan, {
    attemptBase: 3,
    nextAttempt: 4,
    delayMs: 6750,
  });
});
