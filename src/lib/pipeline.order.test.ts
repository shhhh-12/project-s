import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis } from './pipeline';
import { bytesHash, getTranscript } from './cache';
import { retimeTurns } from './transcript';

const cacheStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => cacheStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => void cacheStore.set(key, value)),
  del: vi.fn(async (key: string) => void cacheStore.delete(key)),
  keys: vi.fn(async () => [...cacheStore.keys()]),
}));

// Chunks finish in a scrambled order; scoring is stopped right after retiming, so only the transcription stage is exercised.
const delays = [40, 5, 20, 1];
vi.mock('./openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openrouter')>()),
  transcribe: vi.fn(async (_key: string, _model: string, chunk: { start: number }) => {
    const i = chunk.start / 60;
    await new Promise((resolve) => setTimeout(resolve, delays[i] + Math.random() * 5));
    return i === 2 ? '   ' : `Rep: line number ${i}`;
  }),
  chatJson: vi.fn(async () => {
    throw new Error('stop after transcription');
  }),
}));
vi.mock('./transcript', async (importOriginal) => {
  const real = await importOriginal<typeof import('./transcript')>();
  return { ...real, retimeTurns: vi.fn(real.retimeTurns) };
});

beforeEach(() => {
  cacheStore.clear();
  vi.stubGlobal('indexedDB', {});
  vi.mocked(retimeTurns).mockClear();
});

const audioFile = new File([new Uint8Array(4)], 'call.mp3', { type: 'audio/mpeg' });
const deps = {
  prepareAudio: async () => ({
    duration: 240,
    converted: true,
    chunks: [0, 60, 120, 180].map((start) => ({ data: 'AA==', format: 'wav', start, end: start + 60 })),
  }),
};

describe('parallel transcription keeps chunk order', () => {
  it('orders windows by chunk, skips the empty chunk, and caches aligned arrays', async () => {
    await expect(
      runAnalysis({ key: 'k', models: { transcribe: 'stt', understand: 'llm', prep: '' }, text: '', audio: audioFile, onProgress: () => undefined, deps }),
    ).rejects.toThrow('stop after transcription');

    const windows = vi.mocked(retimeTurns).mock.calls[0][1];
    expect(windows.map((w) => w.start)).toEqual([0, 60, 180]); // chunk 2 (empty) is gone, order is by chunk
    expect(windows.every((w, i) => i === 0 || w.start > windows[i - 1].start)).toBe(true);

    const cached = await getTranscript(await bytesHash(await audioFile.arrayBuffer()), 'stt', undefined);
    expect(cached?.pieces).toEqual(['Rep: line number 0', 'Rep: line number 1', 'Rep: line number 3']);
    expect(cached?.seconds).toEqual([60, 60, 60]);
    expect(cached?.pieces.length).toBe(windows.length);
  });
});
