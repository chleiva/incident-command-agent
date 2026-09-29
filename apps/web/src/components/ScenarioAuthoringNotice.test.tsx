/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Authoritative free text: the "Scenario from your description" card and the calm "not built" notice. */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScenarioAuthoringNotice } from './ScenarioAuthoringNotice';

describe('ScenarioAuthoringNotice', () => {
  it('shows what the Author wrote once the scenario is authored (trigger, narrative, affected flights)', () => {
    render(
      <ScenarioAuthoringNotice
        authoring={{
          status: 'patched',
          detail: 'Scenario written from your description',
          seq: 4,
          summary: {
            title: 'UK airspace closed',
            triggerType: 'airspace-closure',
            trigger: 'UK airspace closed: volcanic ash.',
            narrative: 'Volcanic ash covers European airspace; the UK has closed its airspace.',
            affectedFlights: 9,
            network: true,
          },
        }}
      />,
    );
    const card = screen.getByTestId('authored-scenario-card');
    expect(within(card).getByText('Scenario from your description')).toBeTruthy();
    expect(within(card).getByTestId('authored-trigger').textContent).toBe(
      'UK airspace closed: volcanic ash.',
    );
    expect(within(card).getByTestId('authored-flights').textContent).toBe('Affects 9 flights');
    expect(within(card).getByText('network-wide')).toBeTruthy();
    expect(within(card).getByText(/AI-drafted/i)).toBeTruthy();
  });

  it('says calmly that no scenario was built and that nothing else ran', () => {
    render(
      <ScenarioAuthoringNotice
        authoring={{
          status: 'failed',
          detail:
            "Couldn't build a scenario from that description — try rephrasing or choose an incident type",
          seq: 4,
        }}
      />,
    );
    const n = screen.getByTestId('scenario-authoring');
    expect(n.getAttribute('role')).toBe('status');
    expect(n.getAttribute('data-status')).toBe('failed');
    expect(n.textContent).toMatch(/try rephrasing or choose an incident type/);
    expect(n.textContent).toMatch(/Nothing else was run in its place/);
    expect(screen.queryByTestId('authored-scenario-card')).toBeNull();
  });
});
