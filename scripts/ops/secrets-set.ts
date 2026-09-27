/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run secrets:set [-- --search]`: prompts (hidden input) for provider keys and writes them to the `ica/llm`
 * secret (and `ica/search` with --search). Existing values are kept when you press Enter. Keys are never written
 * to disk, printed or logged.
 */
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { awsRegion, fail, getStackOutputs, isMain, loadDotEnv, promptHidden, stackName } from './lib';

export function mergeSecret(
  current: Record<string, string>,
  answers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) if (!k.startsWith('_') && v) out[k] = v;
  for (const [k, v] of Object.entries(answers)) if (v) out[k] = v;
  return out;
}

async function update(client: SecretsManagerClient, secretId: string, names: string[]) {
  let current: Record<string, string> = {};
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    current = JSON.parse(res.SecretString ?? '{}') as Record<string, string>;
  } catch {
    current = {};
  }
  const answers: Record<string, string> = {};
  for (const name of names) {
    const has = current[name] ? ' (set; Enter keeps it)' : ' (Enter to skip)';
    answers[name] = await promptHidden(`${name}${has}: `);
  }
  const next = mergeSecret(current, answers);
  await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: JSON.stringify(next) }));
  const set = Object.keys(next);
  console.log(`✔ ${secretId}: ${set.length ? set.join(', ') : 'no keys'} set`);
}

async function main() {
  loadDotEnv();
  const region = awsRegion();
  const outputs = await getStackOutputs(stackName('Data'), { region }).catch(
    () => ({}) as Record<string, string>,
  );
  const client = new SecretsManagerClient({ region });
  await update(client, outputs.LlmSecretArn ?? 'ica/llm', ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  if (process.argv.includes('--search')) {
    await update(client, outputs.SearchSecretArn ?? 'ica/search', ['TAVILY_API_KEY', 'BRAVE_API_KEY']);
  }
  console.log('  Lambdas read secrets at cold start; new runs pick up the change within a few minutes.');
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
