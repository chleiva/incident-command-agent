/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAIN_LANGUAGE_KEY, useUi } from '../store/ui';
import data from './glossary.json';
import { GLOSSARY, lookup, segmentText } from './glossary';
import { GlossaryText, Term } from './Term';

const REQUIRED: Record<string, string> = {
  MEL: 'the list of items an aircraft may fly with unserviceable, and under what conditions',
  Deferral: 'recording a defect as acceptable to fly with for a limited time, under the MEL',
  AOG: 'aircraft on ground: not flyable until fixed',
  'Tow-bar / pushback':
    'the bar connecting the tug to the nose wheel when the aircraft is pushed back from the stand',
  'Stand / gate': 'the parking position; a gate has a bridge or door to the terminal',
  Rotation: 'the sequence of flights one aircraft is scheduled to fly today',
  Sector: 'one flight from departure to arrival',
  'Reactionary / knock-on delay': 'delay to later flights caused by this one',
  'FDP / duty margin': 'the legal working hours remaining for the crew',
  "Commander's discretion": "the captain's limited power to extend crew hours in specific circumstances",
  'OCC / ICC': "the airline's operations control centre",
  MCC: 'maintenance control, the engineers who decide technical questions',
  'Certifying staff': 'licensed engineers who may release an aircraft to fly',
  'Occurrence report (MOR)': 'the mandatory safety report filed after an incident',
  'EU261 / UK261': 'the passenger-compensation rules for delays and cancellations',
  PRM: 'passengers needing assistance',
  'Ground handler': 'the contractor providing stairs, buses, loading and pushback',
  // Task 07: airborne incidents and the live network.
  Diversion:
    'landing at an airport other than the planned destination; the commander decides whether and where',
  'Air turnback': 'returning to the departure airport after take-off, decided by the commander',
  'PAN / MAYDAY':
    'radio calls the crew make: PAN means urgency, MAYDAY means distress (grave and imminent danger)',
  'Overweight landing':
    'landing above the maximum landing weight; allowed when the commander judges it necessary, followed by an engineering inspection',
  ETOPS:
    'rules for twin-engine aircraft flying far from diversion airports (not relevant to this short-haul network)',
  'RFFS category': 'the airport rescue and fire-fighting cover level, on a scale of 1 to 10',
  Squawk: 'the four-digit transponder code; special codes signal an emergency or a radio failure',
  'ETA / STA / STD': 'estimated time of arrival / scheduled time of arrival / scheduled time of departure',
};

const setPlain = (on: boolean) => act(() => useUi.getState().setPlainLanguage(on));

describe('glossary data', () => {
  it('has exactly the brief’s terms and definitions, each with an inline phrase and aliases', () => {
    expect(Object.keys(data).sort()).toEqual(Object.keys(REQUIRED).sort());
    for (const [term, definition] of Object.entries(REQUIRED)) {
      expect(GLOSSARY[term]!.definition, term).toBe(definition);
      expect(GLOSSARY[term]!.inline.length, term).toBeGreaterThan(2);
      expect(GLOSSARY[term]!.aliases.length, term).toBeGreaterThan(0);
    }
    expect(GLOSSARY.Deferral!.inline).toBe('fly with the defect for a limited time');
  });

  it('looks terms up by key or alias, case-insensitively', () => {
    expect(lookup('occ')?.term).toBe('OCC / ICC');
    expect(lookup('Certifying engineer')?.term).toBe('Certifying staff');
    expect(lookup('knock-on delay')?.term).toBe('Reactionary / knock-on delay');
    expect(lookup('nothing')).toBeUndefined();
  });

  it('wraps whole words only, case-insensitively, first occurrence per block', () => {
    const segs = segmentText('The MEL item and the mel again; OCC confirms. Remelting is not MEL.');
    const matches = segs.filter((s) => typeof s !== 'string') as { text: string; entry: { term: string } }[];
    expect(matches.map((m) => [m.text, m.entry.term])).toEqual([
      ['MEL', 'MEL'],
      ['OCC', 'OCC / ICC'],
    ]);
    expect(segs.map((s) => (typeof s === 'string' ? s : s.text)).join('')).toBe(
      'The MEL item and the mel again; OCC confirms. Remelting is not MEL.',
    );
    // Longest alias wins; a tool name is not a word match.
    const long = segmentText('Reactionary delay grows; notify_handler was called.');
    expect((long[0] as { text: string }).text).toBe('Reactionary delay');
    expect(long.some((s) => typeof s !== 'string' && s.entry.term === 'Ground handler')).toBe(false);
  });
});

describe('<Term> and <GlossaryText>', () => {
  beforeEach(() => setPlain(false));
  afterEach(() => setPlain(false));

  it('renders the term, keyboard-focusable, and shows the definition on focus', async () => {
    render(<Term term="MEL" />);
    const el = screen.getByText('MEL');
    expect(el).toHaveAttribute('tabindex', '0');
    act(() => el.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(REQUIRED.MEL!);
  });

  it('opens on hover after the 300 ms delay', async () => {
    vi.useFakeTimers();
    try {
      render(<Term term="AOG" />);
      const el = screen.getByText('AOG');
      fireEvent.pointerMove(el, { pointerType: 'mouse' });
      act(() => vi.advanceTimersByTime(250));
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => vi.advanceTimersByTime(100));
      expect(screen.getByRole('tooltip')).toHaveTextContent(REQUIRED.AOG!);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plain language replaces the term with its inline phrase; the tooltip still names the original', async () => {
    setPlain(true);
    render(
      <p>
        <Term term="Deferral">deferral</Term>
      </p>,
    );
    expect(screen.queryByText('deferral')).toBeNull();
    const el = screen.getByText('fly with the defect for a limited time');
    act(() => el.focus());
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('deferral');
    expect(tip).toHaveTextContent(REQUIRED.Deferral!);
  });

  it('GlossaryText wraps free text and follows the toggle live', () => {
    render(<GlossaryText text="Waiting for OCC; the FDP margin is tight." />);
    expect(screen.getByText('OCC')).toHaveAttribute('data-term', 'OCC / ICC');
    expect(screen.getByText('FDP')).toHaveAttribute('data-term', 'FDP / duty margin');
    setPlain(true);
    expect(screen.getByText('operations control')).toHaveAttribute('data-plain', 'on');
    expect(screen.getByText('crew working hours left')).toBeInTheDocument();
    expect(screen.queryByText('OCC')).toBeNull();
    setPlain(false);
    expect(screen.getByText('OCC')).toBeInTheDocument();
  });

  it('non-focusable terms (inside another control) are not tab stops', () => {
    render(<Term term="PRM" focusable={false} />);
    expect(screen.getByText('PRM')).not.toHaveAttribute('tabindex');
  });

  it('unknown terms render as plain text', () => {
    render(<Term term="Nothing here" />);
    expect(screen.getByText('Nothing here').tagName).not.toBe('SPAN');
  });
});

describe('plain-language toggle persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setPlain(false);
  });

  it('persists to localStorage', () => {
    setPlain(true);
    expect(window.localStorage.getItem(PLAIN_LANGUAGE_KEY)).toBe('on');
    act(() => useUi.getState().togglePlainLanguage());
    expect(useUi.getState().plainLanguage).toBe(false);
    expect(window.localStorage.getItem(PLAIN_LANGUAGE_KEY)).toBe('off');
  });

  it('keeps working when storage throws (private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => setPlain(true)).not.toThrow();
    expect(useUi.getState().plainLanguage).toBe(true);
  });
});
