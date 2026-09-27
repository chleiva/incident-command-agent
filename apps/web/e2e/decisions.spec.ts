/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Decisions are always NOW, in mock mode: the gentle decision popup auto-approves after its countdown (shortened here
 * by the mock-only test hook) and the Agents view records "Auto-approved (simulation)"; in history mode the rail
 * still lists the live decisions and the Agents view hides the rows after the viewed moment.
 */
import { expect, test, type Page } from '@playwright/test';

async function startS01(page: Page) {
  await page.goto('/training?timescale=4');
  await page.getByLabel('Speed').selectOption('30');
  await page.getByRole('button', { name: 'Start Towbar shear and nose-gear contact on pushback' }).click();
  await expect(page).toHaveURL(/\/runs\/run-mock-[^/]+$/);
  // Keep the pointer away from the card: hovering pauses the countdown.
  await page.mouse.move(5, 5);
}

test('the decision popup auto-approves after its countdown, recorded as "Auto-approved (simulation)"', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ICA_TEST_AUTO_APPROVE_MS__ = 2_000;
    window.localStorage.removeItem('ica.autoApprove');
  });
  await startS01(page);

  const popup = page.locator('[data-decision-popup] article[data-popup-approval="ap-msg-1"]');
  await expect(popup).toBeVisible({ timeout: 30_000 });
  await expect(popup).toContainText('Decision needed');
  await expect(popup).toContainText('Asked by the Passengers agent');
  await expect(popup.getByRole('timer')).toContainText(/Approving automatically in \ds/);
  // Not a dialog: the page stays usable.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The countdown runs out: approved through the normal route as the simulation policy.
  await expect(popup).toBeHidden({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/\/agents$/);
  const decision = page.locator('[data-column="passenger"] [data-kind="decision"]').first();
  await expect(decision).toContainText(/Auto-approved \(simulation\) at m\d+/, { timeout: 15_000 });
  await expect(decision).not.toContainText('Demo presenter');
});

test('history mode: the rail still lists live decisions; the Agents view hides later rows', async ({
  page,
}) => {
  // Auto-approval off (⌘K setting, persisted): the decision stays pending while we time-travel.
  await page.addInitScript(() => window.localStorage.setItem('ica.autoApprove', 'off'));
  await startS01(page);

  const rail = page.locator('#zone-decisions');
  await expect(rail.locator('[data-approval="ap-msg-1"]')).toBeVisible({ timeout: 30_000 });
  const popup = page.locator('[data-decision-popup] article[data-popup-approval="ap-msg-1"]');
  await expect(popup).toContainText('Waiting for your decision (auto-approve is off)');

  // Scrub back to the start: the rail still shows the live decision, with a calm note.
  await page.getByTestId('scrubber').focus();
  await page.keyboard.press('Home');
  await expect(page.getByText(/history · m\d+ — go live/)).toBeVisible();
  await expect(rail.locator('[data-approval="ap-msg-1"]')).toBeVisible();
  await expect(rail.locator('[data-rail-history-note]')).toHaveText(
    /You’re viewing m\d+ — decisions below are live/,
  );
  await expect(popup.locator('[data-popup-history]')).toBeVisible();

  // Agents view at an earlier moment: rows after it are hidden, each column says how many.
  await page.keyboard.press('End');
  await expect(page.getByText(/history · m\d+ — go live/)).toBeHidden();
  await page.locator('[data-zone-expand="agents"]').click();
  await expect(page).toHaveURL(/\/agents$/);
  const toolRow = page.locator('[data-column="maintenance"] [data-kind="tool"]').first();
  await toolRow.locator('[data-row-button]').click();
  await expect(page.getByTestId('back-to-live')).toBeVisible();
  const cursor = Number(await toolRow.getAttribute('data-seq'));
  await expect(page.locator('[data-later-footer]').first()).toContainText(
    /\d+ later actions? — Back to live/,
  );
  const seqs = await page
    .locator('[data-row]')
    .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-seq'))));
  expect(Math.max(...seqs)).toBeLessThanOrEqual(cursor);

  // "Back to live" from a column footer restores every row.
  await page.locator('[data-later-footer] button').first().click();
  await expect(page.getByTestId('back-to-live')).toBeHidden();
  await expect(page.locator('[data-later-footer]')).toHaveCount(0);
});
