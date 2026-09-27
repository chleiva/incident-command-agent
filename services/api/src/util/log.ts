/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Structured JSON logs (CLAUDE.md conventions). Never pass secrets, tokens or prompts as fields. */

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

type Sink = (line: string) => void;

export function createLogger(base: LogFields = {}, sink?: { out?: Sink; err?: Sink }): Logger {
  const out = sink?.out ?? ((l: string) => console.log(l));
  const err = sink?.err ?? ((l: string) => console.error(l));
  const write = (level: string, msg: string, fields?: LogFields) => {
    const line = JSON.stringify({ level, msg, time: new Date().toISOString(), ...base, ...fields });
    (level === 'error' ? err : out)(line);
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** Serialise an unknown error for a log line (name + message; the stack only goes to logs, never to clients). */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) return { errName: err.name, errMessage: err.message, stack: err.stack };
  return { errMessage: String(err) };
}
