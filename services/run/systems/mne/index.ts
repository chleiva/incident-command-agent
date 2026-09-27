/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * mne — maintenance & engineering / tech log (spec §7).
 *
 * Rules enforced here (not only by tool tiers):
 * - Only a human actor whose roleTitle contains "Certifying" may set a defect to `deferred` or an aircraft to
 *   `released`. Any other actor gets an error. Agents can only create and read.
 * - Work-order lifecycle `created → assigned → in_progress → awaiting_certification → closed`: `tick` advances it
 *   once the assigned engineer is `on_site` at the aircraft's station, using `estimatedDurationMin`. Only a
 *   certifying human closes it (via a `rectify`/`release` decision).
 */
import type {
  Actor,
  Aircraft,
  Defect,
  EngineeringDecision,
  MaintenanceRecord,
  MockSystem,
  Scenario,
  SystemMutation,
  SystemState,
  SystemStateOf,
  TechlogEntry,
  WorkOrder,
} from '@ica/schema';
import { UNKNOWN } from '@ica/schema';
import { created, fail, isCertifyingHuman, newId, updated, type Result } from '../util';

const ATA_BY_TRIGGER: Record<string, string> = {
  'ground-damage': '32',
  'bird-strike': '05',
  lightning: '05',
  'system-warning': '52',
  'door-strike': '52',
  'fuel-spill': '28',
  'brake-overheat': '32',
  'hydraulic-leak': '29',
  'apu-inop': '49',
  'slide-deployment': '25',
};

/** MEL item references quoted in evidence, e.g. "MEL 49-10-01". */
export function melRefsFromText(text: string): string[] {
  return [...new Set([...text.matchAll(/\bMEL\s*(?:item\s*)?(\d{2}-\d{2}-\d{2}[A-Z]?)/gi)].map((m) => m[1]))];
}

/** Only the maintenance-record fields the scenario states (a missing field stays missing: shown as Unknown). */
function recordOf(m: MaintenanceRecord | undefined): { maintenance?: MaintenanceRecord } {
  if (!m) return {};
  const out: MaintenanceRecord = {};
  if (m.lastCheckType) out.lastCheckType = m.lastCheckType;
  if (m.lastCheckDate) out.lastCheckDate = m.lastCheckDate;
  if (m.defectHistory) out.defectHistory = [...m.defectHistory];
  return Object.keys(out).length ? { maintenance: out } : {};
}

/**
 * A maintenance record as tools and the context present it: every missing field is "Unknown" (task 06 §1.6),
 * never a default such as passed, OK or serviceable.
 */
export function maintenanceView(ac: Aircraft | undefined): {
  lastCheckType: string;
  lastCheckDate: string;
  defectHistory: string[] | typeof UNKNOWN;
} {
  const m = ac?.maintenance;
  return {
    lastCheckType: m?.lastCheckType ?? UNKNOWN,
    lastCheckDate: m?.lastCheckDate ?? UNKNOWN,
    defectHistory: m?.defectHistory ?? UNKNOWN,
  };
}

/** A defect as tools present it: a missing ATA chapter or MEL reference is "Unknown". */
export function defectView(d: Defect): Omit<Defect, 'ata'> & { ata: string; melItem: string } {
  return { ...d, ata: d.ata ?? UNKNOWN, melItem: d.melItem ?? UNKNOWN };
}

export function seedMne(scenario: Scenario): SystemStateOf<'mne'> {
  const a = scenario.aircraft;
  // The incident aircraft starts unserviceable (the trigger); nothing about its record is assumed.
  const aircraft: Record<string, Aircraft> = {
    [a.tail]: {
      tail: a.tail,
      type: a.type,
      station: a.station,
      status: 'unserviceable',
      stand: a.stand,
      ...recordOf(a.maintenance),
    },
  };
  // Spares are serviceable because OCC's spare list (the scenario) says they are available spares; their
  // maintenance record fields are only what the scenario states (the rest is Unknown).
  for (const s of scenario.world.spares) {
    aircraft[s.tail] ??= {
      tail: s.tail,
      type: s.type,
      station: s.station,
      status: 'serviceable',
      stand: s.stand,
      ...recordOf(s.maintenance),
    };
  }
  const evidence = scenario.trigger.evidence.map((e) => e.text).join('\n');
  const mel = melRefsFromText(evidence);
  const defectId = 'DEF-001';
  const defect: Defect = {
    id: defectId,
    tail: a.tail,
    description: scenario.trigger.description,
    ata: ATA_BY_TRIGGER[scenario.trigger.type],
    status: 'open',
    raisedAtMinute: scenario.trigger.atMinute,
  };
  if (mel[0]) defect.melItem = mel[0];
  return { aircraft, defects: { [defectId]: defect }, workOrders: {}, techlog: {}, decisions: {} };
}

/** Create a work order (agents may do this). */
export function createWorkOrder(
  state: SystemState,
  input: { tail: string; defectId?: string; task: string; estimatedDurationMin: number; engineerId?: string },
  simMinute: number,
  rng: () => number,
): Result<WorkOrder> {
  const ac = state.mne.aircraft[input.tail];
  if (!ac) return fail(`unknown tail ${input.tail}`);
  if (input.defectId) {
    const d = state.mne.defects[input.defectId];
    if (!d) return fail(`unknown defect ${input.defectId}`);
    if (d.tail !== input.tail) return fail(`defect ${input.defectId} is on ${d.tail}, not ${input.tail}`);
  }
  if (input.engineerId && !state.engineers.engineers[input.engineerId])
    return fail(`unknown engineer ${input.engineerId}`);
  const id = newId('WO', state.mne.workOrders, rng);
  const wo: WorkOrder = {
    id,
    tail: input.tail,
    task: input.task,
    status: input.engineerId ? 'assigned' : 'created',
    createdAtMinute: simMinute,
    estimatedDurationMin: input.estimatedDurationMin,
    progressPct: 0,
  };
  if (input.defectId) wo.defectId = input.defectId;
  if (input.engineerId) wo.assignedEngineerId = input.engineerId;
  return { ok: true, value: wo, mutations: [created('mne', 'workOrders', id, wo)] };
}

/** Assign an engineer to a work order (created → assigned). */
export function assignWorkOrder(state: SystemState, woId: string, engineerId: string): Result<WorkOrder> {
  const wo = state.mne.workOrders[woId];
  if (!wo) return fail(`unknown work order ${woId}`);
  if (!state.engineers.engineers[engineerId]) return fail(`unknown engineer ${engineerId}`);
  if (wo.status === 'closed') return fail(`work order ${woId} is closed`);
  const m = updated('mne', 'workOrders', woId, wo, {
    assignedEngineerId: engineerId,
    status: wo.status === 'created' ? 'assigned' : wo.status,
  });
  return { ok: true, value: m.after as WorkOrder, mutations: [m] };
}

/** Set a defect to deferred under an MEL item. Certifying humans only. */
export function deferDefect(
  state: SystemState,
  defectId: string,
  melItem: string,
  actor: Actor,
): Result<Defect> {
  if (!isCertifyingHuman(actor))
    return fail('deferral is reserved to certifying staff (a human whose role title contains "Certifying")');
  const d = state.mne.defects[defectId];
  if (!d) return fail(`unknown defect ${defectId}`);
  if (d.status !== 'open') return fail(`defect ${defectId} is ${d.status}`);
  const m = updated('mne', 'defects', defectId, d, { status: 'deferred', melItem, deferredBy: actor });
  const mutations = [m, ...dispatchabilityMutations(state, d.tail, { [defectId]: 'deferred' })];
  return { ok: true, value: m.after as Defect, mutations };
}

/** Release the aircraft to service. Certifying humans only; every defect must be deferred or rectifiable. */
export function releaseAircraft(state: SystemState, tail: string, actor: Actor): Result<Aircraft> {
  if (!isCertifyingHuman(actor))
    return fail(
      'release to service is reserved to certifying staff (a human whose role title contains "Certifying")',
    );
  const ac = state.mne.aircraft[tail];
  if (!ac) return fail(`unknown tail ${tail}`);
  const mutations: SystemMutation[] = [];
  for (const d of Object.values(state.mne.defects)) {
    if (d.tail !== tail || d.status !== 'open') continue;
    const wo = Object.values(state.mne.workOrders).find(
      (w) => w.defectId === d.id && w.status === 'awaiting_certification',
    );
    if (!wo) return fail(`defect ${d.id} is still open with no work order awaiting certification`);
    mutations.push(updated('mne', 'workOrders', wo.id, wo, { status: 'closed', progressPct: 100 }));
    mutations.push(updated('mne', 'defects', d.id, d, { status: 'rectified' }));
  }
  const m = updated('mne', 'aircraft', tail, ac, { status: 'released' });
  mutations.push(m);
  return { ok: true, value: m.after as Aircraft, mutations };
}

/** Mark the aircraft AOG (any human decision). */
function aogMutation(state: SystemState, tail: string): SystemMutation[] {
  const ac = state.mne.aircraft[tail];
  return ac && ac.status !== 'aog' ? [updated('mne', 'aircraft', tail, ac, { status: 'aog' })] : [];
}

/** If no open defects remain on the tail (given overrides), the aircraft becomes serviceable. */
function dispatchabilityMutations(
  state: SystemState,
  tail: string,
  overrides: Record<string, Defect['status']>,
): SystemMutation[] {
  const ac = state.mne.aircraft[tail];
  if (!ac || ac.status === 'released') return [];
  const open = Object.values(state.mne.defects).some(
    (d) => d.tail === tail && (overrides[d.id] ?? d.status) === 'open',
  );
  if (!open && ac.status !== 'serviceable')
    return [updated('mne', 'aircraft', tail, ac, { status: 'serviceable' })];
  return [];
}

/**
 * Record an engineering decision taken by a human (the approver of the `record_engineering_decision` proposal) and
 * apply its effect. `defer_mel` and `release` need a certifying human; `rectify` and `aog` need any human.
 */
export function recordEngineeringDecision(
  state: SystemState,
  input: { tail: string; decision: EngineeringDecision['decision']; defectId?: string; melItem?: string },
  decidedBy: Actor | undefined,
  rationale: string,
  simMinute: number,
  rng: () => number,
): Result<EngineeringDecision> {
  if (!decidedBy || decidedBy.kind !== 'human')
    return fail('an engineering decision must be taken by a named human (approve the proposal as a person)');
  if (!state.mne.aircraft[input.tail]) return fail(`unknown tail ${input.tail}`);
  const mutations: SystemMutation[] = [];
  if (input.decision === 'defer_mel') {
    const defectId =
      input.defectId ??
      Object.values(state.mne.defects).find((d) => d.tail === input.tail && d.status === 'open')?.id;
    if (!defectId) return fail('no open defect to defer');
    const melItem = input.melItem ?? state.mne.defects[defectId]?.melItem;
    if (!melItem) return fail('defer_mel needs an MEL item');
    const r = deferDefect(state, defectId, melItem, decidedBy);
    if (!r.ok) return r;
    mutations.push(...r.mutations);
  } else if (input.decision === 'release') {
    const r = releaseAircraft(state, input.tail, decidedBy);
    if (!r.ok) return r;
    mutations.push(...r.mutations);
  } else if (input.decision === 'aog') {
    mutations.push(...aogMutation(state, input.tail));
  }
  const id = newId('ED', state.mne.decisions, rng);
  const decision: EngineeringDecision = {
    id,
    tail: input.tail,
    decision: input.decision,
    decidedBy,
    atMinute: simMinute,
    rationale,
  };
  mutations.push(created('mne', 'decisions', id, decision));
  return { ok: true, value: decision, mutations };
}

/** Store a tech-log entry (AI-drafted; approved when a human/policy approved the proposal). */
export function addTechlogEntry(
  state: SystemState,
  tail: string,
  text: string,
  approved: boolean,
  rng: () => number,
): Result<TechlogEntry> {
  if (!state.mne.aircraft[tail]) return fail(`unknown tail ${tail}`);
  const id = newId('TL', state.mne.techlog, rng);
  const entry: TechlogEntry = { id, tail, text, status: approved ? 'approved' : 'draft', aiDrafted: true };
  return { ok: true, value: entry, mutations: [created('mne', 'techlog', id, entry)] };
}

/** Work-order progress: assigned → in_progress (engineer on site) → awaiting_certification (100 %). */
export function tickMne(state: SystemState, simMinute: number, _dtMin: number): SystemMutation[] {
  const out: SystemMutation[] = [];
  for (const wo of Object.values(state.mne.workOrders)) {
    if (wo.status === 'closed' || wo.status === 'awaiting_certification' || !wo.assignedEngineerId) continue;
    const eng = state.engineers.engineers[wo.assignedEngineerId];
    const ac = state.mne.aircraft[wo.tail];
    const onSite = !!eng && !!ac && eng.status === 'on_site' && eng.location === ac.station;
    if (wo.status === 'created' || wo.status === 'assigned') {
      if (onSite)
        out.push(
          updated('mne', 'workOrders', wo.id, wo, { status: 'in_progress', startedAtMinute: simMinute }),
        );
      else if (wo.status === 'created')
        out.push(updated('mne', 'workOrders', wo.id, wo, { status: 'assigned' }));
      continue;
    }
    // in_progress: progress derived from elapsed time; persisted in 10 % steps to keep the event log compact.
    const started = wo.startedAtMinute ?? simMinute;
    const pct =
      wo.estimatedDurationMin > 0
        ? Math.min(100, ((simMinute - started) / wo.estimatedDurationMin) * 100)
        : 100;
    if (pct >= 100)
      out.push(
        updated('mne', 'workOrders', wo.id, wo, { progressPct: 100, status: 'awaiting_certification' }),
      );
    else if (Math.floor(pct / 10) > Math.floor(wo.progressPct / 10))
      out.push(updated('mne', 'workOrders', wo.id, wo, { progressPct: Math.floor(pct / 10) * 10 }));
  }
  return out;
}

export const mne: MockSystem<'mne'> = {
  name: 'mne',
  seed: (scenario) => seedMne(scenario),
  tick: tickMne,
  knownRefs: (state) => ({
    tail: Object.keys(state.mne.aircraft),
    defect: Object.keys(state.mne.defects),
    workOrder: Object.keys(state.mne.workOrders),
  }),
};
