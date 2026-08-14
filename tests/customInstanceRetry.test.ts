/**
 * Real bug, found in review of the fix/self-hosted-sync branch: the retry
 * loop in custom-instance.ts (shared by documents.create/update on both the
 * plugin and CLI) only ever special-cased HTTP 429. A 5xx response or a
 * thrown network exception (dropped socket, DNS failure) fell straight
 * through with zero retries -- exactly the class of failure the branch's
 * MAX_RETRIES bump was meant to survive, just missed for document writes.
 */
import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import type { Transport } from '../src/outline-api/custom-instance';

class TestApi extends OutlineApiBase {
  async uploadAttachmentToStorage(): Promise<boolean> {
    return true;
  }
}

describe('document writes retry on 5xx and network exceptions, not just 429', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
  });
  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('retries a 503 and succeeds once the server recovers', async () => {
    let attempts = 0;
    const transport: Transport = async () => {
      attempts++;
      if (attempts < 3) {
        return { status: 503, headers: new Headers(), json: async () => ({}) };
      }
      return {
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: { id: 'doc-1', collectionId: 'c' } }),
      };
    };
    const api = new TestApi('http://x', 'k', transport);

    const promise = api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true });
    await jest.advanceTimersByTimeAsync(20_000);
    const doc = await promise;

    expect(doc?.id).toBe('doc-1');
    expect(attempts).toBe(3);
  });

  it('retries a thrown network exception and succeeds once the connection recovers', async () => {
    let attempts = 0;
    const transport: Transport = async () => {
      attempts++;
      if (attempts < 3) {
        throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNRESET') });
      }
      return {
        status: 200,
        headers: new Headers(),
        json: async () => ({ data: { id: 'doc-1', collectionId: 'c' } }),
      };
    };
    const api = new TestApi('http://x', 'k', transport);

    const promise = api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true });
    await jest.advanceTimersByTimeAsync(20_000);
    const doc = await promise;

    expect(doc?.id).toBe('doc-1');
    expect(attempts).toBe(3);
  });

  it('gives up after exhausting retries on a sustained 5xx, with the status in the error', async () => {
    const transport: Transport = async () => ({
      status: 502,
      headers: new Headers(),
      json: async () => ({}),
    });
    const api = new TestApi('http://x', 'k', transport);

    const promise = api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true });
    const assertion = expect(promise).rejects.toThrow(/502/);
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('gives up after exhausting retries on a sustained network failure', async () => {
    const transport: Transport = async () => {
      throw Object.assign(new Error('fetch failed'), { cause: new Error('ECONNREFUSED') });
    };
    const api = new TestApi('http://x', 'k', transport);

    const promise = api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true });
    const assertion = expect(promise).rejects.toThrow(/ECONNREFUSED/);
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it('does not retry a plain 4xx', async () => {
    let attempts = 0;
    const transport: Transport = async () => {
      attempts++;
      return { status: 400, headers: new Headers(), json: async () => ({ message: 'bad title' }) };
    };
    const api = new TestApi('http://x', 'k', transport);

    await expect(
      api.createDocument({ title: 't', text: 'b', collectionId: 'c', publish: true })
    ).rejects.toThrow(/400/);
    expect(attempts).toBe(1);
  });
});
