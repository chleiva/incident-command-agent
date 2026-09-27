/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Transient-error classification and retry with exponential backoff + full jitter, shared by every AWS-backed store
 * (DynamoDB, S3 traces, Secrets Manager) and the run path. The AWS SDK already retries some throttling/5xx errors
 * itself; this layer adds the classes it does not (TransactionConflict, dropped connections after its own retries)
 * and gives the run one policy: transient → retry (5 attempts, cap 8 s); anything else → fail fast.
 */

export type ErrorClass = 'transient' | 'permanent';

/** Error names (AWS SDK v3 `name`/`code`, Node network codes) that are worth retrying. */
export const TRANSIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  // throttling
  'ThrottlingException',
  'Throttling',
  'ThrottledException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'SlowDown',
  'LimitExceededException',
  // server side
  'InternalServerError',
  'InternalServerErrorException',
  'InternalFailure',
  'InternalError',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TransactionInProgressException',
  // timeouts / network
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Cancellation reason codes of a TransactionCanceledException that a plain retry can fix. */
const TRANSIENT_CANCEL_CODES = new Set([
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
  'RequestLimitExceeded',
]);

interface ErrLike {
  name?: string;
  code?: string;
  message?: string;
  $retryable?: unknown;
  $metadata?: { httpStatusCode?: number };
  CancellationReasons?: ({ Code?: string } | undefined)[];
  cause?: unknown;
}

/**
 * Classify an error. Transient: throttling, 5xx/429, network errors and timeouts, and a transaction cancelled only
 * by TransactionConflict/throttling (NOT a ConditionalCheckFailed, which the caller handles). Everything else —
 * ValidationException, AccessDenied, ConditionalCheckFailed, programming errors — is permanent.
 */
export function classifyError(err: unknown, depth = 0): ErrorClass {
  if (!err || typeof err !== 'object') return 'permanent';
  const e = err as ErrLike;
  const name = e.name ?? '';
  if (name === 'TransactionCanceledException') {
    const codes = (e.CancellationReasons ?? []).map((r) => r?.Code ?? 'None').filter((c) => c !== 'None');
    return codes.length > 0 && codes.every((c) => TRANSIENT_CANCEL_CODES.has(c)) ? 'transient' : 'permanent';
  }
  if (name === 'ValidationException' || name === 'ConditionalCheckFailedException') return 'permanent';
  if (TRANSIENT_ERROR_NAMES.has(name) || (e.code && TRANSIENT_ERROR_NAMES.has(e.code))) return 'transient';
  if (e.$retryable) return 'transient';
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status >= 500 || status === 429)) return 'transient';
  if (/socket hang up|network error|fetch failed|timed? ?out/i.test(e.message ?? '')) return 'transient';
  if (e.cause && depth < 3) return classifyError(e.cause, depth + 1);
  return 'permanent';
}

export const isTransientError = (err: unknown): boolean => classifyError(err) === 'transient';

export interface RetryOptions {
  /** Total attempts (first try included). Default 5. */
  attempts?: number;
  /** First backoff ceiling (ms). Default 100. */
  baseMs?: number;
  /** Backoff cap (ms). Default 8 000. */
  capMs?: number;
  /** Which errors to retry (default: `isTransientError`). */
  retryOn?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
}

export const DEFAULT_RETRY_ATTEMPTS = 5;
export const DEFAULT_RETRY_CAP_MS = 8_000;

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Full-jitter exponential backoff for retry `attempt` (1-based): U(0, min(cap, base·2^(attempt−1))). */
export function backoffMs(
  attempt: number,
  opts: Pick<RetryOptions, 'baseMs' | 'capMs' | 'rng'> = {},
): number {
  const base = opts.baseMs ?? 100;
  const cap = opts.capMs ?? DEFAULT_RETRY_CAP_MS;
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round((opts.rng ?? Math.random)() * ceiling);
}

/** Run `fn`, retrying transient failures with backoff. The last error is rethrown unchanged. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_RETRY_ATTEMPTS);
  const retryOn = opts.retryOn ?? isTransientError;
  const sleep = opts.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !retryOn(err)) throw err;
      const delayMs = backoffMs(attempt, opts);
      opts.onRetry?.({ attempt, delayMs, err });
      await sleep(delayMs);
    }
  }
}
