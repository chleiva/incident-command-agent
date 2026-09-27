/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/** Errors that map to an `ApiError {error, code}` response. Anything else becomes a 500 without details. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** Extra fields merged into the error body (e.g. `screening`, `details`). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, extra?: Record<string, unknown>) =>
  new HttpError(400, 'bad_request', message, extra);
export const validationFailed = (errors: string[]) =>
  new HttpError(400, 'validation_failed', 'request body failed validation', { details: errors });
export const unauthorized = () => new HttpError(401, 'unauthorized', 'authentication required');
export const notFound = (what: string, code = 'not_found') => new HttpError(404, code, `${what} not found`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
