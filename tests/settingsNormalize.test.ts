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

  it('still copies folderDocIds defensively (existing behavior, unchanged)', () => {
    const first = normalizeSettings(null);
    first.folderDocIds['x'] = 'y';

    const second = normalizeSettings(null);

    expect(second.folderDocIds).toEqual({});
  });
});
