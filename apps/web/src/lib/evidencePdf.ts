/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The PDF evidence pack, rendered client-side with pdf-lib (lazy-loaded): the record's EvidencePack plus the
 * decisions with approvers, messages, report drafts, KPI snapshot and citations. Every AI-drafted section is
 * labelled. Standard fonts only (WinAnsi), so text is sanitised.
 */
import type {
  Citation,
  EvidencePack,
  KpiSnapshot,
  PassengerMessage,
  ReportDraft,
  RunEvent,
  RunProjection,
  TimelineEntry,
} from '@ica/schema/browser';
import { PROVISIONAL_READING_LABEL } from '@ica/schema/browser';
import { simulatedLabel } from './brand';
import { actorLabel, formatDuration, formatEur, humaniseTool, simClockAt } from './format';

export interface EvidenceInput {
  carrierName: string;
  disclaimer: string;
  scenarioTitle: string;
  runId: string;
  projection: RunProjection;
  events: readonly RunEvent[];
  baselineKpis?: KpiSnapshot | null;
  evidencePack?: EvidencePack | null;
  generatedAt?: Date;
}

const REPLACE: [RegExp, string][] = [
  [/[→⟶]/g, '->'],
  [/≤/g, '<='],
  [/≥/g, '>='],
  [/×/g, 'x'],
  [/−/g, '-'],
  [/±/g, '+/-'],
  [/[✓✔]/g, 'ok'],
  [/«|»/g, '"'],
];
// WinAnsi (CP1252) printable repertoire.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

export function sanitise(text: string): string {
  let s = text;
  for (const [re, to] of REPLACE) s = s.replace(re, to);
  return [...s]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (ch === '\n') return ' ';
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      return '?';
    })
    .join('');
}

export interface Section {
  heading: string;
  aiDrafted?: boolean;
  lines: string[];
}

/** Pure: the document's sections (unit-tested; also used for the JSON view). */
export function evidenceSections(input: EvidenceInput): Section[] {
  const p = input.projection;
  const clock = (m: number) =>
    `${simClockAt(p.simTime ? new Date(Date.parse(p.simTime) - p.simMinute * 60_000).toISOString() : null, m)}Z`;
  const k = p.kpis;
  const b = input.baselineKpis;
  const sections: Section[] = [];

  if (k) {
    const vs = (a: number, bb: number | undefined, f: (n: number) => string) =>
      bb === undefined ? f(a) : `${f(a)} (illustrative manual workflow ${f(bb)})`;
    sections.push({
      heading: 'Headline indicators',
      lines: [
        `Total disruption cost (estimate): ${vs(k.totalCostEur.value, b?.totalCostEur.value, formatEur)}`,
        `Passenger satisfaction (estimate): ${vs(k.satisfaction.value, b?.satisfaction.value, (n) => `${Math.round(n)}/100`)}`,
        `Margin to the 3-hour threshold: ${vs(k.minutesTo3h, b?.minutesTo3h, formatDuration)}`,
        `First passenger message: ${k.latency.value.firstPaxMessageMin === null ? 'none' : `minute ${k.latency.value.firstPaxMessageMin.toFixed(1)}`}`,
        `Forbidden actions attempted and blocked: ${k.safety.value.forbiddenAttempts}; human decisions recorded: ${k.safety.value.humanDecisionsBeforeDependentActions}`,
        `Compliance: ${Object.entries(k.compliance.value)
          .map(([key, v]) => `${key} ${v === null ? 'n/a' : v ? 'met' : 'NOT met'}`)
          .join('; ')}`,
      ],
    });
  }

  const decided = Object.values(p.approvals).filter((a) => a.decision);
  sections.push({
    heading: 'Decisions (tier: propose; every one taken by a named human)',
    lines: decided.length
      ? decided.map((a) => {
          const d = a.decision!;
          const option = d.selectedOptionId
            ? a.options?.find((o) => o.id === d.selectedOptionId)?.label
            : undefined;
          return `${clock(d.atMinute)} ${humaniseTool(a.tool)}: ${d.decision.toUpperCase()}${option ? ` — ${option}` : ''} — ${a.summary} — by ${actorLabel(d.decidedBy)}${d.reason ? ` (reason: ${d.reason})` : ''}`;
        })
      : ['No decisions recorded.'],
  });

  if (p.guardrailBlocks.length) {
    sections.push({
      heading: 'Blocked actions (guardrails)',
      lines: p.guardrailBlocks.map(
        (g) =>
          `${clock(g.simMinute)} ${g.tool ?? g.layer}: ${g.reason}${g.authority ? ` — who decides: ${g.authority}` : ''}${g.presenterTriggered ? ' (presenter-triggered demonstration)' : ''}`,
      ),
    });
  }

  // A model's reading of the defect is never a status; the decision is the recorded human one.
  const readings = Object.values(p.agents)
    .filter((a) => a.role === 'maintenance' && a.report?.provisionalReading)
    .map((a) => `${PROVISIONAL_READING_LABEL}: ${a.report!.provisionalReading!.text}`);
  const engineering = Object.values(p.systems.mne.decisions).map(
    (d) => `${clock(d.atMinute)} ${d.tail}: ${d.decision} — decided by ${actorLabel(d.decidedBy)}`,
  );
  sections.push({
    heading: 'Airworthiness',
    lines: [...readings, ...(engineering.length ? engineering : ['Decided by: awaiting certifying staff'])],
  });

  const messages = Object.values(p.systems.pss.messages) as PassengerMessage[];
  sections.push({
    heading: 'Passenger messages',
    aiDrafted: true,
    lines: messages.length
      ? messages.map(
          (m) =>
            `${m.sentAtMinute !== undefined ? clock(m.sentAtMinute) : '--:--'} [${m.status}] ${m.channel.toUpperCase()} to ${m.cohortIds.join(', ')}: "${m.body}"${m.approvedBy ? ` — approved by ${actorLabel(m.approvedBy)}` : ''}`,
        )
      : ['No messages.'],
  });

  const reports = [
    ...(Object.values(p.systems.record.reports) as ReportDraft[]).map(
      (r) => `${r.kind} report (draft for a named human reporter): ${r.body}`,
    ),
    ...Object.values(p.systems.handler.reports).map((r) => `Handler report (${r.status}): ${r.text}`),
    ...Object.values(p.systems.mne.techlog).map((t) => `Techlog entry (${t.status}): ${t.text}`),
  ];
  if (reports.length) sections.push({ heading: 'Report drafts', aiDrafted: true, lines: reports });

  const timeline = (Object.values(p.systems.record.timeline) as TimelineEntry[]).sort(
    (x, y) => x.atMinute - y.atMinute,
  );
  sections.push({
    heading: 'Timeline',
    lines: timeline.length
      ? timeline.map((t) => `${clock(t.atMinute)} ${t.text} (${t.source})`)
      : ['No timeline entries.'],
  });

  const cites = new Map<string, Citation>();
  const packCites = (input.evidencePack?.contents.citations ?? []) as Citation[];
  packCites.forEach((c) => cites.set(c.chunkId, c));
  for (const e of input.events) {
    if (e.type === 'agent.tool_result') e.payload.citations?.forEach((c) => cites.set(c.chunkId, c));
    if (e.type === 'agent.report') e.payload.report.citations.forEach((c) => cites.set(c.chunkId, c));
  }
  sections.push({
    heading: 'Citations',
    lines: cites.size
      ? [...cites.values()].map((c) => `[${c.sourceId}] ${c.title} — "${c.quote}" ${c.url}`)
      : ['No citations.'],
  });

  sections.push({
    heading: 'Run',
    lines: [
      `Run ${input.runId} · scenario ${p.meta.scenarioId ?? '?'} · mode ${p.meta.mode ?? '?'} · status ${p.meta.status}${p.meta.completedReason ? ` (${p.meta.completedReason})` : ''}`,
      `Model: ${p.meta.llm ? `${p.meta.llm.provider}/${p.meta.llm.model}` : 'n/a'} · tool calls ${p.totals.toolCalls} · LLM cost $${p.totals.costUsd.toFixed(2)}`,
      `Evidence pack id: ${input.evidencePack?.id ?? 'not exported by the record agent'} · events ${p.lastSeq}`,
    ],
  });
  return sections;
}

export async function renderEvidencePdf(input: EvidenceInput): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(sanitise(`Evidence pack — ${input.scenarioTitle}`));
  doc.setAuthor(sanitise(input.carrierName));
  doc.setSubject(sanitise(simulatedLabel(input.disclaimer)));
  doc.setCreator('Incident Coordination Agent');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28;
  const H = 841.89;
  const M = 48;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.06, 0.09, 0.13);
  const muted = rgb(0.3, 0.35, 0.4);
  const ai = rgb(0.39, 0.27, 0.82);

  const footer = () =>
    page.drawText(sanitise(`${simulatedLabel(input.disclaimer)} · ${input.runId}`), {
      x: M,
      y: 24,
      size: 8,
      font,
      color: muted,
    });
  const newPage = () => {
    footer();
    page = doc.addPage([W, H]);
    y = H - M;
  };
  const wrap = (text: string, size: number, f = font, width = W - 2 * M) => {
    const words = sanitise(text).split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  };
  const write = (text: string, size = 10, f = font, color = ink, indent = 0) => {
    for (const l of wrap(text, size, f, W - 2 * M - indent)) {
      if (y < M + size) newPage();
      page.drawText(l, { x: M + indent, y, size, font: f, color });
      y -= size * 1.4;
    }
  };

  write(`Evidence pack — ${input.scenarioTitle}`, 18, bold);
  write(
    `${input.carrierName} · ${simulatedLabel(input.disclaimer)} · generated ${(input.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    9,
    font,
    muted,
  );
  y -= 8;
  for (const s of evidenceSections(input)) {
    if (y < M + 60) newPage();
    y -= 6;
    write(s.heading, 12, bold);
    if (s.aiDrafted)
      write('AI-drafted content — reviewed and approved by the named humans shown.', 8, bold, ai);
    for (const line of s.lines) write(`• ${line}`, 9.5, font, ink, 6);
  }
  footer();
  return doc.save();
}

export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
