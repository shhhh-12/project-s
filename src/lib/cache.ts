// Local cache for expensive model calls.
//
// Re-running the same recording should not cost money twice. Two layers are cached separately
// because they are reusable independently of each other:
//   - the transcript, keyed by the audio bytes + speech-to-text model + language
//   - the final report, keyed by the transcript + analysis model + prompt version
//
// Anything stored here is derived from the user's own recordings, so it lives in the same
// IndexedDB store as the analyses themselves. Nothing secret is written.

import { get, set, del, keys } from 'idb-keyval';

const PREFIX = 'callscore:cache:';
const VERSION = '1';

const enc = new TextEncoder();

/**
 * Caching is an optimisation, never a requirement. IndexedDB is missing in some private-browsing
 * modes (and in the test environment), so every entry point degrades to a no-op instead of
 * failing an analysis that would otherwise succeed.
 */
const available = () => typeof indexedDB !== 'undefined';

/** SHA-256 over the bytes, hex-encoded. Used for audio fingerprints and text fingerprints alike. */
async function digest(input: BufferSource): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export const textHash = (value: string) => digest(enc.encode(value));

export const bytesHash = (value: ArrayBuffer) => digest(value);

/** Cache key: a fingerprint of the inputs plus everything that would change the answer. */
const keyFor = (...parts: (string | undefined)[]) => PREFIX + [VERSION, ...parts.map((p) => p ?? '')].join(':');

export type CachedTranscript = {
  pieces: string[];
  seconds: number[];
  /** Optional so recordings cached by older app versions remain readable. */
  nativeSpeakerSegments?: Array<{ text: string; start: number; end: number; speaker: string }>;
};

export async function getTranscript(audioHash: string, model: string, language?: string) {
  if (!available()) return undefined;
  return get<CachedTranscript>(keyFor('audio', audioHash, model, language)).catch(() => undefined);
}

export async function setTranscript(audioHash: string, model: string, language: string | undefined, value: CachedTranscript) {
  if (!available()) return;
  await set(keyFor('audio', audioHash, model, language), value).catch(() => undefined);
}

/** A completed report, keyed on the transcript it was produced from. */
export async function getReport(textHashValue: string, model: string, promptVersion: string, variant: string) {
  if (!available()) return undefined;
  return get<{ a: unknown; b?: unknown }>(keyFor('report', textHashValue, model, promptVersion, variant)).catch(() => undefined);
}

export async function setReport(textHashValue: string, model: string, promptVersion: string, variant: string, value: unknown) {
  if (!available()) return;
  await set(keyFor('report', textHashValue, model, promptVersion, variant), value).catch(() => undefined);
}

/** Approximate bytes used by the cache, for the Settings readout. */
export async function cacheSize() {
  try {
    const found = await keys();
    const names = found.filter((key): key is string => typeof key === 'string' && key.startsWith(PREFIX));
    let bytes = 0;
    for (const name of names) {
      const value = await get(name);
      if (value) bytes += JSON.stringify(value).length;
    }
    return { entries: names.length, bytes };
  } catch {
    return { entries: 0, bytes: 0 };
  }
}

export async function clearCache() {
  if (!available()) return;
  const found = await keys();
  await Promise.all(
    found.filter((key): key is string => typeof key === 'string' && key.startsWith(PREFIX)).map((key) => del(key)),
  ).catch(() => undefined);
}
