import { OutlineApiBase } from '../src/outline-api/outline-api-base';
import { resolveOrCreateCollection } from '../src/collection-resolver';
import type { Transport } from '../src/outline-api/custom-instance';
import type { IOutlineApi, Collection } from '../src/outline-api/types';

class TestApi extends OutlineApiBase {
  async uploadAttachmentToStorage(): Promise<boolean> {
    return true;
  }
}

function transportAlways(status: number, body: unknown): Transport {
  return async () => ({ status, headers: new Headers(), json: async () => body });
}

describe('OutlineApiBase.createCollection', () => {
  it('returns the created collection on success', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(200, { data: { id: 'col-1', name: 'Compendium' } })
    );
    const result = await api.createCollection({ name: 'Compendium' });
    expect(result).toEqual({ id: 'col-1', name: 'Compendium' });
  });

  it('throws with the status and message on failure', async () => {
    const api = new TestApi(
      'http://x',
      'k',
      transportAlways(400, { message: 'name already exists' })
    );
    await expect(api.createCollection({ name: 'Compendium' })).rejects.toThrow(/400/);
  });
});

function fakeApi(overrides: Partial<IOutlineApi> = {}): IOutlineApi {
  return {
    async validateAuth() {
      return 'test';
    },
    async checkConnection() {
      return { ok: true as const, user: 'test' };
    },
    async listCollections() {
      return [];
    },
    async createCollection() {
      return null;
    },
    async getDocument() {
      return null;
    },
    async createDocument() {
      return null;
    },
    async updateDocument() {
      return null;
    },
    async searchDocumentByTitle() {
      return null;
    },
    async createAttachment() {
      return null;
    },
    async uploadAttachmentToStorage() {
      return false;
    },
    ...overrides,
  };
}

describe('resolveOrCreateCollection', () => {
  it('returns an existing collection by exact name, without creating one', async () => {
    let createCalled = false;
    const api = fakeApi({
      async listCollections() {
        return [{ id: 'col-1', name: 'Compendium' } as Collection];
      },
      async createCollection() {
        createCalled = true;
        return null;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toEqual({ id: 'col-1', name: 'Compendium', created: false });
    expect(createCalled).toBe(false);
  });

  it('creates a collection when no name matches', async () => {
    const api = fakeApi({
      async listCollections() {
        return [{ id: 'col-1', name: 'Something Else' } as Collection];
      },
      async createCollection(params) {
        return { id: 'col-2', name: params.name } as Collection;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toEqual({ id: 'col-2', name: 'Compendium', created: true });
  });

  it('returns null when creation fails', async () => {
    const api = fakeApi({
      async listCollections() {
        return [];
      },
      async createCollection() {
        throw new Error('simulated 400');
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    expect(result).toBeNull();
  });

  it('returns null when listCollections itself returns null', async () => {
    const api = fakeApi({
      async listCollections() {
        return null;
      },
      async createCollection(params) {
        return { id: 'col-3', name: params.name } as Collection;
      },
    });

    const result = await resolveOrCreateCollection(api, 'Compendium');

    // listCollections failing is not fatal -- still tries to create.
    expect(result).toEqual({ id: 'col-3', name: 'Compendium', created: true });
  });
});
