/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * `npm run user:create -- you@example.com`: creates the single Cognito user in the deployed pool (resolved from
 * the Ica-Api stack outputs) and prints a temporary password. The user sets a new one at first sign-in.
 */
import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  awsRegion,
  fail,
  generateTempPassword,
  getStackOutputs,
  isEmail,
  loadDotEnv,
  requireOutput,
  stackName,
} from './lib';

async function main() {
  loadDotEnv();
  const email = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!email || !isEmail(email)) fail('usage: npm run user:create -- you@example.com');
  const region = awsRegion();
  const stack = stackName('Api');
  const outputs = await getStackOutputs(stack, { region });
  const userPoolId = requireOutput(outputs, 'UserPoolId', stack);
  const password = generateTempPassword();
  const client = new CognitoIdentityProviderClient({ region });
  try {
    await client.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        TemporaryPassword: password,
        MessageAction: 'SUPPRESS',
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) fail(`${email} already exists in ${userPoolId}`);
    throw err;
  }
  console.log(`✔ Created ${email} in ${userPoolId}`);
  console.log(`  Temporary password: ${password}`);
  console.log('  Sign in at the SiteUrl; you will be asked to set a new password (and can enrol TOTP MFA).');
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
