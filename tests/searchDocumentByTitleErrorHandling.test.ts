/**
 * Same ambiguity as getDocument (see getDocumentErrorHandling.test.ts), found
 * during a production-readiness pass but never fixed until now:
 * searchDocumentByTitle swallowed every failure -- a genuine "no match" 200
 * response, a 401, a 429 that survived its own retries, a dropped connection
 * -- into the same null. A caller treating null as "confirmed no duplicate"
 * (syncDocument's duplicate check, the folder-placeholder search fallback)
 * could then create a document that duplicates one search merely failed to
 * find. Fixed: null now means "search ran, found no match" only; anything
 * else throws, matching getDocument's contract.
 */
import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import type { Transport } from '../src/outline-api/custom-instance';

class TestApi extends OutlineApiBase {
  async uploadAttachmentToStorage(): Promise<boolean> {
    return true;
  }
}

function transportAlways(status: number, body: unknown = {}): Transport {
  return async () => ({ status, headers: new Headers(), json: async () => body });
}

describe('searchDocumentByTitle distinguishes "no match" from "could not check"', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
  });
  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('returns null on a genuine 200 response with no matching title', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(200, { data: [{ document: { title: 'Something Else' } }] })
    );
    await expect(api.searchDocumentByTitle('Target', 'col-1')).resolves.toBeNull();
  });

  it('returns the matching document on a genuine 200 response', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(200, {
        data: [{ document: { title: 'Target', id: 'doc-1', parentDocumentId: undefined } }],
      })
    );
    const found = await api.searchDocumentByTitle('Target', 'col-1');
    expect(found?.id).toBe('doc-1');
  });

  it('throws on a 401 rather than returning null', async () => {
    const api = new TestApi('http://x', 'k', transportAlways(401, { message: 'Unauthorized' }));
    await expect(api.searchDocumentByTitle('Target', 'col-1')).rejects.toThrow(/401/);
  });

  it('throws on a 429 that survived its own retries', async () => {
    const api = new TestApi('http://x', 'k', transportAlways(429, { message: 'rate limited' }));
    const promise = api.searchDocumentByTitle('Target', 'col-1');
    const assertion = expect(promise).rejects.toThrow(/429/);
    await jest.advanceTimersByTimeAsync(300_000);
    await assertion;
  });

  it('throws on a network exception rather than returning null', async () => {
    const transport: Transport = async () => {
      throw new Error('fetch failed');
    };
    const api = new TestApi('http://x', 'k', transport);
    const promise = api.searchDocumentByTitle('Target', 'col-1');
    const assertion = expect(promise).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
