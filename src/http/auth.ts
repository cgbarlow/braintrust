/**
 * Auth, copied from OB1 rather than reinvented: a shared secret, `?key=` in the URL,
 * with `x-access-key` accepted as a header.
 *
 * Three details are copied deliberately, because each exists to fix a real client bug.
 * The one encoded here is the strangest: an auth failure returns HTTP 200 with a
 * JSON-RPC error envelope, not a 401. Codex CLI and Claude Code tear down the
 * connection on a transport-level 4xx, so a correct 401 produces a worse user
 * experience than a wrong 200.
 *
 * See docs/design/deployment.md §4.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** OB1's code for an auth failure. */
export const AUTH_ERROR_CODE = -32001;

/**
 * `?key=` is the documented primary; `x-access-key` is the extension header OB1
 * uses. Its core server uses `x-brain-key` — braintrust is an extension, so
 * `x-access-key` is the right one, and the query parameter is what gets documented
 * to avoid header-name confusion.
 */
export const KEY_QUERY_PARAM = 'key';
export const KEY_HEADER = 'x-access-key';

export type PresentedKeySource = {
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
};

export function presentedKey(source: PresentedKeySource): string | undefined {
  const fromQuery = source.query?.[KEY_QUERY_PARAM];
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const fromHeader = source.headers?.[KEY_HEADER];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  // Node lowercases header names, but a proxy may hand us an array.
  if (Array.isArray(fromHeader) && typeof fromHeader[0] === 'string') return fromHeader[0];

  return undefined;
}

/**
 * Compares digests rather than the secrets themselves, so a length difference does
 * not leak through `timingSafeEqual`'s equal-length requirement.
 */
export function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

export type JsonRpcId = string | number | null;

export type JsonRpcErrorEnvelope = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
};

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorEnvelope {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Echoes the request's id when there is one, per JSON-RPC, and falls back to null
 * for a batch, a notification, or a body we could not parse.
 */
export function idFromBody(body: unknown): JsonRpcId {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

export const AUTH_FAILURE_MESSAGE =
  'Unauthorized: braintrust needs its shared secret. Pass it as ?key=<secret> on the ' +
  'server URL, or as an x-access-key header.';
