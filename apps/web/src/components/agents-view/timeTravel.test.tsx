/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view time-travels: in history mode it reconstructs that moment from the events up to the cursor.
 * Rows after the cursor are hidden (each column says how many, with "Back to live"); a column appears only once its
 * agent had acted; status dots, turn counts and the author banner are as they were then; a decision made later
 * shows as still waiting (and offers no "Decide" link, since it is no longer pending now). Live mode is unchanged.
 * Rendered through the real route over the mock backend's showcase run.
 */
import { foldEvents } from '@ica/schema/browser';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { columnStatus, deriveAgents, laterActions, turnCount } from '../../agents/rows';
import { ServicesProvider } from '../../app/services';
import type { Services } from '../../lib/config';
import { SHOWCASE_RUN_ID, buildAgentsShowcase } from '../../mocks/agentsShowcase';
import { createMockServices } from '../../mocks/services';
import Agents from '../../routes/Agents';
import { clearSharedRunStores, sharedRunStore } from '../../store/sharedRuns';
import { useUi } from '../../store/ui';

const SHOWCASE = buildAgentsShowcase();
/** Just before the first passenger message is decided (proposal at seq 94, decision at seq 105). */
const BEFORE_DECISION = 100;

let services: Services;
beforeAll(async () => {
  services = await createMockServices();
  useUi.setState({ autoApprove: false });
});
afterEach(() => {
  clearSharedRunStores();
  useUi.setState({ hideThoughts: false });
});

async function open() {
  const utils = render(
    <ServicesProvider services={services}>
      <MemoryRouter initialEntries={[`/runs/${SHOWCASE_RUN_ID}/agents`]}>
        <Routes>
          <Route path="/runs/:runId/agents" element={<Agents />} />
        </Routes>
      </MemoryRouter>
    </ServicesProvider>,
  );
  const store = sharedRunStore(SHOWCASE_RUN_ID);
  await waitFor(() => expect(store.getState().log.lastSeq).toBe(SHOWCASE.at(-1)!.seq));
  await screen.findByTestId('agents-board');
  return { ...utils, store };
}

const column = (role: string) => document.querySelector(`[data-column="${role}"]`) as HTMLElement | null;
const seqs = () =>
  [...document.querySelectorAll('[data-row]')].map((r) => Number(r.getAttribute('data-seq')));

describe('Agents view in history mode', () => {
  it('live mode is unchanged: every column and row, no "later actions" footer', async () => {
    await open();
    const full = deriveAgents(SHOWCASE);
    expect(document.querySelectorAll('[data-column]')).toHaveLength(full.columns.length);
    expect(column('record')).not.toBeNull();
    expect(document.querySelector('[data-later-footer]')).toBeNull();
    expect(document.querySelector('[data-author-banner]')).not.toBeNull();
  });

  it('hides rows after the cursor, with "{n} later actions — Back to live" per column', async () => {
    const { store } = await open();
    act(() => store.getState().setCursor(BEFORE_DECISION));
    expect(seqs().length).toBeGreaterThan(0);
    expect(Math.max(...seqs())).toBeLessThanOrEqual(BEFORE_DECISION);
    const later = laterActions(deriveAgents(SHOWCASE), BEFORE_DECISION);
    const footer = column('passenger')!.querySelector('[data-later-footer]')!;
    expect(footer.textContent).toBe(`${later.passenger} later actions — Back to live`);
    expect(Number(footer.querySelector('[data-later-count]')!.getAttribute('data-later-count'))).toBe(
      later.passenger,
    );
    // Back to live from the footer.
    await userEvent.click(footer.querySelector('button')!);
    expect(store.getState().cursorSeq).toBeNull();
    expect(document.querySelector('[data-later-footer]')).toBeNull();
    expect(Math.max(...seqs())).toBeGreaterThan(BEFORE_DECISION);
  });

  it('a column appears only once its agent had acted', async () => {
    const { store } = await open();
    act(() => store.getState().setCursor(BEFORE_DECISION));
    // The Incident Record agent starts later (m7): no column yet.
    expect(column('record')).toBeNull();
    expect(column('passenger')).not.toBeNull();
    act(() => store.getState().setCursor(1));
    expect(document.querySelectorAll('[data-column]')).toHaveLength(0);
  });

  it('status dots and turn counts are computed at the cursor', async () => {
    const { store } = await open();
    act(() => store.getState().setCursor(BEFORE_DECISION));
    const upTo = SHOWCASE.filter((e) => e.seq <= BEFORE_DECISION);
    const then = foldEvents(upTo);
    const model = deriveAgents(upTo);
    expect(columnStatus(then, 'passenger')).toBe('waiting');
    expect(columnStatus(foldEvents(SHOWCASE), 'passenger')).not.toBe('waiting');
    const header = document.querySelector('[data-column-header="passenger"]')!;
    expect(header.querySelector('[data-status]')!.getAttribute('data-status')).toBe('waiting');
    for (const c of model.columns) {
      const turns = turnCount(c.rows);
      const text = document.querySelector(`[data-column-header="${c.role}"] [data-turns]`)!.textContent;
      expect(text, c.role).toMatch(new RegExp(`(^|\\s)${turns} turns?$`));
    }
    const fullPassenger = deriveAgents(SHOWCASE).columns.find((c) => c.role === 'passenger')!;
    expect(turnCount(fullPassenger.rows)).toBeGreaterThan(
      turnCount(model.columns.find((c) => c.role === 'passenger')!.rows),
    );
  });

  it('a decision made later shows as still waiting, without a "Decide" link (it is not pending now)', async () => {
    const { store } = await open();
    act(() => store.getState().setCursor(BEFORE_DECISION));
    const passenger = column('passenger')!;
    const waiting = passenger.querySelector('[data-kind="waiting"]')!;
    expect(waiting).toHaveAttribute('data-pending', 'true');
    expect(passenger.querySelector('[data-kind="decision"]')).toBeNull();
    expect(waiting.textContent).not.toContain('Decide in the decision rail');
    // Live: the decision row is back and the wait is over.
    act(() => store.getState().setCursor(null));
    expect(column('passenger')!.querySelector('[data-kind="decision"]')).not.toBeNull();
    expect(column('passenger')!.querySelector('[data-kind="waiting"]')).not.toHaveAttribute(
      'data-pending',
      'true',
    );
  });

  it('the author banner is computed at the cursor', async () => {
    const { store } = await open();
    act(() => store.getState().setCursor(1));
    expect(document.querySelector('[data-author-banner]')).toBeNull();
    act(() => store.getState().setCursor(2));
    expect(document.querySelector('[data-author-line]')!.textContent).toBe(
      'Preparing the scenario from your description…',
    );
    act(() => store.getState().setCursor(BEFORE_DECISION));
    expect(document.querySelector('[data-author-line]')!.textContent).toBe(
      'Scenario enriched from your description',
    );
  });
});
