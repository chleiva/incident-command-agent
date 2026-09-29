/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Mock-mode "Scenario Author" for "Something else" (no LLM): a canned network-wide airspace-closure patch over the
 * day's network slice, merged with the same code the Run Lambda uses (`applyAuthoredPatch`). It exists so the
 * report → preparing → "Scenario from your description" path can be exercised end to end without a back end; it does
 * not read the description beyond the region keywords the network slice already uses.
 */
import type { NetworkSlice } from '@ica/network/templates';
import type { Scenario, ScenarioPatch } from '@ica/schema/browser';

export function cannedClosurePatch(base: Scenario, slice: NetworkSlice): ScenarioPatch {
  const own = base.airborne?.flight ?? base.aircraft.nextSectors[0]?.flight;
  const others = slice.flights.filter((f) => f.tail !== base.aircraft.tail && f.flight !== own);
  const air = others.filter((f) => f.position && f.to !== 'CDG').slice(0, 2);
  const ground = others.filter((f) => !f.position).slice(0, 5);
  const region = slice.region?.countries.includes('GB') || !slice.region ? 'UK' : slice.region.label;
  return {
    title: `${region} airspace closed: ${own ?? base.aircraft.tail} and ${air.length + ground.length} more flights`,
    replaceNarrative: `Volcanic ash covers much of European airspace and the ${region} has closed its airspace. Accent Air ${own ?? base.aircraft.tail} is affected; departures are held or cancelled and flights in the air bound for closed airports must divert, each at its commander's decision.`,
    replaceTrigger: {
      type: 'airspace-closure',
      scope: 'network',
      description: `${region} airspace closed: a volcanic ash cloud over the ${region} and much of Europe.`,
      evidence: [
        {
          kind: 'report',
          text: `Network manager: ${region} airspace closed to IFR traffic until further notice.`,
        },
      ],
    },
    ...(base.airborne
      ? {
          commanderDecision: {
            atMinute: 3,
            decision: 'turnback' as const,
            note: 'Airspace closed ahead; returning to the departure airport.',
          },
        }
      : {}),
    network: {
      flights: [
        ...ground.map((f, i) =>
          i % 2
            ? { flight: f.flight, effect: 'cancel' as const }
            : { flight: f.flight, effect: 'hold' as const, minutes: 180 },
        ),
        ...air.map((f) => ({ flight: f.flight, effect: 'divert' as const, divertTo: 'CDG', atMinute: 6 })),
      ],
    },
  };
}
