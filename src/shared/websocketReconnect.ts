export interface WebSocketReconnectPlanOptions {
  reconnectAttempts: number;
  connectedAt?: number;
  now?: number;
  baseReconnectDelay?: number;
  stableConnectionResetMs?: number;
}

export interface WebSocketReconnectPlan {
  attemptBase: number;
  nextAttempt: number;
  delayMs: number;
}

/**
 * Centralize reconnect backoff math so the runtime logic and regression tests
 * stay in sync.
 */
export function computeReconnectPlan(
  options: WebSocketReconnectPlanOptions
): WebSocketReconnectPlan {
  const {
    reconnectAttempts,
    connectedAt,
    now = Date.now(),
    baseReconnectDelay = 2000,
    stableConnectionResetMs = 5000,
  } = options;

  const wasStable =
    typeof connectedAt === 'number' && now - connectedAt >= stableConnectionResetMs;
  const attemptBase = wasStable ? 0 : reconnectAttempts;

  return {
    attemptBase,
    nextAttempt: attemptBase + 1,
    delayMs: baseReconnectDelay * Math.pow(1.5, attemptBase),
  };
}

export function getReconnectAttemptState(
  reconnectAttempts: number,
  connectedAt?: number,
  now?: number,
  stableConnectionResetMs?: number
): Pick<WebSocketReconnectPlan, 'attemptBase' | 'nextAttempt'> {
  const { attemptBase, nextAttempt } = computeReconnectPlan({
    reconnectAttempts,
    connectedAt,
    now,
    stableConnectionResetMs,
  });
  return { attemptBase, nextAttempt };
}
