import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal in-memory stand-in for idb-keyval so the cache logic is exercised without real IndexedDB.
const store = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => store.get(key)),
  set: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
  del: vi.fn(async (key: string) => void store.delete(key)),
  keys: vi.fn(async () => [...store.keys()]),
}));

// The cache guards on indexedDB; provide it so the guard does not short-circuit every test.
beforeEach(() => {
  store.clear();
  vi.stubGlobal('indexedDB', {});
});

const { cacheSize, clearCache, getReport, getTranscript, setReport, setTranscript, textHash } = await import('./cache');

describe('cache', () => {
  it('produces a stable hash for the same text', async () => {
    expect(await textHash('vanakkam sir')).toBe(await textHash('vanakkam sir'));
  });

  it('produces different hashes for different text', async () => {
    expect(await textHash('vanakkam sir')).not.toBe(await textHash('vanakkam madam'));
  });

  it('returns undefined when nothing is cached', async () => {
    expect(await getTranscript('abc', 'stt/model')).toBeUndefined();
    expect(await getReport('def', 'llm/model', '1.0', 'single')).toBeUndefined();
  });

  it('round-trips a transcript', async () => {
    await setTranscript('abc', 'stt/model', 'ta', { pieces: ['one', 'two'], seconds: [60, 30] });
    expect(await getTranscript('abc', 'stt/model', 'ta')).toEqual({ pieces: ['one', 'two'], seconds: [60, 30] });
  });

  it('does not return a transcript cached for a different model', async () => {
    await setTranscript('abc', 'stt/model', 'ta', { pieces: ['one'], seconds: [60] });
    expect(await getTranscript('abc', 'other/model', 'ta')).toBeUndefined();
  });

  it('does not return a transcript cached for a different language', async () => {
    await setTranscript('abc', 'stt/model', 'ta', { pieces: ['one'], seconds: [60] });
    expect(await getTranscript('abc', 'stt/model', 'en')).toBeUndefined();
  });

  it('round-trips a report', async () => {
    await setReport('def', 'llm/model', '1.0', 'single', { a: { title: 'x' } });
    expect(await getReport('def', 'llm/model', '1.0', 'single')).toEqual({ a: { title: 'x' } });
  });

  it('keeps single and double scoring variants apart', async () => {
    await setReport('def', 'llm/model', '1.0', 'single', { a: 1 });
    expect(await getReport('def', 'llm/model', '1.0', 'double')).toBeUndefined();
  });

  it('re-uses a report after the prompt version changes', async () => {
    await setReport('def', 'llm/model', '1.0', 'single', { a: 1 });
    expect(await getReport('def', 'llm/model', '2.0', 'single')).toBeUndefined();
  });

  it('reports and clears its size without touching analysis records', async () => {
    store.set('callscore:analysis:1', { big: 'x'.repeat(100) });
    await setTranscript('abc', 'stt/model', undefined, { pieces: ['one'], seconds: [60] });
    const size = await cacheSize();
    expect(size.entries).toBe(1);
    expect(size.bytes).toBeGreaterThan(0);

    await clearCache();
    expect(await cacheSize()).toEqual({ entries: 0, bytes: 0 });
    // The saved analysis is still there.
    expect(store.has('callscore:analysis:1')).toBe(true);
  });

  it('degrades to a no-op when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(setTranscript('abc', 'm', undefined, { pieces: ['x'], seconds: [1] })).resolves.toBeUndefined();
    await expect(getTranscript('abc', 'm')).resolves.toBeUndefined();
    await expect(cacheSize()).resolves.toEqual({ entries: 0, bytes: 0 });
  });
});