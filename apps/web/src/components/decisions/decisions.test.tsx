/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { S01, S04, pendingApproval } from '../../test/fixtureViews';
import { DecisionCard, urgency } from './DecisionCard';
import { DecisionQueue } from './DecisionQueue';
import { diffArgs } from './DiffEditor';
import { OptionsMatrix, rankOptions } from './OptionsMatrix';

const msg = pendingApproval(S01.agent, 'ap-msg-1');
const options = pendingApproval(S01.agent, 'ap-decision-1');
const engineering = pendingApproval(S01.agent, 'ap-eng-1');

describe('DecisionCard', () => {
  it('shows summary, tier, requesting agent, countdown and the AI-drafted message', () => {
    render(<DecisionCard approval={msg.approval} nowMinute={6} onDecide={() => {}} />);
    expect(screen.getByText(/Send the first delay message/)).toBeInTheDocument();
    expect(screen.getByText('propose')).toBeInTheDocument();
    expect(screen.getByText('Passenger agent')).toBeInTheDocument();
    expect(screen.getByText('9 min left')).toBeInTheDocument();
    expect(screen.getAllByText('AI-drafted').length).toBeGreaterThan(0);
  });

  it('approves with a click and with the A key', async () => {
    const onDecide = vi.fn();
    render(<DecisionCard approval={msg.approval} nowMinute={6} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: 'approve', roleTitle: 'Duty Manager' });
    const card = screen.getByRole('article');
    card.focus();
    fireEvent.keyDown(card, { key: 'a' });
    expect(onDecide).toHaveBeenCalledTimes(2);
  });

  it('rejects only with a reason (R opens the form)', async () => {
    const onDecide = vi.fn();
    render(<DecisionCard approval={msg.approval} nowMinute={6} onDecide={onDecide} />);
    const card = screen.getByRole('article');
    card.focus();
    fireEvent.keyDown(card, { key: 'r' });
    const submit = screen.getByRole('button', { name: 'Reject' });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason for rejecting/), 'Wrong gate');
    await userEvent.click(submit);
    expect(onDecide).toHaveBeenCalledWith({
      decision: 'reject',
      reason: 'Wrong gate',
      roleTitle: 'Duty Manager',
    });
  });

  it('edits the payload through the diff editor (E) and sends editedArgs', async () => {
    const onDecide = vi.fn();
    render(<DecisionCard approval={msg.approval} nowMinute={6} onDecide={onDecide} />);
    const card = screen.getByRole('article');
    card.focus();
    fireEvent.keyDown(card, { key: 'e' });
    const editor = screen.getByLabelText('Edit payload') as HTMLTextAreaElement;
    const edited = { ...msg.approval.args, channel: 'app' };
    fireEvent.change(editor, { target: { value: JSON.stringify(edited) } });
    expect(screen.getByRole('list', { name: 'Changes' })).toHaveTextContent('channel');
    await userEvent.click(screen.getByRole('button', { name: 'Approve with edits' }));
    expect(onDecide).toHaveBeenCalledWith({
      decision: 'edit',
      editedArgs: edited,
      roleTitle: 'Duty Manager',
    });
  });

  it('shows "decided (sending…)" optimistically and the approver once decided', () => {
    const { rerender } = render(
      <DecisionCard
        approval={msg.approval}
        nowMinute={6}
        optimistic={{ decision: 'approve', state: 'sending' }}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Decided (approve) — sending…');
    const decided = {
      ...msg.approval,
      status: 'approved' as const,
      decision: {
        decision: 'approve' as const,
        decidedBy: { kind: 'human' as const, name: 'Sam Okafor', roleTitle: 'Duty Manager' },
        seq: 99,
        atMinute: 6.4,
      },
    };
    rerender(<DecisionCard approval={decided} nowMinute={7} onDecide={() => {}} />);
    expect(screen.getByText('Sam Okafor · Duty Manager')).toBeInTheDocument();
  });

  it('asks for the certifying role on engineering decisions', async () => {
    const onDecide = vi.fn();
    render(<DecisionCard approval={engineering.approval} nowMinute={45} onDecide={onDecide} />);
    expect(
      screen.getByText((_, el) => el?.textContent === 'Reserved for certifying staff.'),
    ).toBeInTheDocument();
    // "Decided by" stays empty until the human decision-capture tool records it.
    expect(screen.getByText('Awaiting certifying staff')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(onDecide).toHaveBeenCalledWith({ decision: 'approve', roleTitle: 'Certifying Engineer (B1)' });
  });

  it('computes urgency from expiry, else from age', () => {
    expect(urgency(msg.approval, 14).tone).toBe('warning');
    expect(urgency(msg.approval, 16).tone).toBe('critical');
    expect(urgency(engineering.approval, 46).text).toMatch(/waiting/);
  });
});

describe('OptionsMatrix', () => {
  it('ranks the recommended option first and selecting a row is the decision', async () => {
    const onDecide = vi.fn();
    render(<DecisionCard approval={options.approval} nowMinute={31} onDecide={onDecide} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveAttribute('data-option', 'opt-swap');
    expect(within(rows[0]!).getByText('Recommended')).toBeInTheDocument();
    // No plain Approve when there are options: choosing a row approves with selectedOptionId.
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Choose: Hold NW-KES for rectification' }));
    expect(onDecide).toHaveBeenCalledWith({
      decision: 'approve',
      selectedOptionId: 'opt-hold',
      roleTitle: 'Duty Manager',
    });
  });

  it('renders the four-option outstation case with metrics per row', () => {
    const s04 = pendingApproval(S04.agent, 'ap4-decision-1');
    const onSelect = vi.fn();
    render(<OptionsMatrix options={s04.approval.options!} onSelect={onSelect} />);
    expect(screen.getAllByRole('row')).toHaveLength(5);
    expect(rankOptions(s04.approval.options!)[0]!.id).toBe('opt-contract');
    fireEvent.click(screen.getByRole('button', { name: 'Choose: Contract local B1 engineer at FAO' }));
    expect(onSelect).toHaveBeenCalledWith('opt-contract');
  });
});

describe('DecisionQueue', () => {
  it('orders pending decisions by urgency and shows an empty state', () => {
    const { rerender } = render(
      <DecisionQueue pending={[]} decided={[]} nowMinute={0} onDecide={() => {}} />,
    );
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
    rerender(<DecisionQueue pending={[msg.approval]} decided={[]} nowMinute={6} onDecide={() => {}} />);
    expect(screen.getByRole('list', { name: /most urgent first/ })).toBeInTheDocument();
  });
});

describe('diffArgs', () => {
  it('flags removed keys and type changes', () => {
    const d = diffArgs({ a: 1, b: 'x', c: [1] }, { a: '1', c: [1], d: true });
    expect(d.find((l) => l.key === 'a')).toMatchObject({ kind: 'changed', typeChanged: true });
    expect(d.find((l) => l.key === 'b')).toMatchObject({ kind: 'removed' });
    expect(d.find((l) => l.key === 'c')).toMatchObject({ kind: 'same' });
    expect(d.find((l) => l.key === 'd')).toMatchObject({ kind: 'added' });
  });
});
