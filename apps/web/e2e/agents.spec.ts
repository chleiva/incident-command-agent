/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Task 08 — the Agents view, in mock mode: open a run, go to Agents, see a waiting row and then its decision row,
 * expand a row, follow a delegation link, check the scrubber moved, then Back to live. Plus the About dialog.
 */
import { expect, test } from '@playwright/test';

test('Agents view: waiting → decision, expand, delegation link, time sync, back to live', async ({
  page,
}) => {
  await page.goto('/training?timescale=4');
  // No run open yet: the Agents nav item is disabled.
  await expect(page.locator('[data-nav-agents-disabled]')).toHaveAttribute('aria-disabled', 'true');

  await page.getByLabel('Speed').selectOption('30');
  await page.getByRole('button', { name: 'Start Towbar shear and nose-gear contact on pushback' }).click();
  await expect(page).toHaveURL(/\/runs\/run-mock-[^/]+$/);
  const runUrl = page.url();

  // Wait for the first proposal, then open the Agents view from the Agent activity panel's expand action.
  await expect(page.locator('[data-approval="ap-msg-1"]')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-zone-expand="agents"]').click();
  await expect(page).toHaveURL(/\/runs\/run-mock-[^/]+\/agents$/);
  await expect(page.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');

  // A live waiting row in the Passengers column.
  const passengers = page.locator('[data-column="passenger"]');
  await expect(passengers.locator('h2')).toHaveText('Passengers (PX)');
  const waiting = passengers.locator('[data-kind="waiting"][data-pending="true"]');
  await expect(waiting).toContainText('Waiting for a decision: send a passenger message');

  // Decide on the dashboard (the waiting row links to the decision rail), then come back.
  await waiting.getByRole('link', { name: /Decide in the decision rail/ }).click();
  await expect(page).toHaveURL(runUrl + '#zone-decisions');
  const card = page.locator('[data-approval="ap-msg-1"]');
  await card.getByRole('button', { name: /^Approve/ }).click();
  await expect(card).toBeHidden({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents' }).click();

  // The decision is a row of its own, after the wait.
  const decision = passengers.locator('[data-kind="decision"]').first();
  await expect(decision).toContainText(/Approved by Duty Manager at m\d+/);
  await expect(passengers.locator('[data-kind="waiting"]').first()).not.toHaveAttribute(
    'data-pending',
    'true',
  );

  // Expand a row: facts, decision, detail; the scrubber moves to that row's moment (history mode).
  const toolRow = page.locator('[data-column="maintenance"] [data-kind="tool"]').first();
  await toolRow.locator('[data-row-button]').click();
  await expect(toolRow.locator('[data-row-button]')).toHaveAttribute('aria-expanded', 'true');
  await expect(toolRow.getByText('Facts gathered by this turn')).toBeVisible();
  await expect(toolRow.getByText('What it decided')).toBeVisible();
  const back = page.getByTestId('back-to-live');
  await expect(back).toBeVisible();
  const rowMinute = Number((await toolRow.locator('[data-minute]').innerText()).slice(1));
  await expect(back).toHaveText(`Viewing m${rowMinute} — Back to live`);
  const scrubber = page.getByTestId('agents-scrubber');
  expect(Number(await scrubber.getAttribute('aria-valuenow'))).toBeLessThan(
    Number(await scrubber.getAttribute('aria-valuemax')),
  );

  // Follow a delegation link: "→ briefed Maintenance (MX)" → "← brief from Orchestrator", highlighted and focused.
  await page.getByRole('button', { name: "Go to Maintenance (MX)'s brief" }).click();
  const brief = page.locator('[data-column="maintenance"] [data-kind="brief"]').first();
  await expect(brief).toHaveAttribute('data-highlighted', 'true');
  await expect(brief.locator('[data-row-button]')).toBeFocused();
  await expect(brief).toContainText('← brief from Orchestrator');

  // The dashboard shares the scrubber: it is in history mode too.
  await page.getByRole('link', { name: 'Back to the dashboard' }).click();
  await expect(page).toHaveURL(runUrl);
  await expect(page.getByText(/history · m\d+ — go live/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents' }).click();

  // Back to live.
  await page.getByTestId('back-to-live').click();
  await expect(page.getByTestId('back-to-live')).toBeHidden();
  await expect(page.getByTestId('agents-timeline')).toContainText('Live');

  // Hide thoughts (persisted).
  const thoughts = page.locator('[data-kind="thought"]');
  await expect(thoughts.first()).toBeVisible();
  await page.getByRole('switch', { name: 'Hide thoughts' }).click();
  await expect(thoughts).toHaveCount(0);
  expect(await page.evaluate(() => window.localStorage.getItem('ica.agents.hideThoughts'))).toBe('on');
  await page.getByRole('switch', { name: 'Hide thoughts' }).click();
});

test('mock showcase: every row type, the author banner and a stop row', async ({ page }) => {
  await page.goto('/runs/run-demo-agents/agents');
  await expect(page.locator('[data-author-line]')).toHaveText('Scenario enriched from your description');
  for (const kind of [
    'brief',
    'thought',
    'tool',
    'proposal',
    'waiting',
    'decision',
    'blocked',
    'stopped',
    'report',
  ])
    await expect(page.locator(`[data-kind="${kind}"]`).first()).toBeAttached();
  await expect(page.locator('[data-column="ground"] [data-kind="stopped"]')).toContainText(
    'Stopped: reached the 60 tool-call limit for this agent',
  );
  await expect(page.locator('[data-column-header="ground"] [data-status]')).toHaveAttribute(
    'data-status',
    'blocked',
  );
});

test('About: opens from the top bar with the credit link', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('about-button').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Designed and developed by Chris Beltran');
  const credit = dialog.getByRole('link', { name: 'Chris Beltran' });
  await expect(credit).toHaveAttribute('href', 'https://www.linkedin.com/in/chris-ai/');
  await expect(credit).toHaveAttribute('rel', 'noopener noreferrer');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('about-button')).toBeFocused();
});
