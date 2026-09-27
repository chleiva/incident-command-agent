/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Audit logs (web): filters, row expand, exact Raw JSON, tool input/output, keyboard, export, mock routes. */
import type { AuditLlmEntry, AuditToolEntry } from '@ica/schema/browser';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  NO_FILTERS,
  exportAuditJsonl,
  filterEntries,
  llmSummary,
  loadAudit,
  loadLlmTrace,
} from '../../audit/audit';
import { createApiClient } from '../../lib/api';
import { MOCK_API_URL, MockBackend } from '../../mocks/mockBackend';
import { AUDIT_NOTE, AuditView } from './AuditView';
import { AUDIT_RUN, FIRST_LLM, FIRST_TOOL, PROPOSED_TOOL, fixtureLoadTrace, fixtureTrace } from './storyData';

const llm = FIRST_LLM as AuditLlmEntry;
const tool = FIRST_TOOL as AuditToolEntry;

function view(extra: Partial<Parameters<typeof AuditView>[0]> = {}) {
  const loadTrace = vi.fn(fixtureLoadTrace);
  render(<AuditView run={AUDIT_RUN} status="ready" loadTrace={loadTrace} virtualize={false} {...extra} />);
  return { loadTrace };
}
const row = (id: string) => document.querySelector(`[data-audit-row="${CSS.escape(id)}"]`) as HTMLElement;
const toggle = (id: string) => row(id).querySelector('[data-audit-toggle]') as HTMLButtonElement;

describe('audit data', () => {
  it('has LLM and tool entries in sequence order, with usage and joins', () => {
    const seqs = AUDIT_RUN.entries.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(llm.usage?.inputTokens).toBeGreaterThan(0);
    expect(llmSummary(llm)).toMatch(/claude-sonnet-5 · .* in \/ .* out \/ .* cache · .* · \$/);
    expect((PROPOSED_TOOL as AuditToolEntry).decision?.decidedBy.kind).toBe('human');
  });

  it('filters by agent, kind and text across tool names, args and results', () => {
    const e = AUDIT_RUN.entries;
    expect(filterEntries(e, { ...NO_FILTERS, kind: 'llm' }).every((x) => x.kind === 'llm')).toBe(true);
    expect(
      filterEntries(e, { ...NO_FILTERS, role: 'maintenance' }).every((x) => x.role === 'maintenance'),
    ).toBe(true);
    const byTool = filterEntries(e, { ...NO_FILTERS, query: 'PAGE_ENGINEER' });
    expect(byTool.length).toBeGreaterThan(0);
    expect(byTool.every((x) => x.kind === 'tool' && x.tool === 'page_engineer')).toBe(true);
    // A value that only appears inside a result.
    expect(filterEntries(e, { ...NO_FILTERS, query: 'inc-s01-1' }).map((x) => x.id)).toContain('tool:tc-1');
  });
});

describe('<AuditView>', () => {
  it('shows the transparency note, the run name and every row', () => {
    view();
    expect(screen.getByTestId('audit-note')).toHaveTextContent(AUDIT_NOTE);
    expect(screen.getByTestId('audit-run-header')).toHaveTextContent(AUDIT_RUN.runName);
    expect(screen.getAllByRole('row')).toHaveLength(AUDIT_RUN.entries.length + 1);
    expect(row(llm.id)).toHaveTextContent('LLM call');
    expect(row(llm.id)).toHaveTextContent('Orchestrator');
    expect(row(llm.id)).toHaveTextContent(`T${llm.iteration! + 1}`);
  });

  it('filters with the agent, kind and search controls', async () => {
    view();
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'tool');
    expect(document.querySelectorAll('[data-kind="llm"]')).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('Search tool names, arguments and results'), 'page_engineer');
    const rows = document.querySelectorAll('[data-audit-row]');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => expect(r).toHaveTextContent('page_engineer'));
    await userEvent.selectOptions(screen.getByLabelText('Agent'), 'passenger');
    expect(screen.getByText('No entries match these filters.')).toBeInTheDocument();
  });

  it('expands an LLM call: readable context, then the exact stored request and response as Raw JSON', async () => {
    const { loadTrace } = view();
    await userEvent.click(toggle(llm.id));
    expect(loadTrace).toHaveBeenCalledWith(llm.traceKey);
    const detail = await within(row(llm.id)).findByTestId('llm-trace');
    const context = within(detail).getByRole('region', { name: 'Context sent to the model' });
    expect(context).toHaveTextContent('System prompt');
    expect(context).toHaveTextContent('Tool definitions');
    expect(context).toHaveTextContent('<scenario_data>');
    const output = within(detail).getByRole('region', { name: 'Model output' });
    expect(output).toHaveTextContent('AI-generated');
    expect(output).toHaveTextContent('Stop reason');

    const trace = fixtureTrace(llm.traceKey) as { request: unknown; response: unknown };
    await userEvent.click(within(context).getByRole('tab', { name: 'Raw JSON' }));
    const rawReq = within(context).getByTestId('raw-request').querySelector('[data-json-text]')!;
    expect(rawReq.textContent).toBe(JSON.stringify(trace.request, null, 2));
    await userEvent.click(within(output).getByRole('tab', { name: 'Raw JSON' }));
    const rawRes = within(output).getByTestId('raw-response').querySelector('[data-json-text]')!;
    expect(rawRes.textContent).toBe(JSON.stringify(trace.response, null, 2));
    expect(rawRes.textContent).toContain('"stop_reason"');
  });

  it('expands a tool call: raw input and full output, plus the decision note', async () => {
    view();
    await userEvent.click(toggle(tool.id));
    const detail = within(row(tool.id)).getByTestId('tool-detail');
    const input = within(detail).getByTestId('tool-input').querySelector('[data-json-text]')!;
    expect(input.textContent).toBe(JSON.stringify(tool.args, null, 2));
    const output = within(detail).getByTestId('tool-output').querySelector('[data-json-text]')!;
    expect(output.textContent).toBe(JSON.stringify(tool.result, null, 2));

    const proposed = PROPOSED_TOOL as AuditToolEntry;
    await userEvent.click(toggle(proposed.id));
    expect(within(row(proposed.id)).getByTestId('tool-detail')).toHaveTextContent(
      /Decision: (approve|reject|edit) by/,
    );
  });

  it('moves between rows with the keyboard and returns focus on Escape', async () => {
    view();
    const ids = AUDIT_RUN.entries.map((e) => e.id);
    toggle(ids[0]!).focus();
    fireEvent.keyDown(toggle(ids[0]!), { key: 'ArrowDown' });
    await waitFor(() => expect(toggle(ids[1]!)).toHaveFocus());
    fireEvent.keyDown(toggle(ids[1]!), { key: 'End' });
    await waitFor(() => expect(toggle(ids.at(-1)!)).toHaveFocus());
    fireEvent.keyDown(toggle(ids.at(-1)!), { key: 'Home' });
    await waitFor(() => expect(toggle(ids[0]!)).toHaveFocus());

    await userEvent.click(toggle(tool.id));
    expect(toggle(tool.id)).toHaveAttribute('aria-expanded', 'true');
    const input = within(row(tool.id)).getByRole('region', { name: 'Tool input JSON' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(toggle(tool.id)).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(toggle(tool.id)).toHaveFocus());
  });

  it('renders the empty, loading and error states', () => {
    const { unmount } = render(
      <AuditView run={{ ...AUDIT_RUN, entries: [] }} status="ready" loadTrace={fixtureLoadTrace} />,
    );
    expect(screen.getByText('No model or tool calls were recorded for this run.')).toBeInTheDocument();
    unmount();
    render(<AuditView run={null} status="error" error="boom" loadTrace={fixtureLoadTrace} />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});

describe('export and loading', () => {
  it('exports every entry as JSON lines with the full LLM traces and reports progress', async () => {
    const progress: number[] = [];
    const text = await exportAuditJsonl(
      AUDIT_RUN,
      async (key) => fixtureTrace(key),
      (done) => progress.push(done),
    );
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: 'run', runId: AUDIT_RUN.runId, runName: AUDIT_RUN.runName });
    expect(lines).toHaveLength(AUDIT_RUN.entries.length + 1);
    expect(lines.slice(1).map((l) => l.id)).toEqual(AUDIT_RUN.entries.map((e) => e.id));
    const firstLlm = lines.find((l) => l.kind === 'llm')!;
    expect(firstLlm.trace).toEqual(fixtureTrace(llm.traceKey));
    expect(progress.at(-1)).toBe(AUDIT_RUN.entries.length);
  });

  it('exports a trace error instead of failing the whole file', async () => {
    const text = await exportAuditJsonl({ ...AUDIT_RUN, entries: [llm] }, async () => {
      throw new Error('gone');
    });
    expect(JSON.parse(text.trim().split('\n')[1]!)).toMatchObject({ id: llm.id, traceError: 'gone' });
  });

  it('follows the presigned URL for a large trace', async () => {
    const api = {
      getRunAuditLlm: async () => ({ key: 'k', sizeBytes: 9e6, url: 'https://bucket.example/k?sig' }),
    };
    const fetchUrl = vi.fn(async () => new Response(JSON.stringify({ request: { big: true } })));
    const t = await loadLlmTrace(api, 'r1', 'k', fetchUrl);
    expect(fetchUrl).toHaveBeenCalledWith('https://bucket.example/k?sig');
    expect(t).toEqual({ key: 'k', sizeBytes: 9e6, trace: { request: { big: true } } });
  });

  it('serves the audit and fixture traces from the mock backend', async () => {
    const backend = new MockBackend({ showcase: false });
    const api = createApiClient({ baseUrl: MOCK_API_URL, transport: backend.transport() });
    const run = await loadAudit(api, 'run-demo-s01');
    expect(run.entries.length).toBe(AUDIT_RUN.entries.length);
    expect(run.runName).toContain('ACX');
    const first = run.entries.find((e) => e.kind === 'llm') as AuditLlmEntry;
    const t = await loadLlmTrace(api, 'run-demo-s01', first.traceKey);
    expect((t.trace as { kind: string }).kind).toBe('llm');
    await expect(api.getRunAuditLlm('run-demo-s01', 'traces/other/x.json')).rejects.toMatchObject({
      status: 400,
    });
    await act(async () => {});
  });
});
