/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** RunLauncher / AuthorInvoker implementations: Lambda invoke (AWS) and in-process (local dev server). */
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { AuthorResult, ExecuteRunInput, RunDeps, Store } from '@ica/schema';
import { isNotImplemented, type AuthorInvoker, type RunLauncher } from '../http/deps';
import { errorFields, silentLogger, type Logger } from '../util/log';
import { fakeRun } from './fake-runner';

type LambdaLike = Pick<LambdaClient, 'send'>;

/** Async invoke of the Run Lambda with `{runId}` (spec §5). */
export class LambdaRunLauncher implements RunLauncher {
  constructor(
    private readonly client: LambdaLike,
    private readonly functionName: string,
  ) {}
  async launch(runId: string): Promise<void> {
    const res = await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({ runId })),
      }),
    );
    if (res.StatusCode !== 202) throw new Error(`run invoke returned ${res.StatusCode}`);
  }
}

/** Synchronous invoke of the author Lambda with `{text}` → AuthorResult. */
export class LambdaAuthorInvoker implements AuthorInvoker {
  constructor(
    private readonly client: LambdaLike,
    private readonly functionName: string,
  ) {}
  async author(text: string): Promise<AuthorResult> {
    const res = await this.client.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(JSON.stringify({ text })),
      }),
    );
    const raw = res.Payload ? new TextDecoder().decode(res.Payload) : '';
    if (res.FunctionError) {
      let message = res.FunctionError;
      try {
        message = (JSON.parse(raw) as { errorMessage?: string }).errorMessage ?? message;
      } catch {
        /* keep FunctionError */
      }
      throw new Error(`author lambda failed: ${message}`);
    }
    return JSON.parse(raw) as AuthorResult;
  }
}

export type LocalRunnerMode = 'auto' | 'real' | 'fake';

export interface InProcessRunLauncherOptions {
  store: Store;
  /** `executeRun` from @ica/run (injected so tests can pass a fake). Its result (RunResult) is not used here. */
  executeRun: (input: ExecuteRunInput) => Promise<unknown>;
  deps: () => Promise<RunDeps>;
  /** auto (default): the real runner, falling back to the fake runner while `executeRun` is a stub. */
  mode?: LocalRunnerMode;
  fakeStepMs?: number;
  log?: Logger;
}

/** Local dev: fire-and-forget in-process runs (no Lambda). Aborted on `close()`. */
export class InProcessRunLauncher implements RunLauncher {
  private readonly running = new Map<string, { ctrl: AbortController; done: Promise<void> }>();
  private readonly log: Logger;
  constructor(private readonly opts: InProcessRunLauncherOptions) {
    this.log = opts.log ?? silentLogger;
  }

  async launch(runId: string): Promise<void> {
    const ctrl = new AbortController();
    const done = this.run(runId, ctrl.signal).finally(() => this.running.delete(runId));
    this.running.set(runId, { ctrl, done });
  }

  private async fake(runId: string, signal: AbortSignal) {
    await fakeRun({ store: this.opts.store, runId, signal, stepMs: this.opts.fakeStepMs });
  }

  private async run(runId: string, signal: AbortSignal): Promise<void> {
    const mode = this.opts.mode ?? 'auto';
    const log = this.log.child({ runId });
    try {
      if (mode === 'fake') return await this.fake(runId, signal);
      try {
        await this.opts.executeRun({ runId, deps: await this.opts.deps(), signal });
      } catch (err) {
        if (mode === 'auto' && isNotImplemented(err)) {
          log.warn('executeRun is not implemented yet: using the fake runner (fixture replay)');
          return await this.fake(runId, signal);
        }
        throw err;
      }
    } catch (err) {
      log.error('run failed', errorFields(err));
      await this.markFailed(runId, err).catch(() => {});
    }
  }

  private async markFailed(runId: string, err: unknown) {
    const { store } = this.opts;
    const meta = await store.getRun(runId);
    if (!meta || meta.status === 'failed' || meta.status === 'completed') return;
    const last = (await store.listEvents(runId, Math.max(0, meta.lastSeq - 1), 1)).events.at(-1);
    await store.append(runId, [
      {
        type: 'run.failed',
        payload: { error: err instanceof Error ? err.message : String(err), where: 'local.runner' },
        actor: { kind: 'world' },
        simMinute: last?.simMinute ?? 0,
        simTime: last?.simTime ?? new Date().toISOString(),
      },
    ]);
    await store.updateRun(runId, { status: 'failed', endedAt: new Date().toISOString() });
  }

  /** Abort every in-flight run and wait for them to settle. */
  async close(): Promise<void> {
    const all = [...this.running.values()];
    all.forEach((r) => r.ctrl.abort());
    await Promise.allSettled(all.map((r) => r.done));
  }

  /** For tests: resolves when the run's in-process promise settles. */
  async settled(runId: string): Promise<void> {
    await this.running.get(runId)?.done;
  }
}

/** Local dev: `runAuthor` in-process. */
export class InProcessAuthorInvoker implements AuthorInvoker {
  constructor(
    private readonly runAuthor: (text: string, deps: RunDeps) => Promise<AuthorResult>,
    private readonly deps: () => Promise<RunDeps>,
  ) {}
  async author(text: string): Promise<AuthorResult> {
    return this.runAuthor(text, await this.deps());
  }
}
