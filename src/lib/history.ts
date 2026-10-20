import { get, set, del, keys } from 'idb-keyval';
import { AnalysisSchema, type Analysis } from '../domain';

const prefix = 'callscore:analysis:';
const audioPrefix = 'callscore:audio:';

export async function saveAnalysis(a: Analysis) {
  await set(prefix + a.id, a);
}
export async function loadAnalysis(id: string) {
  const value = await get<unknown>(prefix + id);
  return AnalysisSchema.parse(value);
}
export async function listAnalyses() {
  const found = (await keys()).filter((key): key is string => typeof key === 'string' && key.startsWith(prefix));
  const records = await Promise.all(
    found.map(async (key) => {
      try {
        return await loadAnalysis(key.slice(prefix.length));
      } catch {
        return undefined; // skip malformed records instead of breaking history
      }
    }),
  );
  return records.filter((record): record is Analysis => Boolean(record));
}
export async function deleteAnalysis(id: string) {
  await del(prefix + id);
  await del(audioPrefix + id);
}
/** The recording is kept next to the analysis so the transcript can be played back. */
export async function saveAudio(id: string, file: Blob) {
  await set(audioPrefix + id, file);
}
export async function loadAudio(id: string) {
  return get<Blob>(audioPrefix + id);
}
