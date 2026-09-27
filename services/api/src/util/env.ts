/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Small, strict env parsing helpers shared by the Lambda entries and the local dev server. */

export type Env = Record<string, string | undefined>;

export function envStr(env: Env, name: string, fallback: string): string {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

export function envOpt(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

export function envNum(env: Env, name: string, fallback: number): number {
  const v = env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

export function envBool(env: Env, name: string, fallback = false): boolean {
  const v = env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export function envRequired(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}
