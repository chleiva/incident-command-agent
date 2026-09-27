/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * One LLM call in the audit: "Context sent to the model" (system prompt, tool definitions, every message and content
 * block) and "Model output" (text, tool calls, stop reason, usage), each with a Raw JSON tab showing the stored
 * request/response exactly as written by the runtime.
 */
import * as Tabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { formatLatency } from '../../audit/audit';
import { Badge, cx } from '../ui/primitives';
import { JsonViewer } from './JsonViewer';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface LlmTraceViewProps {
  trace: unknown;
  /** File name stem for downloads (e.g. the trace label). */
  stem: string;
}

export function LlmTraceView({ trace, stem }: LlmTraceViewProps) {
  const t = obj(trace);
  const request = t.request;
  const response = t.response;
  const error = str(t.error);
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-2" data-testid="llm-trace">
      <Panel
        title="Context sent to the model"
        idBase={`${stem}-request`}
        readable={<RequestReadable request={request} />}
        raw={
          <JsonViewer
            value={request}
            label="Raw request JSON"
            filename={`${stem}.request.json`}
            testId="raw-request"
          />
        }
      />
      <Panel
        title="Model output"
        badge={<Badge tone="ai">AI-generated</Badge>}
        idBase={`${stem}-response`}
        readable={
          response === undefined ? (
            <p className="text-body text-critical">
              The call failed; no model output was recorded.{error ? ` Error: ${error}` : ''}
            </p>
          ) : (
            <ResponseReadable response={response} trace={t} />
          )
        }
        raw={
          <JsonViewer
            value={response === undefined ? { error } : response}
            label="Raw response JSON"
            filename={`${stem}.response.json`}
            testId="raw-response"
          />
        }
      />
    </div>
  );
}

function Panel({
  title,
  badge,
  readable,
  raw,
  idBase,
}: {
  title: string;
  badge?: ReactNode;
  readable: ReactNode;
  raw: ReactNode;
  idBase: string;
}) {
  const trigger =
    'h-7 rounded-sm px-2 text-caption text-fg-muted data-[state=active]:bg-surface-hover data-[state=active]:text-fg';
  return (
    <section
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface p-2"
      aria-label={title}
    >
      <Tabs.Root defaultValue="readable" className="flex min-w-0 flex-col gap-2" id={idBase}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-body font-semibold text-fg">
            {title} {badge}
          </h3>
          <Tabs.List aria-label={`${title}: view`} className="flex gap-1">
            <Tabs.Trigger value="readable" className={trigger}>
              Readable
            </Tabs.Trigger>
            <Tabs.Trigger value="raw" className={trigger}>
              Raw JSON
            </Tabs.Trigger>
          </Tabs.List>
        </div>
        <Tabs.Content value="readable" className="min-w-0">
          {readable}
        </Tabs.Content>
        <Tabs.Content value="raw" className="min-w-0">
          {raw}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function Pre({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cx(
        'max-h-[24rem] overflow-auto whitespace-pre-wrap break-words rounded-sm bg-surface-sunken p-2 font-mono text-[12px] leading-[1.45] text-fg',
        className,
      )}
    >
      {children}
    </pre>
  );
}

const json = (v: unknown) => JSON.stringify(v, null, 2) ?? String(v);

function Meta({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-fg-muted">
      {items.map(([k, v]) => (
        <div key={k} className="flex gap-1">
          <dt>{k}:</dt>
          <dd className="text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RequestReadable({ request }: { request: unknown }) {
  const r = obj(request);
  const system = r.system;
  const tools = arr(r.tools);
  const messages = arr(r.messages);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Meta
        items={[
          ['Model', str(r.model) ?? '–'],
          ['Max tokens', String(r.maxTokens ?? '–')],
          ['Temperature', String(r.temperature ?? '–')],
          ['Messages', String(messages.length)],
          ['Tools', String(tools.length)],
        ]}
      />
      <details open className="rounded-sm border border-border">
        <summary className="cursor-pointer px-2 py-1 text-caption font-medium text-fg">System prompt</summary>
        <div className="p-2">
          <Pre>{typeof system === 'string' ? system : json(system)}</Pre>
        </div>
      </details>
      <details className="rounded-sm border border-border">
        <summary className="cursor-pointer px-2 py-1 text-caption font-medium text-fg">
          Tool definitions ({tools.length})
        </summary>
        <ul className="flex flex-col gap-2 p-2">
          {tools.map((tool, i) => {
            const d = obj(tool);
            return (
              <li key={i} className="rounded-sm border border-border p-2">
                <div className="font-mono text-caption text-fg">{str(d.name) ?? `tool ${i + 1}`}</div>
                {str(d.description) && (
                  <p className="mt-1 whitespace-pre-wrap text-caption text-fg-muted">{str(d.description)}</p>
                )}
                <details className="mt-1">
                  <summary className="cursor-pointer text-micro text-fg-muted">Input schema</summary>
                  <Pre>{json(d.inputSchema ?? d.input_schema ?? d.parameters)}</Pre>
                </details>
              </li>
            );
          })}
        </ul>
      </details>
      <ol className="flex flex-col gap-2" aria-label="Messages">
        {messages.map((m, i) => (
          <MessageView key={i} index={i} message={m} />
        ))}
      </ol>
    </div>
  );
}

function MessageView({ message, index }: { message: unknown; index: number }) {
  const m = obj(message);
  const role = str(m.role) ?? 'unknown';
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : arr(m.content);
  return (
    <li
      className={cx(
        'rounded-sm border p-2',
        role === 'assistant' ? 'border-ai/40 bg-ai-bg/40' : 'border-border bg-surface',
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-micro font-semibold uppercase tracking-wide text-fg-muted">
        #{index + 1} {role === 'assistant' ? 'assistant (earlier model output)' : role}
      </div>
      <div className="flex flex-col gap-1">
        {content.map((b, j) => (
          <BlockView key={j} block={b} />
        ))}
      </div>
    </li>
  );
}

function BlockView({ block }: { block: unknown }) {
  const b = obj(block);
  const type = str(b.type) ?? 'block';
  if (type === 'text')
    return (
      <div>
        <BlockLabel>text{b.cache ? ' · cache breakpoint' : ''}</BlockLabel>
        <Pre>{str(b.text) ?? ''}</Pre>
      </div>
    );
  if (type === 'tool_use')
    return (
      <div>
        <BlockLabel>
          tool_use · <span className="font-mono">{str(b.name)}</span> · {str(b.id)}
        </BlockLabel>
        <Pre>{json(b.input)}</Pre>
      </div>
    );
  if (type === 'tool_result')
    return (
      <div>
        <BlockLabel>
          tool_result · {str(b.toolUseId) ?? str(b.tool_use_id)}
          {b.isError ? ' · error' : ''}
        </BlockLabel>
        <Pre>{typeof b.content === 'string' ? b.content : json(b.content)}</Pre>
      </div>
    );
  return (
    <div>
      <BlockLabel>{type}</BlockLabel>
      <Pre>{json(b)}</Pre>
    </div>
  );
}

function BlockLabel({ children }: { children: ReactNode }) {
  return <div className="text-micro text-fg-muted">{children}</div>;
}

function ResponseReadable({ response, trace }: { response: unknown; trace: Obj }) {
  const r = obj(response);
  const usage = obj(r.usage);
  const calls = arr(r.toolCalls);
  const n = (k: string) => (typeof usage[k] === 'number' ? String(usage[k]) : '–');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Meta
        items={[
          ['Model', str(r.model) ?? str(trace.model) ?? '–'],
          ['Stop reason', str(r.stopReason) ?? '–'],
          ['Input tokens', n('inputTokens')],
          ['Output tokens', n('outputTokens')],
          ['Cache read', n('cacheReadTokens')],
          ['Cache write', n('cacheWriteTokens')],
          [
            'Latency',
            formatLatency(typeof trace.latencyMs === 'number' ? trace.latencyMs : undefined) ?? '–',
          ],
        ]}
      />
      <div>
        <BlockLabel>Text (model output)</BlockLabel>
        <Pre>{str(r.text) || '(no text)'}</Pre>
      </div>
      <div>
        <BlockLabel>Tool calls ({calls.length})</BlockLabel>
        <ul className="flex flex-col gap-1">
          {calls.map((c, i) => {
            const d = obj(c);
            return (
              <li key={i}>
                <BlockLabel>
                  <span className="font-mono">{str(d.name)}</span> · {str(d.id)}
                </BlockLabel>
                <Pre>{json(d.input)}</Pre>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
