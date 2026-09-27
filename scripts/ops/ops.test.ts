/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import scenario from '@ica/schema/fixtures/scenario.minimal.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { awsWebConfig, localWebConfig, writeWebConfig } from '../dev/write-web-config';
import { preflight } from './deploy';
import { checkDomainPrefix, generateTempPassword, getStackOutputs, listLocalFiles, planSync } from './lib';
import { loadPrivateScenarios } from './scenarios-push';
import { mergeSecret } from './secrets-set';

describe('ops helpers', () => {
  it('generates temporary passwords that satisfy the pool policy', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword();
      expect(p.length).toBeGreaterThanOrEqual(14);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('validates Cognito domain prefixes', () => {
    expect(checkDomainPrefix('ica-demo-42')).toBeNull();
    expect(checkDomainPrefix('Ica')).toMatch(/lowercase/);
    expect(checkDomainPrefix('my-cognito-app')).toMatch(/must not contain/);
  });

  it('plans an S3 sync by MD5/ETag', () => {
    const plan = planSync(
      [
        { key: 'index/a.json', md5: 'aaa' },
        { key: 'index/b.json', md5: 'bbb' },
      ],
      [
        { key: 'index/a.json', etag: '"aaa"' },
        { key: 'index/b.json', etag: '"old"' },
        { key: 'index/stale.json', etag: '"x"' },
      ],
    );
    expect(plan).toEqual({
      upload: ['index/b.json'],
      unchanged: ['index/a.json'],
      remove: ['index/stale.json'],
    });
  });

  it('lists local files as posix keys with MD5', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ica-kb-'));
    writeFileSync(join(dir, 'chunks.jsonl'), 'hello');
    const files = listLocalFiles(dir, 'index/');
    expect(files.map((f) => [f.key, f.md5])).toEqual([
      ['index/chunks.jsonl', '5d41402abc4b2a76b9719d911017c592'],
    ]);
  });

  it('reads stack outputs', async () => {
    const client = {
      send: async (c: DescribeStacksCommand) => {
        expect(c.input.StackName).toBe('Ica-Api');
        return { Stacks: [{ Outputs: [{ OutputKey: 'UserPoolId', OutputValue: 'eu-west-2_x' }] }] };
      },
    } as never;
    expect(await getStackOutputs('Ica-Api', { client })).toEqual({ UserPoolId: 'eu-west-2_x' });
  });

  it('merges secrets without placeholders and keeps existing keys on empty answers', () => {
    expect(
      mergeSecret(
        { ANTHROPIC_API_KEY: 'old', OPENAI_API_KEY: '', _placeholder: 'zzz' },
        { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: 'new' },
      ),
    ).toEqual({ ANTHROPIC_API_KEY: 'old', OPENAI_API_KEY: 'new' });
  });

  it('refuses to deploy with placeholder or missing settings', () => {
    expect(preflight({})).toHaveLength(2);
    expect(
      preflight({ ALERT_EMAIL: 'alerts@example.com', COGNITO_DOMAIN_PREFIX: 'ica-change-me' }),
    ).toHaveLength(2);
    expect(
      preflight({ ALERT_EMAIL: 'me@mydomain.dev', COGNITO_DOMAIN_PREFIX: 'ica-demo-7', AUTH_MODE: 'none' }),
    ).toEqual(['AUTH_MODE=none is local-only; remove it from .env before deploying']);
    expect(preflight({ ALERT_EMAIL: 'me@mydomain.dev', COGNITO_DOMAIN_PREFIX: 'ica-demo-7' })).toEqual([]);
  });

  it('validates private scenarios and forces visibility private', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ica-scn-'));
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ ...scenario, id: 'priv-good' }));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...scenario, id: 'Bad Id' }));
    writeFileSync(join(dir, 'broken.json'), '{');
    const { ok, errors } = loadPrivateScenarios(dir);
    expect(ok.map((s) => [s.id, s.visibility])).toEqual([['priv-good', 'private']]);
    expect(errors.map((e) => e.file)).toEqual(['bad.json', 'broken.json']);
  });
});

describe('web runtime config', () => {
  it('writes a valid local config', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ica-web-')), 'public/config.json');
    writeWebConfig(localWebConfig(), path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      apiUrl: 'http://localhost:8787',
      wsUrl: 'ws://localhost:8787/ws',
      auth: { mode: 'none' },
    });
  });

  it('builds the AWS config from stack outputs', () => {
    const cfg = awsWebConfig(
      {
        HttpApiUrl: 'https://abc.execute-api.eu-west-2.amazonaws.com',
        WsApiUrl: 'wss://def.execute-api.eu-west-2.amazonaws.com/prod',
        Region: 'eu-west-2',
        UserPoolId: 'eu-west-2_abc',
        UserPoolClientId: 'client',
        CognitoDomain: 'ica-demo.auth.eu-west-2.amazoncognito.com',
      },
      'Ica-Api',
    );
    expect(cfg.auth).toMatchObject({ mode: 'cognito', redirectUri: 'http://localhost:5173/' });
    expect(() => awsWebConfig({}, 'Ica-Api')).toThrow(/HttpApiUrl/);
  });
});
