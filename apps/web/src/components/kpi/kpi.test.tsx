/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { kpiAtMinute, kpiSeries } from '../../lib/derive';
import { createRunStore } from '../../store/runStore';
import { S01, viewAt } from '../../test/fixtureViews';
import type { KpiSnapshot, RunProjection } from '@ica/schema/browser';
import {
  AUTO_APPROVED_NOT_HUMAN,
  autoApprovedCount,
  autoDecidedApprovals,
  safetyChecks,
  tileModels,
} from './kpiModel';
import { KpiStrip } from './KpiStrip';
import { WhyDrawer } from './WhyDrawer';

describe('KPI strip', () => {
  const { view, events } = viewAt(S01.agent, 31);
  const series = kpiSeries(events);
  const base = kpiAtMinute(kpiSeries(S01.baseline), 31);

  it('shows six tiles with the baseline ghost delta', () => {
    render(<KpiStrip kpis={view.kpis} series={series} baseline={base} />);
    expect(screen.getAllByRole('button')).toHaveLength(6);
    expect(screen.getByText(/^baseline €/)).toBeInTheDocument();
  });

  it('colours only when a threshold is crossed', () => {
    const models = tileModels(view.kpis!, null);
    expect(models.find((m) => m.key === 'countdown')!.tone).toBe('warning'); // 2 min to the 3-hour threshold
    expect(models.find((m) => m.key === 'clock')!.tone).toBe('neutral');
    const early = viewAt(S01.agent, 1).view.kpis!;
    expect(tileModels(early, null).every((m) => m.tone === 'neutral')).toBe(true);
  });

  it('renders loading and waiting states', () => {
    const { rerender } = render(<KpiStrip kpis={null} series={[]} status="loading" />);
    expect(screen.getByRole('status', { name: 'Loading indicators' })).toBeInTheDocument();
    rerender(<KpiStrip kpis={null} series={[]} />);
    expect(screen.getAllByText('Waiting for the first snapshot')).toHaveLength(6);
  });
});

describe('safety gate: a software decision is never shown as a human one', () => {
  const { view } = viewAt(S01.agent, 31);
  const k = view.kpis!;
  const gate = (kpis: KpiSnapshot, ctx?: { autoApproved?: number }) =>
    safetyChecks(kpis, ctx).find((c) => c.key === 'decisionsFirst')!;
  const simApproved = (p: RunProjection): RunProjection => {
    const [id, a] = Object.entries(p.approvals).find(([, x]) => x.decision)!;
    return {
      ...p,
      approvals: {
        ...p.approvals,
        [id]: {
          ...a,
          decision: { ...a.decision!, decidedBy: { kind: 'policy', policy: 'simulation-auto' } },
        },
      },
    } as RunProjection;
  };

  it('only human decisions: ✓ as before', () => {
    expect(autoDecidedApprovals(view)).toBe(0);
    expect(gate(k, { autoApproved: autoDecidedApprovals(view) }).status).toBe(
      k.safety.value.humanDecisionsBeforeDependentActions > 0 ? 'pass' : 'pending',
    );
  });

  it('derived from approval.decision (decidedBy.kind !== human): ⚠ "Auto-approved — not a human decision"', () => {
    const auto = autoDecidedApprovals(simApproved(view));
    expect(auto).toBe(1);
    const c = gate(k, { autoApproved: auto });
    expect(c.status).toBe('warning');
    expect(c.short).toBe(AUTO_APPROVED_NOT_HUMAN);
    expect(AUTO_APPROVED_NOT_HUMAN).toBe('Auto-approved — not a human decision');
    expect(c.note).toContain('1 approval-gated action was approved by the simulation or a policy');
  });

  it('prefers the backend field (safety.autoApprovedActions) when present', () => {
    const withField = {
      ...k,
      safety: { ...k.safety, value: { ...k.safety.value, autoApprovedActions: 2 } },
    } as KpiSnapshot;
    expect(autoApprovedCount(withField, { autoApproved: 0 })).toBe(2);
    expect(gate(withField).status).toBe('warning');
    const zero = {
      ...k,
      safety: { ...k.safety, value: { ...k.safety.value, autoApprovedActions: 0 } },
    } as KpiSnapshot;
    expect(gate(zero, { autoApproved: 5 }).status).not.toBe('warning');
  });

  it('eval/baseline policies count too; a rejection by policy does not (nothing went ahead)', () => {
    const p = simApproved(view);
    const [id, a] = Object.entries(p.approvals).find(([, x]) => x.decision)!;
    const rejected = {
      ...p,
      approvals: { ...p.approvals, [id]: { ...a, decision: { ...a.decision!, decision: 'reject' } } },
    } as RunProjection;
    expect(autoDecidedApprovals(rejected)).toBe(0);
  });

  it('the tile shows ⚠ and the text, the summary counts it, and the tile is amber', () => {
    render(<KpiStrip kpis={k} series={[]} safety={{ autoApproved: 1 }} />);
    const li = screen.getByTestId('kpi-value-safety').querySelector('[data-check="decisionsFirst"]')!;
    expect(li.getAttribute('data-status')).toBe('warning');
    expect(li.textContent).toContain('⚠');
    expect(li.textContent).toContain('Auto-approved — not a human decision');
    expect(li.textContent).not.toContain('✓');
    const safety = tileModels(k, null, { autoApproved: 1 }).find((m) => m.key === 'safety')!;
    expect(safety.display).toContain('1 auto-approved');
    expect(safety.tone).not.toBe('neutral');
  });

  it('the why-drawer lists the checks with the note', () => {
    render(
      <WhyDrawer
        tile="safety"
        kpis={k}
        events={[]}
        safety={{ autoApproved: 1 }}
        onClose={() => {}}
        onJump={() => {}}
      />,
    );
    const item = screen.getByTestId('why-checks').querySelector('[data-check="decisionsFirst"]')!;
    expect(item.getAttribute('data-status')).toBe('warning');
    expect(item.textContent).toContain('Auto-approved — not a human decision');
  });
});

function Harness() {
  const store = useStore(createRunStoreOnce());
  return (
    <>
      <span data-testid="cursor">{String(store.cursorSeq)}</span>
      <span data-testid="view-seq">{store.view.lastSeq}</span>
      <WhyDrawer
        tile="cost"
        kpis={store.head.kpis}
        events={store.log.events}
        onClose={() => {}}
        onJump={(seq) => store.setCursor(seq)}
      />
    </>
  );
}
let singleton: ReturnType<typeof createRunStore> | null = null;
function createRunStoreOnce() {
  if (!singleton) {
    singleton = createRunStore(S01.agent[0]!.runId);
    singleton.getState().append(S01.agent);
  }
  return singleton;
}

describe('WhyDrawer', () => {
  it('shows the formula and inputs, and a seq link moves the scrubber to that event', () => {
    render(<Harness />);
    expect(screen.getByText('delay cost + EU261 exposure + cancellation cost')).toBeInTheDocument();
    expect(screen.getByText('Delay Cost Eur')).toBeInTheDocument();
    expect(screen.getByTestId('cursor')).toHaveTextContent('null');
    const links = screen.getAllByTestId(/^why-seq-/);
    expect(links.length).toBeGreaterThan(0);
    const seq = Number(links[0]!.dataset.testid!.replace('why-seq-', ''));
    fireEvent.click(links[0]!);
    expect(screen.getByTestId('cursor')).toHaveTextContent(String(seq));
    expect(screen.getByTestId('view-seq')).toHaveTextContent(String(seq));
  });
});
