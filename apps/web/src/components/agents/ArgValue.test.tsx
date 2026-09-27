/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ArgsList, argSummary, compactArgs } from './ArgValue';

const CITES = [
  {
    sourceId: 'EU261-art-9',
    title: 'Right to care',
    quote: 'Passengers shall be offered free of charge meals',
    chunkId: 'c1',
    url: 'https://eur-lex.europa.eu/x',
  },
  {
    sourceId: 'MEL-52-30-01',
    title: 'Passenger door actuator',
    quote: 'May be inoperative provided…',
    chunkId: 'c2',
    url: 'https://faa.gov/y',
  },
];

describe('argument rendering (live run 2: no [object Object])', () => {
  it('one-line summaries never print [object Object]', () => {
    const line = compactArgs({ summary: 'ok', citations: CITES, detail: { a: 1, b: { c: 2 } } });
    expect(line).not.toMatch(/object Object/);
    expect(line).toMatch(/citations=2 sources: EU261-art-9, MEL-52-30-01/);
    expect(line).toMatch(/detail=\{a: 1, b: …\}/);
    expect(argSummary(['a', 'b'])).toBe('a; b');
    expect(argSummary('x'.repeat(200), 20)).toHaveLength(20);
  });

  it('citations render as source chips with the quote on hover and on expand', async () => {
    render(<ArgsList args={{ citations: CITES }} />);
    const chips = screen.getAllByRole('button', { name: /EU261-art-9|MEL-52-30-01/ });
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('Right to care');
    expect(chips[0]).toHaveAttribute('title', '“Passengers shall be offered free of charge meals”');
    await userEvent.click(chips[0]!);
    expect(screen.getByText('“Passengers shall be offered free of charge meals”')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/object Object/);
  });

  it('string arrays render as a bullet list; objects as key/value; long strings truncate with expand', async () => {
    const long = `${'Diversion handling at NTE. '.repeat(20)}END`;
    render(
      <ArgsList
        args={{
          openIssues: ['Crew FDP to confirm', 'Medical team ETA'],
          scope: { station: 'NTE', minutes: 30 },
          note: long,
        }}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Crew FDP to confirm', 'Medical team ETA']);
    expect(screen.getByText('station')).toBeInTheDocument();
    expect(screen.getByText('NTE')).toBeInTheDocument();
    expect(screen.queryByText(/END/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByText(/END/)).toBeInTheDocument();
  });
});
