/**
 * Custom HTTP instance for the orval-generated Outline API client.
 *
 * Uses a pluggable transport so the same generated code works with
 * native `fetch` (Node / CLI) **and** Obsidian's `requestUrl`.
 *
 * Call `configure()` once before any API call.
 */
import { extractApiMessage, getErrorMessage } from '../utils/errors';

export interface TransportResponse {
  status: number;
  headers: Headers;
  json(): Promise<unknown>;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<TransportResponse>;

const fetchTransport: Transport = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    headers: res.headers,
    json: () => res.json(),
  };
};

let _baseUrl = '';
let _apiKey = '';
let _transport: Transport = fetchTransport;

export function configure(opts: { baseUrl: string; apiKey: string; transport?: Transport }) {
  _baseUrl = opts.baseUrl.replace(/\/$/, '');
  _apiKey = opts.apiKey;
  if (opts.transport) _transport = opts.transport;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A bulk push of a large vault sits on the rate limiter for minutes at a time.
// Three attempts was not enough: a 697-note push lost 51 documents and 15
// attachments to exhausted retries, all reported as a bare "Create failed".
const MAX_RETRIES = 5;

export const customInstance = async <T>(url: string, init: RequestInit): Promise<T> => {
  const fullUrl = `${_baseUrl}/api${url}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${_apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }

  // Remembered across attempts so an exhausted retry can say *why* it gave up.
  // Without this the caller only learns that something failed, which is what
  // made a rate-limited bulk push impossible to diagnose from its own log.
  let lastStatus = 0;
  let lastMessage = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res: TransportResponse;
    try {
      res = await _transport(fullUrl, {
        method: (init.method ?? 'POST') as string,
        headers,
        body: init.body as string | undefined,
      });
    } catch (e) {
      // A thrown network exception (dropped socket, DNS failure, ...) used to
      // propagate immediately with zero retries -- only a 429 *response* was
      // ever retried, so a document write during exactly the kind of
      // connection trouble this branch exists to survive failed on the first
      // hit. Same backoff as a 5xx below: no Retry-After to honour here.
      lastStatus = 0;
      lastMessage = getErrorMessage(e);
      if (attempt === MAX_RETRIES - 1) break;
      const waitMs = Math.min(1000 * (attempt + 1), 5000);
      console.warn(
        `[Outline API] network error on ${url}: ${lastMessage}; retrying in ` +
          `${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      try {
        const body = await res.json();
        const msg = extractApiMessage(body);
        if (msg) lastMessage = msg;
      } catch {
        // Body is optional context; the status is what matters here.
      }
      let waitMs: number;
      if (res.status === 429) {
        const raw = parseInt(res.headers.get('retry-after') ?? '5', 10);
        waitMs = Math.min(isNaN(raw) ? 5 : raw, 60) * 1000;
      } else {
        // No Retry-After semantics for a plain 5xx -- back off a little more
        // each attempt so a flapping server gets breathing room without
        // stalling a bulk push as long as a real rate-limit wait would.
        waitMs = Math.min(1000 * (attempt + 1), 5000);
      }
      // Always logged, even when waitMs is 0 (a server-sent `retry-after: 0`)
      // -- silently retrying with nothing in the log is what made this class
      // of failure undiagnosable in the first place.
      const waitLabel = waitMs > 0 ? `waiting ${Math.round(waitMs / 1000)}s` : 'retrying now';
      console.warn(
        `[Outline API] ${res.status} on ${url}; ${waitLabel} (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      await sleep(waitMs);
      continue;
    }

    let data: unknown = {};
    let parseFailed = false;
    try {
      data = await res.json();
    } catch {
      parseFailed = true;
    }

    if (parseFailed) {
      // A non-JSON body means something other than Outline answered: an SSO or
      // Cloudflare Access login page, a proxy error page, a captive portal.
      // Without this the caller sees an empty object and reports success.
      const contentType = res.headers.get('content-type') ?? 'unknown';
      console.error(
        `[Outline API] ${res.status} on ${url}: response was not JSON ` +
          `(content-type: ${contentType}). Something other than Outline answered — ` +
          `check for an access proxy or login page in front of the API.`
      );
    } else if (res.status >= 400) {
      const detail = extractApiMessage(data);
      console.error(`[Outline API] ${res.status} on ${url}${detail ? `: ${detail}` : ''}`);
    }

    return { data, status: res.status, headers: res.headers, parseFailed } as T;
  }

  throw new Error(
    `[Outline API] ${lastStatus || 'no response'} on ${url} after ${MAX_RETRIES} attempts` +
      (lastMessage ? `: ${lastMessage}` : '')
  );
};

export default customInstance;

export type ErrorType<T> = T;
export type BodyType<T> = T;
