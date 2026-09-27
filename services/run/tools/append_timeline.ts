/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import type { SystemMutation, TimelineEntry, ToolDefinition } from '@ica/schema';
import { appendTimeline } from '../systems/record/index';
import { fromResult, obj } from './_shared';

/** Cap per timeline entry (live run 2: was 400; a longer entry is split into sequential entries). */
export const TIMELINE_TEXT_MAX = 2000;

export const TIMELINE_SOURCES = [
  'orchestrator',
  'maintenance',
  'ground',
  'flightops',
  'passenger',
  'record',
  'world',
  'human',
] as const;

export const append_timeline: ToolDefinition<{
  text: string;
  atMinute?: number;
  source?: (typeof TIMELINE_SOURCES)[number];
}> = {
  name: 'append_timeline',
  description:
    'Add a factual, time-stamped entry to the incident timeline (what happened, who decided what, when). Default time is now. Keep entries short and neutral; no speculation or blame.',
  inputSchema: obj(
    {
      text: { type: 'string', minLength: 5, maxLength: TIMELINE_TEXT_MAX },
      atMinute: { type: 'number', minimum: 0, maximum: 1440 },
      source: { type: 'string', enum: [...TIMELINE_SOURCES] },
    },
    ['text'],
  ),
  tier: 'execute',
  system: 'record',
  roles: ['record'],
  mutates: true,
  outputScreen: { kind: 'report', fields: ['/text'] },
  // An over-cap entry is split into sequential entries (never truncated): the runtime passes it through uncut.
  splitOverlong: ['/text'],
  handler: async (input, ctx) => {
    const parts = splitTimelineText(input.text, TIMELINE_TEXT_MAX);
    if (parts.length === 1) {
      return fromResult(
        appendTimeline(
          ctx.state,
          { text: input.text, atMinute: input.atMinute ?? ctx.simMinute, source: input.source ?? 'record' },
          ctx.rng,
        ),
        (e) => ({ entry: e }),
      );
    }
    // Sequential entries at the same minute; each id is taken against the timeline including the earlier parts.
    const timeline = { ...ctx.state.record.timeline };
    const entries: TimelineEntry[] = [];
    const mutations: SystemMutation[] = [];
    for (const [i, part] of parts.entries()) {
      const r = appendTimeline(
        { ...ctx.state, record: { ...ctx.state.record, timeline } },
        {
          text: `(${i + 1}/${parts.length}) ${part}`,
          atMinute: input.atMinute ?? ctx.simMinute,
          source: input.source ?? 'record',
        },
        ctx.rng,
      );
      if (!r.ok) return { ok: false, error: r.error };
      timeline[r.value.id] = r.value;
      entries.push(r.value);
      mutations.push(...r.mutations);
    }
    return {
      ok: true,
      data: {
        entries,
        note: `The entry exceeded ${TIMELINE_TEXT_MAX} characters and was recorded as ${parts.length} sequential entries.`,
      },
      mutations,
    };
  },
};

/**
 * Split a long timeline text into parts of at most `max` characters (leaving room for the "(i/n) " prefix), at a
 * sentence end, else at a space, else hard.
 */
export function splitTimelineText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const room = max - 12;
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > room) {
    const window = rest.slice(0, room);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('; '), window.lastIndexOf('\n'));
    const space = window.lastIndexOf(' ');
    const cut = sentence > room / 2 ? sentence + 1 : space > room / 2 ? space : room;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
