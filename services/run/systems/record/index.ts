/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * record — the incident record (not an airline system): timeline, report drafts for a human reporter
 * (Reg. 376/2014: software only drafts), and evidence packs assembled from the whole state.
 */
import type {
  EvidencePack,
  KpiSnapshot,
  MockSystem,
  ReportDraft,
  SystemState,
  TimelineEntry,
} from '@ica/schema';
import { actorLabel, created, fail, newId, type Result } from '../util';

export function appendTimeline(
  state: SystemState,
  input: { atMinute: number; text: string; source: string },
  rng: () => number,
): Result<TimelineEntry> {
  const id = newId('TLN', state.record.timeline, rng);
  const entry: TimelineEntry = { id, atMinute: input.atMinute, text: input.text, source: input.source };
  return { ok: true, value: entry, mutations: [created('record', 'timeline', id, entry)] };
}

export function addReportDraft(
  state: SystemState,
  input: { kind: ReportDraft['kind']; body: string },
  simMinute: number,
  rng: () => number,
): Result<ReportDraft> {
  if (!input.body.trim()) return fail('empty report body');
  const id = newId(input.kind === 'occurrence' ? 'MOR' : 'DSC', state.record.reports, rng);
  const draft: ReportDraft = {
    id,
    kind: input.kind,
    body: input.body,
    status: 'draft',
    forHumanReporter: true,
    aiDrafted: true,
    createdAtMinute: simMinute,
  };
  return { ok: true, value: draft, mutations: [created('record', 'reports', id, draft)] };
}

/**
 * Assemble an evidence pack: the timeline, every decision with its approver (engineering decisions, swaps,
 * cancellations, crew changes), messages sent, vouchers and rebookings, report drafts, the latest KPI snapshot (computed
 * by the runtime's world engine and passed in) with a state snapshot, and the knowledge chunk ids cited.
 */
export function buildEvidencePack(
  state: SystemState,
  simMinute: number,
  citedChunkIds: string[],
  rng: () => number,
  kpiSnapshot?: KpiSnapshot,
): Result<EvidencePack> {
  const timeline = Object.values(state.record.timeline).sort((a, b) => a.atMinute - b.atMinute);
  const decisions = [
    ...Object.values(state.mne.decisions).map((d) => ({
      kind: 'engineering',
      id: d.id,
      summary: `${d.decision} on ${d.tail}`,
      atMinute: d.atMinute,
      decidedBy: actorLabel(d.decidedBy),
      rationale: d.rationale,
    })),
    ...Object.values(state.occ.swaps).map((s) => ({
      kind: 'swap',
      id: s.id,
      summary: `${s.fromTail} → ${s.toTail} on ${s.flights.join(', ')}`,
      status: s.status,
      decidedBy: actorLabel(s.approvedBy),
    })),
    ...Object.values(state.occ.cancellations).map((c) => ({
      kind: 'cancellation',
      id: c.id,
      summary: `cancel ${c.flight}`,
      status: c.status,
      decidedBy: actorLabel(c.approvedBy),
    })),
    ...Object.values(state.mne.defects)
      .filter((d) => d.status === 'deferred')
      .map((d) => ({
        kind: 'deferral',
        id: d.id,
        summary: `${d.id} deferred under MEL ${d.melItem ?? '?'}`,
        decidedBy: actorLabel(d.deferredBy),
      })),
  ];
  const messages = Object.values(state.pss.messages)
    .filter((m) => m.status === 'sent')
    .map((m) => ({
      id: m.id,
      sentAtMinute: m.sentAtMinute,
      cohortIds: m.cohortIds,
      channel: m.channel,
      body: m.body,
      aiDrafted: true,
      approvedBy:
        m.approvalMethod === 'implicit' && m.approvedBy?.kind === 'human'
          ? `${actorLabel(m.approvedBy)} — no objection within 60 s`
          : actorLabel(m.approvedBy),
    }));
  const reports = Object.values(state.record.reports);
  const kpis = {
    /** The world engine's latest KpiSnapshot (null when none was computed yet, e.g. a pure unit call). */
    snapshot: kpiSnapshot ?? null,
    simMinute,
    flights: Object.values(state.occ.flights).map((f) => ({
      flight: f.flight,
      tail: f.tail,
      status: f.status,
      delayMin: f.delayMin,
      reactionaryDelayMin: f.reactionaryDelayMin,
    })),
    cohorts: Object.values(state.pss.cohorts).map((c) => ({
      id: c.id,
      kind: c.kind,
      count: c.count,
      status: c.status,
      firstInformedAtMinute: c.firstInformedAtMinute ?? null,
      careIssued: c.careIssued,
      rebookedTo: c.rebookedTo ?? null,
    })),
    vouchers: Object.values(state.pss.vouchers),
    aircraft: Object.values(state.mne.aircraft).map((a) => ({
      tail: a.tail,
      status: a.status,
      stand: a.stand,
    })),
  };
  const id = newId('EVP', state.record.evidencePacks, rng);
  const pack: EvidencePack = {
    id,
    createdAtMinute: simMinute,
    contents: {
      timeline,
      decisions,
      messages,
      reports,
      kpis,
      citations: [...new Set(citedChunkIds)].map((chunkId) => ({ chunkId })),
    },
  };
  return { ok: true, value: pack, mutations: [created('record', 'evidencePacks', id, pack)] };
}

/** `record` is persisted like a system but has no seed data and no modelled processes. */
export const record: MockSystem<any> = {
  name: 'record' as never,
  seed: () => ({ timeline: {}, reports: {}, evidencePacks: {} }),
  tick: () => [],
  knownRefs: () => ({}),
};
