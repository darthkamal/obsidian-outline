import { normalizeSettings, DEFAULT_SETTINGS } from '../src/settings';

describe('normalizeSettings', () => {
  it('fills in directoryMappings as an empty array when data.json predates it', () => {
    const result = normalizeSettings({ outlineUrl: 'https://x', apiKey: 'k' });

    expect(result.directoryMappings).toEqual([]);
  });

  it('does not mutate DEFAULT_SETTINGS.directoryMappings across two loads', () => {
    const first = normalizeSettings(null);
    first.directoryMappings.push({
      directoryPath: 'Compendium',
      collectionId: 'col-1',
      collectionName: 'Compendium',
    });

    const second = normalizeSettings(null);

    expect(second.directoryMappings).toEqual([]);
    expect(DEFAULT_SETTINGS.directoryMappings).toEqual([]);
  });

  it('preserves an already-populated directoryMappings from loaded data', () => {
    const mapping = { directoryPath: 'A', collectionId: 'c1', collectionName: 'A' };
    const result = normalizeSettings({ directoryMappings: [mapping] });

    expect(result.directoryMappings).toEqual([mapping]);
  });

  it('degrades a malformed directoryMappings to an empty array instead of throwing', () => {
    // A hand-edited or half-written data.json. Throwing here happens inside
    // onload() and would take the whole plugin down.
    const fromNull = normalizeSettings({ directoryMappings: null } as never);
    expect(fromNull.directoryMappings).toEqual([]);

    const fromObject = normalizeSettings({ directoryMappings: { nope: true } } as never);
    expect(fromObject.directoryMappings).toEqual([]);

    const fromString = normalizeSettings({ directoryMappings: 'Compendium' } as never);
    expect(fromString.directoryMappings).toEqual([]);
  });

  it('still copies folderDocIds defensively (existing behavior, unchanged)', () => {
    const first = normalizeSettings(null);
    first.folderDocIds['x'] = 'y';

    const second = normalizeSettings(null);

    expect(second.folderDocIds).toEqual({});
  });
});
