/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Task 06 UI: provenance on cards, swap wording, "Blocked by autonomy policy", "Approval invalidated", provisional
 * reading and "Decided by", KPI estimates and check lists, "Unknown" maintenance fields, the demo control in mock
 * mode — all driven by the mock-mode recordings (the same data the cockpit shows without a backend).
 */
import {
  PROVISIONAL_READING_LABEL,
  foldEvents,
  validateEvent,
  type ListEventsResponse,
  type RunEvent,
} from '@ica/schema';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../lib/api';
import { simulatedLabel } from '../lib/brand';
import {
  agentFeed,
  latestEngineeringDecision,
  latestProvisionalReading,
  openInvalidations,
} from '../lib/derive';
import { MockBackend } from '../mocks/mockBackend';
import { S01, S04, pendingApproval, viewAt } from '../test/fixtureViews';
import { AgentStream } from './agents/AgentStream';
import { SWAP_APPROVE_LABEL, SWAP_BODY, DecisionCard } from './decisions/DecisionCard';
import { DecisionQueue } from './decisions/DecisionQueue';
import { AirworthinessPanel } from './ground/AirworthinessPanel';
import { SystemTabs } from './inspector/SystemTabs';
import { KpiStrip } from './kpi/KpiStrip';
import { complianceChecks, safetyChecks } from './kpi/kpiModel';

describe('provenance and scope on decision cards (§1.5)', () => {
  it('shows sources with a one-click quote, timestamps, unresolved checks and the approval scope', async () => {
    const { approval } = pendingApproval(S01.agent, 'ap-msg-1');
    render(<DecisionCard approval={approval} nowMinute={6} onDecide={() => {}} />);
    const panel = screen.getByRole('region', { name: 'Provenance and scope' });
    expect(within(panel).getByText(/Created min 5\.0/)).toBeInTheDocument();
    expect(within(panel).getByText(/Data as of min 4\.8/)).toBeInTheDocument();
    expect(within(panel).getByText(/The 07:15 next-update time is still achievable/)).toBeInTheDocument();
    expect(within(panel).getByText(/Sending this exact message, once/)).toBeInTheDocument();
    expect(within(panel).getByText(/Rebooking, care vouchers or compensation decisions/)).toBeInTheDocument();
    const source = within(panel).getByRole('button', { name: /passenger information duties/ });
    expect(within(panel).queryByText(/must be informed of their rights/)).toBeNull();
    await userEvent.click(source);
    expect(within(panel).getByText(/must be informed of their rights/)).toBeInTheDocument();
  });

  it('each option of a request_decision carries its own scope and checks', () => {
    const { approval } = pendingApproval(S01.agent, 'ap-decision-1');
    render(<DecisionCard approval={approval} nowMinute={31} onDecide={() => {}} />);
    const swapOption = document.querySelector('[data-option-provenance="opt-swap"]')!;
    expect(swapOption.textContent).toMatch(/Crew for AX-LRM confirmed by crew control/);
    expect(swapOption.textContent).toMatch(/Choosing “Swap ACX214\/215/);
  });
});

describe('swap approval wording (§1.4)', () => {
  it('the primary action sends a request to OCC and the body says OCC executes', async () => {
    const { approval } = pendingApproval(S01.agent, 'ap-swap-1');
    const onDecide = vi.fn();
    render(<DecisionCard approval={approval} nowMinute={36.5} onDecide={onDecide} />);
    expect(
      screen.getByText(
        (_, el) => el?.getAttribute('data-swap-note') !== null && el?.textContent === SWAP_BODY,
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${SWAP_APPROVE_LABEL}`) }));
    expect(onDecide).toHaveBeenCalledWith({ decision: 'approve', roleTitle: 'Duty Manager' });
    // In the recording, OCC confirms and executes a few minutes later.
    expect(viewAt(S01.agent, 37).view.systems.occ.swaps['swap-1']?.status).toBe('requested');
    expect(viewAt(S01.agent, 42).view.systems.occ.swaps['swap-1']?.status).toBe('executed');
  });
});

describe('Blocked by autonomy policy (§1.3)', () => {
  it('renders the refusal as a card with tool, reason, rule and who decides', () => {
    const { view, events } = viewAt(S01.agent, 21);
    render(<AgentStream items={agentFeed(events)} roleStates={new Map()} />);
    const card = screen.getByRole('region', { name: 'Blocked by autonomy policy' });
    expect(within(card).getByText('Blocked by autonomy policy')).toBeInTheDocument();
    expect(within(card).getByText('defer_defect')).toBeInTheDocument();
    expect(within(card).getByText(/Part-145 \/ ORO\.MLR\.105/)).toBeInTheDocument();
    expect(within(card).getByText('Certifying staff')).toBeInTheDocument();
    expect(view.guardrailBlocks[0]).toMatchObject({ authority: 'Certifying staff' });
  });
});

describe('approval invalidation (§1.7)', () => {
  it('the notice lists the changed assumption (was → now), then the revised proposal follows', () => {
    const { view, events } = viewAt(S04.agent, 26.1);
    const feed = agentFeed(events);
    const kinds = feed.map((i) => i.kind);
    const iv = kinds.indexOf('invalidated');
    expect(iv).toBeGreaterThan(-1);
    // re-gathered evidence cards (normal tool calls) after the notice, then the revised proposal
    const after = feed.slice(iv + 1).filter((i) => i.kind === 'tool');
    expect(after.map((i) => i.kind === 'tool' && i.call.tool)).toEqual([
      'get_manifest_summary',
      'estimate_eu261_exposure',
      'send_passenger_message',
    ]);
    render(<AgentStream items={feed} roleStates={new Map()} />);
    const notice = screen.getAllByRole('region', { name: 'Approval invalidated' })[0]!;
    expect(notice.textContent).toMatch(/Engineer ETA: min 38 → min 78/);
    expect(screen.getByText(/Revised proposal \(replaces an invalidated approval\)/)).toBeInTheDocument();

    expect(openInvalidations(view).map((a) => a.approvalId)).toEqual(['ap4-msg-2']);
    expect(view.approvals['ap4-msg-3']!.supersedesApprovalId).toBe('ap4-msg-2');
  });

  it('the decision rail shows the notice above the revised proposal', () => {
    const { view } = viewAt(S04.agent, 26.1);
    render(
      <DecisionQueue
        invalidated={openInvalidations(view)}
        pending={view.pendingApprovalIds.map((id) => view.approvals[id]!)}
        decided={[]}
        nowMinute={26.1}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByRole('region', { name: 'Approval invalidated' })).toHaveTextContent(
      /Revised proposal awaiting you/,
    );
    expect(screen.getByText('Revised after an invalidated approval')).toBeInTheDocument();
  });
});

describe('provisional reading and Decided by (§1.2), Unknown maintenance data (§1.6)', () => {
  it('Decided by is empty until the human decision is recorded; missing record fields are Unknown', () => {
    const before = viewAt(S01.agent, 40).view;
    const aircraft = before.systems.mne.aircraft['AX-KES']!;
    const { rerender } = render(
      <AirworthinessPanel
        aircraft={aircraft}
        reading={latestProvisionalReading(before)?.reading ?? null}
        decision={latestEngineeringDecision(before, 'AX-KES')}
        workOrders={Object.values(before.systems.mne.workOrders)}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Airworthiness decision' });
    expect(
      within(panel).getByText((_, el) => el?.hasAttribute('data-decided-by') ?? false),
    ).toHaveTextContent('Awaiting certifying staff');
    expect(within(panel).getAllByText('Unknown')).toHaveLength(2); // last check, defect history
    expect(panel.textContent).not.toMatch(/passed|serviceable/i);

    const after = viewAt(S01.agent, 56).view;
    rerender(
      <AirworthinessPanel
        aircraft={after.systems.mne.aircraft['AX-KES']!}
        reading={latestProvisionalReading(after)?.reading ?? null}
        decision={latestEngineeringDecision(after, 'AX-KES')}
        workOrders={Object.values(after.systems.mne.workOrders)}
      />,
    );
    expect(screen.getByText('Certifying Engineer (B1) — Ada Pennick')).toBeInTheDocument();
    expect(screen.getByText(PROVISIONAL_READING_LABEL)).toBeInTheDocument();
  });

  it('a partial record shows what is known and Unknown for the rest', () => {
    const { view } = viewAt(S04.agent, 10);
    render(
      <AirworthinessPanel
        aircraft={view.systems.mne.aircraft['AX-TQA']!}
        reading={null}
        decision={null}
        workOrders={[]}
      />,
    );
    expect(screen.getByText('A-check · 2026-06-21')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(1);
  });

  it('the M&E inspector shows Unknown for missing maintenance fields', () => {
    const { view } = viewAt(S01.agent, 10);
    render(<SystemTabs systems={view.systems} recent={new Map()} lastMutation={null} />);
    const table = screen.getByRole('region', { name: 'aircraft table' });
    expect(within(table).getAllByText('Unknown').length).toBeGreaterThanOrEqual(2);
    expect(within(table).getByText('lastCheck')).toBeInTheDocument();
  });
});

describe('labels (§1.8)', () => {
  it('cost and customer tiles are estimates; compliance and safety are check lists, not scores', () => {
    const { view, events } = viewAt(S01.agent, 31);
    render(<KpiStrip kpis={view.kpis} series={[]} />);
    expect(screen.getByText('Disruption cost (estimate)')).toBeInTheDocument();
    expect(screen.getByText('Passenger satisfaction (estimate)')).toBeInTheDocument();
    for (const key of ['compliance', 'safety']) {
      const list = screen.getByTestId(`kpi-value-${key}`);
      expect(list.tagName).toBe('UL');
      expect(list.textContent).not.toMatch(/\d+\/\d+/);
      for (const li of list.querySelectorAll('li'))
        expect(['pass', 'fail', 'pending']).toContain(li.getAttribute('data-status'));
    }
    const safety = safetyChecks(view.kpis!);
    expect(safety.find((c) => c.key === 'noForbiddenAttempts')).toMatchObject({ status: 'fail' });
    // Not drafted yet at minute 31: pending (the 72-hour window is open), never a failure.
    expect(complianceChecks(view.kpis!).find((c) => c.key === 'morDraftedWithin72h')?.status).toBe('pending');
    expect(events.length).toBeGreaterThan(0);
  });

  it('the simulated-systems badge always says so, whatever the brand disclaimer', () => {
    expect(simulatedLabel('Simulated systems · fictional carrier')).toBe(
      'Simulated systems · fictional carrier',
    );
    expect(simulatedLabel('demonstration only')).toBe('Simulated systems · demonstration only');
    expect(simulatedLabel('')).toMatch(/^Simulated systems/);
  });
});

describe('mock mode: Demonstrate blocked action (§1.3)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('emits the tier-gate refusal flagged presenter-triggered and counts it in the safety KPI', async () => {
    const backend = new MockBackend({ timeScale: 1000 });
    const api = createApiClient({
      baseUrl: 'mock://api',
      transport: backend.transport(),
      sleep: async () => {},
    });
    const settle = async (ms = 2_000) => {
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(ms / 20);
    };
    const created = api.createRun({ scenarioId: 's01-pushback-tug-contact', mode: 'agent', speed: 30 });
    await settle(100);
    const { runId } = await created;
    await settle(3_000);
    const ctl = api.control(runId, { action: 'demo_forbidden' });
    await settle(200);
    await ctl;
    const page = api.listEvents(runId, 0);
    await settle(200);
    const events: RunEvent[] = ((await page) as ListEventsResponse).events;
    for (const e of events) expect(validateEvent(e).ok).toBe(true);
    const block = events.find((e) => e.type === 'guardrail.blocked' && e.payload.presenterTriggered);
    expect(block?.payload).toMatchObject({
      layer: 'tier',
      tool: 'defer_defect',
      authority: 'Certifying staff',
    });
    const kpis = foldEvents(events).kpis!;
    expect(kpis.safety.inputs.presenterTriggeredAttempts).toBe(1);
    expect(kpis.safety.formula).toMatch(/presenter-triggered/);
  });
});
