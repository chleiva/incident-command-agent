/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Shared helpers for the ops scripts. They talk to AWS only when a script is run by the user. */
import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Load `<repo>/.env` into process.env (never overrides variables that are already set). */
export function loadDotEnv(root = REPO_ROOT): void {
  const file = join(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function awsRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'eu-west-2';
}

export function stackName(kind: 'Data' | 'Api' | 'Web' | 'WebWaf'): string {
  return `${process.env.ICA_STACK_PREFIX || 'Ica'}-${kind}`;
}

type CfnLike = Pick<CloudFormationClient, 'send'>;

/** CloudFormation outputs of a deployed stack as a key → value map. */
export async function getStackOutputs(
  stack: string,
  opts: { region?: string; client?: CfnLike } = {},
): Promise<Record<string, string>> {
  const client = opts.client ?? new CloudFormationClient({ region: opts.region ?? awsRegion() });
  const res = await client.send(new DescribeStacksCommand({ StackName: stack }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(
    outputs.filter((o) => o.OutputKey && o.OutputValue).map((o) => [o.OutputKey!, o.OutputValue!]),
  );
}

export function requireOutput(outputs: Record<string, string>, key: string, stack: string): string {
  const v = outputs[key];
  if (!v) throw new Error(`stack ${stack} has no output ${key}: is it deployed (npm run deploy)?`);
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string) => EMAIL_RE.test(s);

/** Cognito hosted-UI prefixes: lowercase letters, digits and hyphens; no reserved words. */
export function checkDomainPrefix(prefix: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix)) {
    return 'COGNITO_DOMAIN_PREFIX must be 1–63 lowercase letters, digits or hyphens (not starting/ending with -)';
  }
  if (/(aws|amazon|cognito)/.test(prefix))
    return 'COGNITO_DOMAIN_PREFIX must not contain aws, amazon or cognito';
  return null;
}

/** A temporary password that satisfies the pool policy (≥14 chars, upper, lower, digit, symbol). */
export function generateTempPassword(length = 20): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!#%+-=?@^_'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < Math.max(length, 14)) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export interface LocalFile {
  key: string;
  path: string;
  md5: string;
  size: number;
}

/** Files under `dir` as S3 keys under `prefix` (posix separators), with MD5 for ETag comparison. */
export function listLocalFiles(dir: string, prefix: string): LocalFile[] {
  const out: LocalFile[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && !name.startsWith('.')) {
        const rel = relative(dir, p).split(sep).join('/');
        out.push({
          key: `${prefix}${rel}`,
          path: p,
          size: st.size,
          md5: createHash('md5').update(readFileSync(p)).digest('hex'),
        });
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** What to upload (new or changed by MD5/ETag) and, optionally, what to delete (remote only). */
export function planSync(
  local: Pick<LocalFile, 'key' | 'md5'>[],
  remote: { key: string; etag?: string }[],
): { upload: string[]; remove: string[]; unchanged: string[] } {
  const remoteByKey = new Map(remote.map((r) => [r.key, (r.etag ?? '').replaceAll('"', '')]));
  const localKeys = new Set(local.map((l) => l.key));
  const upload: string[] = [];
  const unchanged: string[] = [];
  for (const l of local) (remoteByKey.get(l.key) === l.md5 ? unchanged : upload).push(l.key);
  const remove = remote.map((r) => r.key).filter((k) => !localKeys.has(k));
  return { upload, remove, unchanged };
}

export function contentTypeFor(key: string): string {
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.jsonl')) return 'application/x-ndjson';
  if (key.endsWith('.txt') || key.endsWith('.md')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Prompt without echoing the answer (keys never reach the terminal scrollback, disk or logs). */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return Promise.reject(new Error('an interactive terminal is required'));
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let muted = false;
    rlAny._writeToOutput = (s: string) => {
      if (!muted) rlAny.output.write(s);
      else if (s.includes('\n') || s.includes('\r')) rlAny.output.write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
    muted = true;
  });
}

/** True when the module is the script being run (so tests can import it without side effects). */
export function isMain(importMetaUrl: string): boolean {
  return !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === importMetaUrl;
}

export function fail(message: string): never {
  console.error(`✖ ${message}`);
  process.exit(1);
}
