/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The incident types a duty manager can report against a flight, filtered by the flight's phase. Ground types use
 * the ten shipped scenario families as templates; airborne types coordinate the ground-side response only (the
 * commander flies and decides the aircraft).
 */
import type { FlightPhase } from '../state';

export type IncidentCategory = 'ground' | 'airborne';
/** Where the template's story works: at a base (engineers and a spare on site), an outstation, or anywhere. */
export type StationRequirement = 'base' | 'outstation' | 'any';

export interface IncidentType {
  id: string;
  label: string;
  /** One line in plain language. */
  description: string;
  category: IncidentCategory;
  phases: readonly FlightPhase[];
  /** The shipped scenario used as the template. */
  template: string;
  requires: StationRequirement;
  /** False while the type is not built yet ("coming soon"). */
  available: boolean;
}

const PRE_DEPARTURE: FlightPhase[] = ['scheduled', 'boarding'];
const ARRIVED: FlightPhase[] = ['landed', 'at_gate'];

export const GROUND_INCIDENT_TYPES: readonly IncidentType[] = [
  {
    id: 'pushback_tug_contact',
    label: 'Pushback damage',
    description: 'The towbar fails or the tug touches the aircraft during pushback.',
    category: 'ground',
    phases: ['boarding', 'taxi_out'],
    template: 's01-pushback-tug-contact',
    requires: 'base',
    available: true,
  },
  {
    id: 'vehicle_strike',
    label: 'Ground vehicle hits the aircraft',
    description: 'A catering truck or other vehicle strikes a door or the fuselage on stand.',
    category: 'ground',
    phases: [...PRE_DEPARTURE, 'at_gate'],
    template: 's02-catering-truck-door-strike',
    requires: 'outstation',
    available: true,
  },
  {
    id: 'bird_strike_found',
    label: 'Bird strike found after landing',
    description: 'Bird remains or damage found on the walk-round; inspection needed before the next flight.',
    category: 'ground',
    phases: ARRIVED,
    template: 's03-bird-strike-inspection',
    requires: 'any',
    available: true,
  },
  {
    id: 'lightning_strike',
    label: 'Lightning strike',
    description: 'The aircraft was struck by lightning; it needs an inspection by a licensed engineer.',
    category: 'ground',
    phases: ARRIVED,
    template: 's04-lightning-strike-outstation',
    requires: 'outstation',
    available: true,
  },
  {
    id: 'door_warning',
    label: 'Cargo door warning',
    description: 'A cargo door warning shows at the gate and will not clear.',
    category: 'ground',
    phases: PRE_DEPARTURE,
    template: 's05-cargo-door-warning',
    requires: 'base',
    available: true,
  },
  {
    id: 'apu_inop',
    label: 'APU not working',
    description: 'The auxiliary power unit will not start; there may be a pull to defer it quickly.',
    category: 'ground',
    phases: [...PRE_DEPARTURE, 'at_gate'],
    template: 's06-apu-inop-deferral-temptation',
    requires: 'any',
    available: true,
  },
  {
    id: 'slide_deployment',
    label: 'Escape slide deployed',
    description: 'A door slide inflated on stand during boarding or disembarkation.',
    category: 'ground',
    phases: ['boarding', 'at_gate'],
    template: 's07-slide-inadvertent-deployment',
    requires: 'any',
    available: true,
  },
  {
    id: 'hydraulic_leak',
    label: 'Hydraulic leak',
    description: 'A hydraulic leak is spotted on the walk-round before departure.',
    category: 'ground',
    phases: [...PRE_DEPARTURE, 'at_gate'],
    template: 's08-hydraulic-leak-on-stand',
    requires: 'base',
    available: true,
  },
  {
    id: 'fuel_spill',
    label: 'Fuel spill on stand',
    description: 'Fuel spills during refuelling; the fire service attends.',
    category: 'ground',
    phases: [...PRE_DEPARTURE, 'at_gate'],
    template: 's09-fuel-spill-at-stand',
    requires: 'any',
    available: true,
  },
  {
    id: 'brake_overheat',
    label: 'Brake overheat',
    description: 'Hot brakes after landing delay the turnaround; the crew duty margin is at risk.',
    category: 'ground',
    phases: ARRIVED,
    template: 's10-brake-overheat-fdp-squeeze',
    requires: 'outstation',
    available: true,
  },
];

const AIRBORNE: FlightPhase[] = ['airborne', 'approach'];

export const AIRBORNE_INCIDENT_TYPES: readonly IncidentType[] = [
  {
    id: 'air_turnback',
    label: 'Air turnback',
    description:
      'Bird strike or engine vibration on the climb; the commander returns to the departure airport.',
    category: 'airborne',
    phases: ['airborne'],
    template: 's11-air-turnback-bird-strike',
    requires: 'any',
    available: false,
  },
  {
    id: 'diversion_technical',
    label: 'Technical diversion',
    description: 'Smoke or fumes, pressurisation or hydraulics; the commander diverts.',
    category: 'airborne',
    phases: AIRBORNE,
    template: 's12-diversion-smoke-fumes',
    requires: 'any',
    available: false,
  },
  {
    id: 'diversion_medical',
    label: 'Medical diversion',
    description: 'A passenger is seriously ill on board; the commander diverts.',
    category: 'airborne',
    phases: AIRBORNE,
    template: 's13-diversion-medical',
    requires: 'any',
    available: false,
  },
  {
    id: 'engine_shutdown_overweight_landing',
    label: 'Engine shutdown, overweight landing',
    description:
      'An engine is shut down in flight; the commander lands overweight and it needs an inspection.',
    category: 'airborne',
    phases: AIRBORNE,
    template: 's14-engine-shutdown-overweight-landing',
    requires: 'any',
    available: false,
  },
  {
    id: 'unruly_passenger_diversion',
    label: 'Disruptive passenger',
    description: 'A disruptive passenger; the commander diverts and police meet the aircraft.',
    category: 'airborne',
    phases: AIRBORNE,
    template: 's15-diversion-disruptive-passenger',
    requires: 'any',
    available: false,
  },
];

export const INCIDENT_TYPES: readonly IncidentType[] = [...GROUND_INCIDENT_TYPES, ...AIRBORNE_INCIDENT_TYPES];

/** Free-text only: the Scenario Author builds the scenario from the description and the flight context. */
export const OTHER_INCIDENT_TYPE = 'other';

export function incidentTypeById(id: string): IncidentType | undefined {
  return INCIDENT_TYPES.find((t) => t.id === id);
}
