import { vi } from "vitest";

/** Every `fetch` the publish client makes passes object headers, a string body and a signal. */
export interface FetchInit {
  method?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  signal: AbortSignal;
}

export type FetchCall = [url: string, init: FetchInit];

export type FetchImpl = (url: string, init: FetchInit) => Promise<Response>;

export function installFetch(impl: FetchImpl): void {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}

export function calls(): FetchCall[] {
  return (global.fetch as unknown as { mock: { calls: FetchCall[] } }).mock.calls;
}

export function bodyOf(i = 0): Record<string, unknown> {
  const { body } = calls()[i][1];
  if (body === undefined) throw new Error(`fetch call ${String(i)} had no body`);
  return JSON.parse(body) as Record<string, unknown>;
}

export function authOf(i = 0): string | undefined {
  return calls()[i][1].headers.Authorization;
}

export function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
