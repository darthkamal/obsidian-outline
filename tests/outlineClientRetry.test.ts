/**
 * The Obsidian plugin's actual attachment-upload path (OutlineClient, used by
 * push-engine.ts) had no test coverage at all -- the retry/backoff and
 * cause-unwrapping fixes for lost uploads were applied only to the separate
 * Node/CLI client (OutlineClientNode), leaving the real plugin runtime with
 * exactly one upload attempt. These tests mirror rateLimit.test.ts's
 * coverage of OutlineClientNode, against OutlineClient instead.
 */
const requestUrlMock = jest.fn();

// 'obsidian' has no runtime build -- it's a types-only devDependency -- so
// jest can't resolve it as a real module without { virtual: true }.
jest.mock(
  'obsidian',
  () => ({
    requestUrl: (...args: unknown[]) => requestUrlMock(...args),
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OutlineClient } = require('../src/outline-client');

describe('the plugin upload path retries and reports failures', () => {
  let errors: string[];
  let spy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    requestUrlMock.mockReset();
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    spy.mockRestore();
    warnSpy.mockRestore();
  });

  function upload() {
    const client = new (OutlineClient as new (
      u: string,
      k: string
    ) => {
      uploadAttachmentToStorage(
        url: string,
        form: Record<string, unknown>,
        data: ArrayBuffer,
        contentType: string
      ): Promise<boolean>;
    })('http://x', 'k');
    return client.uploadAttachmentToStorage(
      'http://x/api/files.create',
      {},
      new ArrayBuffer(8),
      'audio/mpeg'
    );
  }

  it('reports the status when storage rejects the file, without retrying', async () => {
    requestUrlMock.mockResolvedValue({ status: 413 });

    expect(await upload()).toBe(false);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
    expect(errors.join(' ')).toMatch(/413/);
  });

  it('retries an upload the server dropped mid-transfer', async () => {
    let attempts = 0;
    requestUrlMock.mockImplementation(async () => {
      attempts++;
      if (attempts < 3) return { status: 503 };
      return { status: 200 };
    });

    expect(await upload()).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up after repeated 5xx responses rather than looping forever', async () => {
    requestUrlMock.mockResolvedValue({ status: 503 });

    expect(await upload()).toBe(false);
    expect(requestUrlMock).toHaveBeenCalledTimes(3);
  });

  it('unwraps the cause of a network exception', async () => {
    requestUrlMock.mockRejectedValue(
      Object.assign(new Error('fetch failed'), { cause: new Error('read ECONNRESET') })
    );

    expect(await upload()).toBe(false);
    expect(errors.join(' ')).toMatch(/ECONNRESET/);
  });
});
