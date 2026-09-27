/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Optional stage-2 input classifier (`SCREEN_WITH_LLM=true`): a cheap Haiku call, cached by text hash upstream. */
import type { LlmProvider } from '@ica/schema';
import { CLASSIFIER_SYSTEM_PROMPT } from './screen-input';
import { wrapScenarioData } from './wrap';

export const CLASSIFIER_MODEL = 'claude-haiku-4-5';

export function createLlmClassifier(
  provider: LlmProvider,
  model = CLASSIFIER_MODEL,
): (text: string) => Promise<{ injection: boolean; reason: string }> {
  return async (text) => {
    const res = await provider.complete({
      model,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: wrapScenarioData(text.slice(0, 8000)) }] }],
      tools: [],
      maxTokens: 120,
      temperature: 0,
    });
    const m = /\{[\s\S]*\}/.exec(res.text);
    if (!m) return { injection: false, reason: 'unparseable classifier output' };
    const parsed = JSON.parse(m[0]) as { injection?: unknown; reason?: unknown };
    return { injection: parsed.injection === true, reason: String(parsed.reason ?? '') };
  };
}
