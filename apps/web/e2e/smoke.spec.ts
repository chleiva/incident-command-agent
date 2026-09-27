/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mock-mode smoke test: load, start a run, approve a decision, scrub back and check that the KPIs change.
 * `?timescale=4` compresses the mock replay pacing so the test runs in well under a minute.
 */
import { expect, test, type Page } from '@playwright/test';

/** Run a ⌘K palette command by its label (the first match must be selected before Enter). */
async function runCommand(page: Page, search: string, option: RegExp) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await page.keyboard.type(search);
  await expect(page.getByRole('option', { name: option }).first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

// These flows decide by hand: auto-approval is off by default (the ⌘K setting, persisted per viewer); made
// explicit here so a stored preference can never turn it on.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('ica.autoApprove.v2', 'off'));
});

test('start a run, approve a decision, scrub back in time', async ({ page }) => {
  await page.goto('/training?timescale=4');
  await expect(page.getByText('Simulated systems · fictional carrier').first()).toBeVisible();

  await page.getByLabel('Speed').selectOption('30');
  await page.getByRole('button', { name: 'Start Towbar shear and nose-gear contact on pushback' }).click();
  await expect(page).toHaveURL(/\/runs\/run-mock-/);

  // FR-02: the first event (and the KPI strip) arrives quickly after the trigger.
  await expect(page.getByTestId('kpi-value-cost')).toBeVisible({ timeout: 5_000 });

  // The first decision: the first passenger message.
  const card = page.locator('[data-approval="ap-msg-1"]');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText('AI-drafted').first()).toBeVisible();
  await card.getByRole('button', { name: /^Approve/ }).click();

  // Reconciled by the approval.decision event: the approver shows up on the phone mock-up.
  await expect(page.getByText(/Approved by Demo presenter/).first()).toBeVisible({ timeout: 15_000 });
  await expect(card).toBeHidden();

  // Plain language (task 06 §1.11): toggle it in the palette; glossary terms render their plain phrase.
  const fdp = page.getByTestId('kpi-value-compliance').locator('[data-term="FDP / duty margin"]');
  await expect(fdp).toHaveText('FDP');
  await runCommand(page, 'Plain language', /^Plain language: off/);
  await expect(fdp).toHaveText('crew working hours left');
  await expect(fdp).toHaveAttribute('data-plain', 'on');
  // The tooltip still names the original term.
  await fdp.hover();
  await expect(page.getByRole('tooltip').first()).toContainText('FDP');
  // Persisted in localStorage, then switched back off.
  expect(await page.evaluate(() => window.localStorage.getItem('ica.plainLanguage'))).toBe('on');
  await runCommand(page, 'Plain language', /^Plain language: on/);
  await expect(fdp).toHaveText('FDP');

  // Presenter control (task 06 §1.3): a forbidden call through the tier gate, shown as a card in the stream.
  await runCommand(page, 'Demonstrate blocked action', /^Demonstrate blocked action$/);
  const blocked = page
    .locator('[data-blocked-card]')
    .filter({ hasText: 'Presenter-triggered demonstration' });
  await expect(blocked.first()).toBeVisible({ timeout: 10_000 });
  await expect(blocked.first()).toContainText('Blocked by autonomy policy');
  await expect(blocked.first()).toContainText('Certifying staff');

  // Let the world move on, then remember the live cost.
  await expect(page.getByTestId('kpi-value-clock')).toHaveText(/^0:(1\d|[2-9]\d)$/, { timeout: 45_000 });
  const liveCost = await page.getByTestId('kpi-value-cost').innerText();

  // Scrub back to the start: the whole screen is rebuilt from the event log.
  const scrubber = page.getByTestId('scrubber');
  await scrubber.focus();
  await page.keyboard.press('Home');
  await expect(page.getByText('history').first()).toBeVisible();
  await expect(page.getByTestId('kpi-value-cost')).not.toHaveText(liveCost);
  await expect(page.getByTestId('kpi-value-clock')).toHaveText('0:00');

  // And back to live.
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.getByTestId('kpi-value-clock')).not.toHaveText('0:00');
});
