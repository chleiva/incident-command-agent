/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Decisions are always NOW, in mock mode: by default the decision popup approves in the viewer's name unless they
 * object ("approve unless objected", 60 s; shortened here by the mock-only test hook), and the Agents view records
 * "Approved by {name} (implicit)"; switched off in ⌘K it waits for the viewer (with a "Press Space to pause the
 * clock" hint); in history mode the rail still lists the live decisions and the Agents view hides the rows after
 * the viewed moment.
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

test('by default the popup approves in your name after its countdown, recorded as your implicit approval', async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__ICA_TEST_AUTO_APPROVE_MS__ = 2_000;
    // A stored v2 preference ("off", the old default) is dropped once: the viewer starts ON.
    window.localStorage.setItem('ica.autoApprove.v2', 'off');
  });
  await startS01(page);

  const popup = page.locator('[data-decision-popup] article[data-popup-approval="ap-msg-1"]');
  await expect(popup).toBeVisible({ timeout: 30_000 });
  await expect(popup).toContainText('Decision needed');
  await expect(popup).toContainText('Asked by the Passengers agent');
  await expect(popup.getByRole('timer')).toContainText(/Approving on your behalf in \ds unless you object/);
  // Not a dialog: the page stays usable.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The countdown runs out: approved through the normal route, in the viewer's name, implicitly.
  await expect(popup).toBeHidden({ timeout: 15_000 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/\/agents$/);
  const decision = page.locator('[data-column="passenger"] [data-kind="decision"]').first();
  await expect(decision).toContainText(/Approved by Demo presenter \(implicit\) at m\d+/, {
    timeout: 15_000,
  });
  await expect(decision).not.toContainText('Auto-approved (simulation)');
});

test('switched off in ⌘K, the popup waits for a person: no countdown, a Space hint; Space pauses the clock', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('ica.autoApprove.v3', 'off'));
  await startS01(page);
  const popup = page.locator('[data-decision-popup] article[data-popup-approval="ap-msg-1"]');
  await expect(popup).toBeVisible({ timeout: 30_000 });
  await expect(popup).toContainText('Waiting for your decision');
  await expect(popup.locator('[data-popup-pause-hint]')).toHaveText(
    'Press Space to pause the clock while you decide',
  );
  await expect(popup.getByRole('timer')).toHaveCount(0);
  // Space pauses the world clock while the card itself has focus.
  await popup.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('header').getByText('paused', { exact: true })).toBeVisible();
  await expect(popup).toBeVisible();
});

test('history mode: the rail still lists live decisions; the Agents view hides later rows', async ({
  page,
}) => {
  // Implicit approval switched off: the decision stays pending while we time-travel.
  await page.addInitScript(() => window.localStorage.setItem('ica.autoApprove.v3', 'off'));
  await startS01(page);

  const rail = page.locator('#zone-decisions');
  await expect(rail.locator('[data-approval="ap-msg-1"]')).toBeVisible({ timeout: 30_000 });
  const popup = page.locator('[data-decision-popup] article[data-popup-approval="ap-msg-1"]');
  await expect(popup).toContainText('Waiting for your decision');

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
