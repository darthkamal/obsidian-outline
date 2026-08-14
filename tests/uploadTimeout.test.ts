/**
 * Real gap noted in migration/findings.md's open items: a stalled upload had
 * no app-level deadline, so it hung until whatever sat in front of Outline
 * timed it out -- which findings.md measured at ~120s for a real 14MB file,
 * but is not guaranteed to happen at all. Both transports now enforce
 * `uploadTimeoutMs` themselves instead of trusting the far end to give up.
 */
import { OutlineClientNode } from '../src/outline-api/outline-client-node';

const requestUrlMock = jest.fn();
jest.mock('obsidian', () => ({ requestUrl: (...args: unknown[]) => requestUrlMock(...args) }), {
  virtual: true,
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OutlineClient } = require('../src/outline-client');

describe('a stalled upload fails fast instead of hanging indefinitely', () => {
  const realFetch = global.fetch;
  let errors: string[];
  let spy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    requestUrlMock.mockReset();
  });
  afterEach(() => {
    global.fetch = realFetch;
    spy.mockRestore();
    warnSpy.mockRestore();
  });

  it('Node client: aborts a fetch that never settles and reports a timeout', async () => {
    let aborted = false;
    global.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;

    // 5ms timeout, well under the retry backoff, so the whole test stays fast
    // and exercises all 3 attempts.
    const client = new OutlineClientNode('http://x', 'k', 5);
    const result = await client.uploadAttachmentToStorage(
      'http://x/api/files.create',
      {},
      new ArrayBuffer(8),
      'audio/mpeg'
    );

    expect(result).toBe(false);
    expect(aborted).toBe(true);
    expect(errors.join(' ')).toMatch(/timed out after/);
  });

  it('Obsidian client: stops waiting on a requestUrl call that never resolves', async () => {
    requestUrlMock.mockImplementation(() => new Promise(() => {})); // never settles

    const client = new (OutlineClient as new (
      u: string,
      k: string,
      t?: number
    ) => {
      uploadAttachmentToStorage(
        url: string,
        form: Record<string, unknown>,
        data: ArrayBuffer,
        contentType: string
      ): Promise<boolean>;
    })('http://x', 'k', 5);

    const result = await client.uploadAttachmentToStorage(
      'http://x/api/files.create',
      {},
      new ArrayBuffer(8),
      'audio/mpeg'
    );

    expect(result).toBe(false);
    expect(errors.join(' ')).toMatch(/timed out after/);
    // requestUrl has no AbortSignal -- the never-settling call from the first
    // attempt is still "in flight" as far as the runtime is concerned.
    // Retrying on top of it would stack a second upload over the same
    // constrained connection this timeout exists to protect, so a timeout
    // must be terminal here: exactly one attempt, not UPLOAD_ATTEMPTS.
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });
});
