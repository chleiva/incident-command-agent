/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Keyboard operation in mock mode: ⌘K palette, F full screen, Space pauses the world clock; FR-02 timing. */
import { expect, test } from '@playwright/test';

test('palette, full-screen zone, pause/resume and first-event latency', async ({ page }) => {
  await page.goto('/?timescale=4');
  await page
    .getByRole('button', { name: 'Start Lightning strike at outstation, no licensed engineer on site' })
    .click();
  await expect(page.getByTestId('kpi-value-cost')).toBeVisible({ timeout: 5_000 });

  // ⌘K / Ctrl+K opens the palette; toggle the dev overlay from it.
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await page.keyboard.type('dev overlay');
  await expect(page.getByRole('option', { name: 'Toggle the dev overlay' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  const overlay = page.getByText(/first event after trigger: \d+ ms/);
  await expect(overlay).toBeVisible();
  const ms = Number((await overlay.innerText()).match(/(\d+) ms/)![1]);
  expect(ms).toBeLessThan(2_000); // FR-02

  // F expands the focused zone; Esc returns.
  await page.locator('#zone-ground').click({ position: { x: 20, y: 60 } });
  await page.keyboard.press('f');
  await expect(page.locator('#zone-ground')).toHaveClass(/fixed/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#zone-ground')).not.toHaveClass(/fixed/);

  // Space pauses and resumes the world clock (POST /runs/{id}/control).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect(page.getByText('paused', { exact: true })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.getByText('running', { exact: true })).toBeVisible();

  // WebSocket drop: "reconnecting" toast, polling, then "Reconnected".
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('connection drop');
  await page.getByRole('option', { name: /Simulate a connection drop/ }).click();
  await expect(page.getByText('Connection lost — reconnecting')).toBeVisible();
  await expect(page.getByText('Reconnected', { exact: true })).toBeVisible({ timeout: 20_000 });
});
