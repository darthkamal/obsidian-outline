import { getErrorMessage } from '../src/utils/errors';

/**
 * `new Error(msg, { cause })` needs an ES2022 lib, which this project does not
 * target, so the cause is attached the way the runtime represents it.
 */
function withCause(message: string, cause: Error): Error {
  return Object.assign(new Error(message), { cause });
}

describe('a wrapped network error reports its cause', () => {
  // Node's fetch reports every transport problem as the single word "fetch
  // failed" and hides the real reason on `cause`. A sync log full of "fetch
  // failed" cannot distinguish a dropped VPN from a refused connection.
  it('appends the cause message', () => {
    const err = withCause('fetch failed', new Error('read ECONNRESET'));

    expect(getErrorMessage(err)).toMatch(/ECONNRESET/);
  });

  it('keeps the outer message too', () => {
    const err = withCause('fetch failed', new Error('read ECONNRESET'));

    expect(getErrorMessage(err)).toMatch(/fetch failed/);
  });

  it('uses a system errno when the cause carries one', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:2379'), {
      code: 'ECONNREFUSED',
    });

    expect(getErrorMessage(withCause('fetch failed', cause))).toMatch(/ECONNREFUSED/);
  });

  it('does not repeat an identical cause message', () => {
    expect(getErrorMessage(withCause('same', new Error('same')))).toBe('same');
  });

  it('is unchanged for an ordinary error', () => {
    expect(getErrorMessage(new Error('plain'))).toBe('plain');
  });

  it('still handles a non-error value', () => {
    expect(getErrorMessage('a string')).toBe('a string');
  });
});
