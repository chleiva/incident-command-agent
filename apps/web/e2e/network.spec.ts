/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** The live-network home (mock mode): map, flight list, flight panel. `?at=HH:MM` pins the network clock start. */
import { expect, test } from '@playwright/test';

test('report an airborne incident: the aircraft flies on the cockpit map to the arrival station', async ({
  page,
}) => {
  await page.goto('/?at=12:00&timescale=4');
  await page.getByRole('button', { name: 'Airborne', exact: true }).click();
  await page.getByRole('listbox', { name: 'Flights' }).getByRole('option').first().click();
  await page.getByTestId('flight-panel').getByRole('button', { name: 'Report incident' }).click();
  const dialog = page.getByTestId('report-dialog');
  // Only airborne types for a flight in the air; the commander decides the flight.
  await expect(dialog.locator('input[type="radio"]').first()).toBeVisible();
  await expect(dialog.locator('[data-incident-type="fuel_spill"]')).toHaveCount(0);
  await dialog.locator('input[type="radio"]:not([disabled])').first().check();
  await expect(dialog.getByTestId('preview-trigger')).not.toBeEmpty();
  await expect(dialog.getByText(/the commander lands at/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/runs\/run-mock-/);
  await expect(page.getByTestId('arrival-panel')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-airborne]').first()).toBeVisible();
  await expect(page.getByTestId('arrival-eta')).toContainText(/Lands in|Landed/);
});

test('report a ground incident from the map: list → preview → start → cockpit', async ({ page }) => {
  await page.goto('/?at=12:00&timescale=4');
  await page.getByRole('button', { name: 'On ground', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Flights' });
  // A flight still to depart (boarding or scheduled) has pre-departure ground incident types.
  await list
    .getByRole('option')
    .filter({ hasText: /Boarding|Scheduled/ })
    .first()
    .click();
  const panel = page.getByTestId('flight-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Report incident' }).click();

  const dialog = page.getByTestId('report-dialog');
  await expect(dialog).toBeVisible();
  // A simple list for the flight's phase; airborne types are not offered on the ground.
  const radios = dialog.getByRole('radiogroup', { name: 'Incident type' }).getByRole('radio');
  await expect(radios.first()).toBeVisible();
  await expect(dialog.locator('[data-incident-type="air_turnback"]')).toHaveCount(0);
  await dialog.locator('input[type="radio"]:not([disabled])').first().check();
  await expect(dialog.getByTestId('preview-trigger')).not.toBeEmpty();
  // Optional free text: the note explains the extra step.
  await dialog.getByRole('textbox').fill('Two passengers needing assistance are already on board.');
  await expect(dialog.getByTestId('author-note')).toBeVisible();
  await dialog.getByRole('button', { name: 'Start' }).click();

  await expect(page).toHaveURL(/\/runs\/run-mock-/);
  await expect(page.getByTestId('kpi-value-cost')).toBeVisible({ timeout: 10_000 });
});

test('home is the live network: search, filter and open an airborne flight', async ({ page }) => {
  await page.goto('/?at=12:00');
  await expect(page.getByTestId('network-map').locator('canvas')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Flights today' })).toBeVisible();
  await expect(page.getByTestId('network-clock')).toContainText('12:0');

  // "/" focuses the search; the list narrows as you type.
  await page.locator('body').click({ position: { x: 900, y: 600 } });
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: /Search flights/ })).toBeFocused();
  await page.keyboard.type('MAN');
  const options = page.getByRole('listbox', { name: 'Flights' }).getByRole('option');
  await expect(options.first()).toContainText('MAN');
  await page.getByRole('searchbox', { name: /Search flights/ }).fill('');

  // Airborne filter, then select with the keyboard.
  await page.getByRole('button', { name: 'Airborne', exact: true }).click();
  await expect(options.first()).toContainText(/Airborne|On approach/);
  const flight = await options.first().getAttribute('data-flight');
  await page.getByRole('listbox', { name: 'Flights' }).focus();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('flight-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: flight! })).toBeVisible();
  await expect(panel.getByTestId('options-only-note')).toContainText("commander's consideration");
  await expect(page).toHaveURL(new RegExp(`flight=${flight}`));

  // Esc closes the panel; the training library is one click away.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByRole('link', { name: 'Training scenarios' }).click();
  await expect(page.getByRole('heading', { name: 'Training scenarios' })).toBeVisible();
});
