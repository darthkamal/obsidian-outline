import type { IOutlineApi } from './outline-api/types';

export interface ResolvedCollection {
  id: string;
  name: string;
  /** True if this call created a new collection; false if an existing one matched by name. */
  created: boolean;
}

/**
 * Finds an Outline collection with an exact name match, or creates one if
 * none exists. Returns null on any failure (auth, network, a create that
 * fails) rather than throwing -- the caller decides how to surface that
 * (see PushEngine.mapDirectory) and must not save a partial mapping.
 */
export async function resolveOrCreateCollection(
  api: IOutlineApi,
  name: string
): Promise<ResolvedCollection | null> {
  const collections = await api.listCollections();
  const existing = collections?.find((c) => c.name === name);
  if (existing?.id) {
    return { id: existing.id, name: existing.name ?? name, created: false };
  }

  try {
    const created = await api.createCollection({ name });
    if (!created?.id) return null;
    return { id: created.id, name: created.name ?? name, created: true };
  } catch {
    return null;
  }
}
