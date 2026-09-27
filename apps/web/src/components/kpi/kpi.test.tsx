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
import { tileModels } from './kpiModel';
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
