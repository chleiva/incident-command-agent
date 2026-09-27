/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The Agents view UI (task 08): names from roles.json, row types, expanded rows ("Facts gathered by this turn"),
 * time sync with the shared scrubber, Hide thoughts, delegation links, keyboard, virtualisation, the dashboard
 * panel's headline titles and chip tooltips, the nav item and the About dialog.
 */
import { foldEvents, type RunEvent } from '@ica/schema/browser';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { headline, resultData } from '../../agents/headline';
import { ROLES } from '../../agents/roles';
import { columnStatus, deriveAgents, turnCount, type AgentRow, type AgentsModel } from '../../agents/rows';
import { ServicesProvider } from '../../app/services';
import { AppShell } from '../../app/AppShell';
import { agentFeed, activeRoles } from '../../lib/derive';
import { DEFAULT_ABOUT } from '../../lib/brand';
import { createMockServices } from '../../mocks/services';
import { buildAgentsShowcase } from '../../mocks/agentsShowcase';
import { RECORDINGS } from '../../mocks/recordings';
import { createRunStore } from '../../store/runStore';
import { HIDE_THOUGHTS_KEY, useUi } from '../../store/ui';
import { AboutDialog } from '../about/AboutDialog';
import { AgentStream } from '../agents/AgentStream';
import { AgentsBoard, type AgentsBoardProps } from './AgentsBoard';
import { AgentsTimelineBar } from './AgentsTimelineBar';
import { FACTS_HEADING, FACTS_TOOLTIP, REASONING_LABEL } from './RowDetail';

const SHOWCASE = buildAgentsShowcase();

function boardProps(events: RunEvent[], extra: Partial<AgentsBoardProps> = {}): AgentsBoardProps {
  const model = deriveAgents(events);
  const view = foldEvents(events);
  return {
    model,
    statusByRole: Object.fromEntries(model.columns.map((c) => [c.role, columnStatus(view, c.role)])),
    turnsByRole: Object.fromEntries(model.columns.map((c) => [c.role, turnCount(c.rows)])),
    cursorSeq: null,
    hideThoughts: false,
    live: false,
    ...extra,
  };
}

const rowEl = (key: string) => document.querySelector(`[data-row="${key}"]`) as HTMLElement;
const rowButton = (key: string) => rowEl(key).querySelector('[data-row-button]') as HTMLButtonElement;
const firstRow = (model: AgentsModel, pred: (r: AgentRow) => boolean) =>
  model.columns.flatMap((c) => c.rows).find(pred)!;

afterEach(() => {
  useUi.setState({ hideThoughts: false, openRunId: null, aboutOpen: false });
});

describe('<AgentsBoard>', () => {
  it('names columns from roles.json (never OR, GR, FO or RC) with objective, status and turns', () => {
    render(<AgentsBoard {...boardProps(SHOWCASE)} />);
    const headers = [...document.querySelectorAll('[data-column-header]')];
    expect(headers.map((h) => h.querySelector('h2')!.textContent)).toEqual([
      'Orchestrator',
      'Maintenance (MX)',
      'Ground',
      'Flight Operations',
      'Passengers (PX)',
      'Incident Record',
    ]);
    const board = screen.getByTestId('agents-board');
    for (const code of ['OR', 'GR', 'FO', 'RC'])
      expect(board.textContent).not.toMatch(new RegExp(`\\b${code}\\b`));
    const ground = document.querySelector('[data-column-header="ground"]')!;
    expect(ground.textContent).toContain(ROLES.ground.objective);
    expect(ground.querySelector('[data-status]')!.getAttribute('data-status')).toBe('blocked');
    expect(ground.querySelector('[data-turns]')!.textContent).toMatch(/\d+ turns?/);
  });

  it('shows every row type, the author banner, and stop/decision rows of their own', () => {
    render(<AgentsBoard {...boardProps(SHOWCASE)} />);
    const kinds = new Set(
      [...document.querySelectorAll('[data-kind]')].map((e) => e.getAttribute('data-kind')),
    );
    for (const k of [
      'brief',
      'thought',
      'tool',
      'proposal',
      'waiting',
      'decision',
      'blocked',
      'stopped',
      'report',
    ])
      expect(kinds, k).toContain(k);
    expect(screen.getByText('Stopped: reached the 60 tool-call limit for this agent')).toBeInTheDocument();
    expect(screen.getAllByText('Approved by Duty Manager at m6').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-author-line]')!.textContent).toBe(
      'Scenario enriched from your description',
    );
    // The author is a banner, not a column.
    expect(document.querySelector('[data-column="author"]')).toBeNull();
  });

  it('shows the invalidation row (s04)', () => {
    render(<AgentsBoard {...boardProps(RECORDINGS[1]!.agent)} />);
    expect(screen.getByText('Approval withdrawn: engineer ETA changed (m38 → m78)')).toBeInTheDocument();
  });

  it('expands a row in place with "Facts gathered by this turn" and moves the scrubber to its moment', async () => {
    const store = createRunStore('run-demo-agents');
    store.getState().append(SHOWCASE);
    const props = boardProps(SHOWCASE, { onSelectRow: (r) => store.getState().setCursor(r.seq) });
    render(<AgentsBoard {...props} />);
    const row = firstRow(props.model, (r) => r.role === 'maintenance' && r.kind === 'tool' && r.turn === 3);
    await userEvent.click(rowButton(row.key));
    expect(rowButton(row.key)).toHaveAttribute('aria-expanded', 'true');
    const detail = within(rowEl(row.key)).getByRole('region');
    expect(within(detail).getByText(FACTS_HEADING)).toBeInTheDocument();
    expect(detail.textContent).not.toMatch(/What it knew/i);
    expect(within(detail).getByRole('button', { name: FACTS_TOOLTIP })).toBeInTheDocument();
    expect(within(detail).getByText('What it decided')).toBeInTheDocument();
    expect(
      within(detail).getByText(new RegExp(REASONING_LABEL.replace(/[()]/g, '\\$&'))),
    ).toBeInTheDocument();
    // Time sync: the shared store is now in history mode at that row.
    expect(store.getState().cursorSeq).toBe(row.seq);
    // One expanded row per column: opening another collapses the first.
    const other = firstRow(props.model, (r) => r.role === 'maintenance' && r.kind === 'report');
    await userEvent.click(rowButton(other.key));
    expect(rowButton(row.key)).toHaveAttribute('aria-expanded', 'false');
    expect(within(rowEl(other.key)).getByText('Actions taken')).toBeInTheDocument();
  });

  it('shows the model text only when expanded, labelled AI reasoning (unverified)', async () => {
    const props = boardProps(SHOWCASE);
    render(<AgentsBoard {...props} />);
    const thought = firstRow(props.model, (r) => r.kind === 'thought');
    expect(rowEl(thought.key).textContent).not.toContain(thought.thought!.text);
    await userEvent.click(rowButton(thought.key));
    expect(rowEl(thought.key).textContent).toContain(REASONING_LABEL);
    expect(rowEl(thought.key).textContent).toContain(thought.thought!.text);
  });

  it('dims rows after the viewed moment', () => {
    const props = boardProps(SHOWCASE);
    const pivot = firstRow(props.model, (r) => r.kind === 'decision');
    render(<AgentsBoard {...props} cursorSeq={pivot.seq} />);
    const later = props.model.columns.flatMap((c) => c.rows).find((r) => r.seq > pivot.seq)!;
    expect(rowEl(later.key)).toHaveAttribute('data-future', 'true');
    expect(rowEl(pivot.key)).not.toHaveAttribute('data-future');
  });

  it('hides thought rows with Hide thoughts', () => {
    const props = boardProps(SHOWCASE);
    const { rerender } = render(<AgentsBoard {...props} />);
    expect(document.querySelectorAll('[data-kind="thought"]').length).toBeGreaterThan(0);
    rerender(<AgentsBoard {...props} hideThoughts />);
    expect(document.querySelectorAll('[data-kind="thought"]').length).toBe(0);
    expect(document.querySelectorAll('[data-kind="tool"]').length).toBeGreaterThan(0);
  });

  it('follows a delegation link to the brief and back, highlighting the target', async () => {
    const props = boardProps(SHOWCASE);
    render(<AgentsBoard {...props} />);
    const delegate = firstRow(
      props.model,
      (r) => r.call?.tool === 'delegate' && r.link?.role === 'maintenance',
    );
    const out = within(rowEl(delegate.key)).getByRole('button', { name: "Go to Maintenance (MX)'s brief" });
    await userEvent.click(out);
    const brief = props.model.rowByKey.get(delegate.link!.targetKey)!;
    expect(rowEl(brief.key)).toHaveAttribute('data-highlighted', 'true');
    expect(document.activeElement).toBe(rowButton(brief.key));
    await userEvent.click(
      within(rowEl(brief.key)).getByRole('button', { name: 'Go to the Orchestrator delegation' }),
    );
    expect(document.activeElement).toBe(rowButton(delegate.key));
  });

  it('keyboard: arrows move between rows and columns, Enter expands, Escape collapses, [ ] switch columns', async () => {
    const props = boardProps(SHOWCASE);
    render(<AgentsBoard {...props} />);
    const orch = props.model.columns[0]!.rows;
    // A single tab stop: the first row of the first column.
    expect(rowButton(orch[0]!.key)).toHaveAttribute('tabindex', '0');
    expect(rowButton(orch[1]!.key)).toHaveAttribute('tabindex', '-1');
    act(() => rowButton(orch[0]!.key).focus());
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowButton(orch[1]!.key));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rowButton(orch[0]!.key));
    await userEvent.keyboard('{Enter}');
    expect(rowButton(orch[0]!.key)).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(rowButton(orch[0]!.key)).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(rowButton(orch[0]!.key));
    await userEvent.keyboard(']');
    expect(document.activeElement?.closest('[data-column]')?.getAttribute('data-column')).toBe('maintenance');
    await userEvent.keyboard('[[');
    expect(document.activeElement?.closest('[data-column]')?.getAttribute('data-column')).toBe(
      'orchestrator',
    );
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.closest('[data-column]')?.getAttribute('data-column')).toBe('maintenance');
  });

  it('announces new rows in a polite live region per column', () => {
    const cut = SHOWCASE.findIndex((e) => e.type === 'agent.report' && e.payload.role === 'record');
    const before = boardProps(SHOWCASE.slice(0, cut), { live: true });
    const { rerender } = render(<AgentsBoard {...before} />);
    const record = document.querySelector('[data-column="record"]')!;
    const region = record.querySelector('[aria-live="polite"]')!;
    rerender(<AgentsBoard {...boardProps(SHOWCASE.slice(0, cut + 1), { live: true })} />);
    expect(region.textContent).toMatch(/^Incident Record: Finished/);
  });

  it('virtualises long columns', () => {
    // jsdom has no layout: give elements a size.
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    const base = deriveAgents(SHOWCASE);
    const col = base.columns[0]!;
    const rows = Array.from({ length: 500 }, (_, i) => ({
      ...col.rows[i % col.rows.length]!,
      key: `v-${i}`,
      seq: i,
    }));
    const model: AgentsModel = { ...base, columns: [{ ...col, rows }] };
    render(<AgentsBoard {...boardProps(SHOWCASE)} model={model} />);
    const rendered = document.querySelectorAll('[data-column="orchestrator"] [data-row]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    h.mockRestore();
    w.mockRestore();
  });
});

describe('<AgentsTimelineBar>', () => {
  it('shows "Viewing m42 — Back to live" in history, and toggles Hide thoughts', async () => {
    const onLive = vi.fn();
    const onHide = vi.fn();
    const props = {
      maxMinute: 60,
      clock: (m: number) => `07:${String(Math.round(m)).padStart(2, '0')}`,
      playing: false,
      onPlayToggle: () => {},
      onScrub: () => {},
      onLive,
      hideThoughts: false,
      onHideThoughts: onHide,
    };
    const { rerender } = render(<AgentsTimelineBar {...props} cursorMinute={60} live />);
    expect(screen.queryByTestId('back-to-live')).toBeNull();
    rerender(<AgentsTimelineBar {...props} cursorMinute={42} live={false} />);
    const back = screen.getByTestId('back-to-live');
    expect(back).toHaveTextContent('Viewing m42 — Back to live');
    await userEvent.click(back);
    expect(onLive).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('switch', { name: 'Hide thoughts' }));
    expect(onHide).toHaveBeenCalledWith(true);
  });

  it('persists Hide thoughts, and survives blocked storage', () => {
    useUi.getState().setHideThoughts(true);
    expect(window.localStorage.getItem(HIDE_THOUGHTS_KEY)).toBe('on');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => useUi.getState().setHideThoughts(false)).not.toThrow();
    expect(useUi.getState().hideThoughts).toBe(false);
    spy.mockRestore();
  });
});

describe('dashboard Agent activity panel', () => {
  it('card titles use headline()', () => {
    const events = RECORDINGS[0]!.agent;
    const feed = agentFeed(events);
    render(<AgentStream items={feed} roleStates={activeRoles(foldEvents(events))} pageSize={500} />);
    const titles = [...document.querySelectorAll('[data-card-title]')].map((e) => e.textContent);
    const expected = feed
      .filter((i) => i.kind === 'tool')
      .reverse()
      .map((i) =>
        i.kind === 'tool'
          ? headline(
              i.call.tool,
              i.call.args,
              i.result ? resultData(i.result.result, i.result.resultPreview) : undefined,
              {
                minute: i.minute,
                failed: !!(i.result && !i.result.ok && !i.blocked),
              },
            )
          : '',
      );
    expect(titles).toEqual(expected);
    expect(titles).toContain('Paged the duty engineer — ETA 9 min');
  });

  it('code chips carry the full agent name', async () => {
    const events = RECORDINGS[0]!.agent;
    render(<AgentStream items={agentFeed(events)} roleStates={activeRoles(foldEvents(events))} />);
    const chip = document.querySelector('[data-agent-chip="flightops"]') as HTMLElement;
    expect(chip.getAttribute('aria-label')).toMatch(/^Flight Operations agent/);
    await userEvent.hover(chip);
    expect((await screen.findAllByText('Flight Operations')).length).toBeGreaterThan(0);
  });
});

describe('top bar', () => {
  async function shell(path: string) {
    const services = await createMockServices({ showcase: false });
    return render(
      <ServicesProvider services={services}>
        <MemoryRouter initialEntries={[path]}>
          <AppShell>
            <span />
          </AppShell>
        </MemoryRouter>
      </ServicesProvider>,
    );
  }

  it('orders the nav Network · Agents · Training scenarios · Evals; Agents is disabled with no run open', async () => {
    await shell('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav.textContent).toBe('NetworkAgentsTraining scenariosEvals');
    const agents = within(nav).getByText('Agents');
    expect(agents).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('Open an incident first').length).toBeGreaterThan(0);
  });

  it('links Agents to the open run', async () => {
    useUi.getState().setOpenRunId('run-demo-s01');
    await shell('/training');
    const link = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Agents',
    });
    expect(link).toHaveAttribute('href', '/runs/run-demo-s01/agents');
  });

  it('uses the run in the URL', async () => {
    await shell('/runs/run-xyz');
    const link = within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
      name: 'Agents',
    });
    expect(link).toHaveAttribute('href', '/runs/run-xyz/agents');
  });

  it('opens About with the credit, version and sources', async () => {
    await shell('/');
    await userEvent.click(screen.getByTestId('about-button'));
    const dialog = await screen.findByRole('dialog');
    const credit = within(dialog).getByRole('link', { name: DEFAULT_ABOUT.author });
    expect(credit).toHaveAttribute('href', 'https://www.linkedin.com/in/chris-ai/');
    expect(credit).toHaveAttribute('target', '_blank');
    expect(credit).toHaveAttribute('rel', 'noopener noreferrer');
    expect(dialog.textContent).toContain('Designed and developed by Chris Beltran');
    expect(dialog.textContent).toContain('NASA ASRS');
    expect(
      within(dialog).getByRole('link', { name: /github\.com\/chleiva\/incident-command-agent/ }),
    ).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('<AboutDialog>', () => {
  it('uses the brand pack credit when present', () => {
    render(
      <AboutDialog
        open
        onOpenChange={() => {}}
        brand={{ about: { author: 'A. Person', authorUrl: 'https://example.org/a' } }}
        commit="abc1234"
      />,
    );
    expect(screen.getByRole('link', { name: 'A. Person' })).toHaveAttribute('href', 'https://example.org/a');
    expect(document.querySelector('[data-about-version]')!.textContent).toBe('abc1234');
  });
});
