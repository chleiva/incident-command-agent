/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Audit logs, in mock mode: the menu shows Audit (not Evals), pick a run, expand an LLM call and read the exact
 * request as Raw JSON, expand a tool call and see its input and output. Evals stays reachable from ⌘K.
 */
import { expect, test } from '@playwright/test';

test('Audit: pick a run, expand an LLM call (Raw JSON) and a tool call (input/output)', async ({ page }) => {
  await page.goto('/training');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toHaveText(/Network\s*Agents\s*Audit\s*Training scenarios/);
  await expect(nav.getByRole('link', { name: 'Evals' })).toHaveCount(0);

  await nav.getByRole('link', { name: 'Audit' }).click();
  await expect(page).toHaveURL(/\/audit$/);
  await expect(page.getByTestId('audit-note')).toContainText('API keys are redacted');

  // Pick the recorded s01 agent run.
  const runRow = page
    .getByTestId('audit-runs')
    .locator('tr', { hasText: 'agent' })
    .filter({ hasText: 'Towbar' })
    .first();
  await runRow.getByRole('link').click();
  await expect(page).toHaveURL(/\/runs\/[^/]+\/audit$/);
  await expect(page.getByTestId('audit-run-header')).toContainText('Towbar');

  // LLM call → Raw JSON of the exact request.
  const llmRow = page.locator('[data-kind="llm"]').first();
  await llmRow.locator('[data-audit-toggle]').click();
  const context = llmRow.getByRole('region', { name: 'Context sent to the model' });
  await expect(context.getByText('System prompt', { exact: true })).toBeVisible();
  await context.getByRole('tab', { name: 'Raw JSON' }).click();
  const raw = context.getByTestId('raw-request').locator('[data-json-text]');
  await expect(raw).toBeVisible();
  await expect(raw).toContainText('"messages"');
  await expect(raw).toContainText('"system"');
  const output = llmRow.getByRole('region', { name: 'Model output' });
  await output.getByRole('tab', { name: 'Raw JSON' }).click();
  await expect(output.getByTestId('raw-response').locator('[data-json-text]')).toContainText('"stop_reason"');

  // Tool call → input and output.
  await page.getByLabel('Kind').selectOption('tool');
  const toolRow = page.locator('[data-kind="tool"]').first();
  await toolRow.locator('[data-audit-toggle]').click();
  await expect(toolRow.getByRole('heading', { name: 'Input' })).toBeVisible();
  await expect(toolRow.getByRole('heading', { name: 'Output' })).toBeVisible();
  await expect(toolRow.getByTestId('tool-input').locator('[data-json-text]')).toBeVisible();
  await expect(toolRow.getByTestId('tool-output').locator('[data-json-text]')).toBeVisible();

  // Deep link survives a reload.
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId('audit-table')).toBeVisible();

  // Evals remains reachable from the command palette.
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.type('Evaluation report');
  await expect(page.getByRole('option', { name: 'Evaluation report' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/evals$/);
});
