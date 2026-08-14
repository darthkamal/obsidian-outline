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
  // Known gap: listCollections asks for one page of 100 and does not
  // paginate, so on an instance with more than 100 collections an existing
  // collection past the first page won't be found here and a second one with
  // the same name gets created instead (Outline does not require collection
  // names to be unique). The mapping then pins to that duplicate, since a
  // resolved collectionId is deliberately never re-resolved by name. Fixing
  // it properly means pagination in the API layer, which the rest of the
  // plugin -- including the settings collection picker -- shares and would
  // need to change with it.
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
