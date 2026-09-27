/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Provider errors and the retry policy (exponential backoff with jitter on 429, 5xx and network errors). */
import type { WallClock } from '@ica/schema';

/** An HTTP error from a provider. `body` is a short, redacted excerpt. */
export class LlmHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`${provider} HTTP ${status}: ${redact(body).slice(0, 300)}`);
    this.name = 'LlmHttpError';
  }
}

/** A network-level failure (DNS, reset, timeout). */
export class LlmNetworkError extends Error {
  constructor(
    readonly provider: string,
    cause: unknown,
  ) {
    super(`${provider} network error: ${redact(String((cause as Error)?.message ?? cause))}`);
    this.name = 'LlmNetworkError';
  }
}

/** Raised by the replay provider when no recorded response matches. Never retried. */
export class ReplayMissError extends Error {
  constructor(key: string) {
    super(`replay: no recorded response for ${key}`);
    this.name = 'ReplayMissError';
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof LlmNetworkError) return true;
  if (err instanceof LlmHttpError) return err.status === 429 || err.status >= 500;
  return false;
}

export function is5xx(err: unknown): boolean {
  return err instanceof LlmHttpError && err.status >= 500;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-(proj-)?[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /(x-api-key|authorization)["':\s]+[^\s"',}]+/gi,
];

/** Remove anything that looks like an API key. Used on error messages and traces. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  clock: WallClock;
  rng?: () => number;
  /** Called once per failed attempt (for 5xx accounting). */
  onError?: (err: unknown, attempt: number) => void;
  /** Stop retrying early (e.g. the router switched to the fallback). */
  shouldStop?: (err: unknown) => boolean;
  signal?: AbortSignal;
}

/** Up to `attempts` (default 4) tries; backoff = min(maxMs, base × 2^n) × (0.5 + jitter/2). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8_000;
  const rng = opts.rng ?? Math.random;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      opts.onError?.(err, i + 1);
      if (!isRetryable(err) || i === attempts - 1 || opts.shouldStop?.(err) || opts.signal?.aborted)
        throw err;
      const retryAfter = err instanceof LlmHttpError ? err.retryAfterMs : undefined;
      const delay = retryAfter ?? Math.min(max, base * 2 ** i) * (0.5 + rng() / 2);
      await opts.clock.sleep(delay);
    }
  }
  throw lastErr;
}

export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  return Number.isFinite(s) ? Math.min(30_000, s * 1000) : undefined;
}
