/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ExecuteRunInput } from '@ica/schema';
import { MemoryStore, MemoryTraceStore } from '@ica/store';
import { InProcessRunLauncher } from './launchers';

describe('InProcessRunLauncher: continuation and resume', () => {
  it('a continuation request starts `{continuation}`, an error request `{resume}`', async () => {
    const store = new MemoryStore();
    const inputs: ExecuteRunInput[] = [];
    let settle!: () => void;
    const allDone = new Promise<void>((r) => (settle = r));
    const launcher = new InProcessRunLauncher({
      store,
      mode: 'real',
      executeRun: async (input) => {
        inputs.push(input);
        if (inputs.length === 1) {
          await input.deps.scheduleResume!({
            runId: input.runId,
            attempt: 1,
            reason: 'x',
            kind: 'continuation',
          });
          await input.deps.scheduleResume!({ runId: input.runId, attempt: 1, reason: 'y' });
        }
        if (inputs.length === 3) settle();
      },
      deps: async () => ({
        store,
        traces: new MemoryTraceStore(),
        knowledge: { search: async () => [] },
        llm: {} as never,
      }),
    });
    await launcher.launch('r1');
    await allDone;
    await launcher.close();
    expect(inputs.map((i) => [i.continuation, i.resume])).toEqual([
      [undefined, undefined],
      [{ attempt: 1 }, undefined],
      [undefined, { attempt: 1 }],
    ]);
  });
});
