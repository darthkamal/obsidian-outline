/**
 * Node's fetch collapses every transport problem into the message "fetch
 * failed" and puts the real reason on `cause`. A sync log full of bare "fetch
 * failed" lines cannot tell a dropped VPN from a refused connection, so the
 * cause is unwrapped here where every caller benefits.
 */
export function getErrorMessage(e: unknown): string {
  if (!(e instanceof Error)) return String(e);

  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== e.message) {
    return `${e.message} (${cause.message})`;
  }
  return e.message;
}

/**
 * Pulls a `message` string out of a parsed Outline API error body, if there
 * is one. Was duplicated three times across custom-instance.ts and
 * outline-api-base.ts; kept in one place so a future change to the shape
 * only needs to happen once.
 */
export function extractApiMessage(data: unknown): string {
  return data && typeof data === 'object' && 'message' in data
    ? String((data as { message: unknown }).message)
    : '';
}
