/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { flightStateAt, flightTimes, generateDaySchedule, isAirborne } from '@ica/network';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FlightList, filterFlights } from './FlightList';
import { FlightPanel } from './FlightPanel';

const schedule = generateDaySchedule('accent-air', '2026-09-27');
const noon = Date.parse('2026-09-27T12:00:00Z');

describe('filterFlights', () => {
  it('filters by phase, base and search text', () => {
    const all = filterFlights(schedule, noon, '', 'all', 'MAN');
    expect(all).toHaveLength(schedule.flights.length);
    const air = filterFlights(schedule, noon, '', 'airborne', 'MAN');
    expect(air.length).toBeGreaterThan(0);
    expect(air.every((r) => isAirborne(r.phase))).toBe(true);
    const ground = filterFlights(schedule, noon, '', 'ground', 'MAN');
    expect(ground.every((r) => !isAirborne(r.phase) && r.phase !== 'cancelled')).toBe(true);
    const base = filterFlights(schedule, noon, '', 'base', 'LGW');
    expect(base.every((r) => r.flight.from === 'LGW' || r.flight.to === 'LGW')).toBe(true);
    const f = schedule.flights[3]!;
    expect(
      filterFlights(schedule, noon, f.flight.toLowerCase(), 'all', 'MAN').map((r) => r.flight.flight),
    ).toEqual([f.flight]);
  });
});

describe('<FlightList>', () => {
  it('moves with the arrow keys and selects with Enter; "/" focuses the search', () => {
    const onSelect = vi.fn();
    render(<FlightList schedule={schedule} t={noon} onSelect={onSelect} />);
    const list = screen.getByRole('listbox', { name: 'Flights' });
    const options = within(list).getAllByRole('option');
    expect(options.length).toBe(schedule.flights.length);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(options[2]!.getAttribute('data-flight'));
    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByRole('searchbox', { name: /Search flights/ })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Airborne' }));
    expect(within(list).getAllByRole('option').length).toBeLessThan(options.length);
  });
});

describe('<FlightPanel>', () => {
  it('shows an airborne flight with options-only diversion airports and the report action', () => {
    const f = schedule.flights.find((x) => isAirborne(flightStateAt(x, noon).phase))!;
    const onReport = vi.fn();
    render(<FlightPanel schedule={schedule} flight={f} t={noon} onClose={() => {}} onReport={onReport} />);
    expect(screen.getByRole('complementary', { name: `Flight ${f.flight}` })).toBeInTheDocument();
    expect(screen.getByTestId('options-only-note')).toHaveTextContent(/commander decides/);
    fireEvent.click(screen.getByRole('button', { name: 'Report incident' }));
    expect(onReport).toHaveBeenCalled();
  });

  it('shows a ground flight without the diversion options', () => {
    const f = schedule.flights.find((x) => !x.cancelled)!;
    render(
      <FlightPanel
        schedule={schedule}
        flight={f}
        t={flightTimes(f).offBlockMs - 20 * 60_000}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('options-only-note')).toBeNull();
    expect(screen.getByText('Boarding')).toBeInTheDocument();
  });
});
