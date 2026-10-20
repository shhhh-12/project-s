import { z } from 'zod';
import type { Speaker } from '../domain';
import { chatJson, RouterError, type Usage } from './openrouter';
import { chunkText } from './transcript';

export function speakerOf(value: unknown): Speaker {
  const s = String(value ?? '').toLowerCase();
  if (/rep|agent|sales|advisor|executive|staff|company|business|seller/.test(s)) return 'rep';
  if (/cust|client|lead|prospect|buyer|user|caller|enquir|inquir/.test(s)) return 'customer';
  return 'unknown';
}

/**
 * The model only ever returns a label per numbered sentence. It never re-types the transcript, so it cannot drop,
 * merge or reword anything, and there is no "the words changed" failure to recover from. Each label can be an
 * object {i, speaker} or (for lazier models) a bare "rep"/"customer" string in order.
 */
const schema = z.object({
  labels: z.array(
    z.union([
      z.object({ i: z.coerce.number(), speaker: z.unknown().transform(speakerOf) }),
      z.string().transform((s) => ({ i: undefined as number | undefined, speaker: speakerOf(s) })),
    ]),
  ),
});

const system = `You label who is speaking in a phone-call transcript between a sales representative ("rep": the person who speaks for the business, usually greets first and introduces the company) and a customer ("customer": the person enquiring about or buying the product).
The transcript came from speech-to-text and has NO speaker labels. It has been split into numbered sentences. Label EVERY sentence.
Rules:
- Return one label per numbered sentence, using the sentence's own number. Do not copy, translate or change any text.
- The text is Tamil, English or mixed Tamil-English (Tanglish).
- Speakers usually alternate, but one person can say several sentences in a row. Use conversational cues: who greets and introduces the company, who asks about price or plans, who answers, who is selling.
Return ONLY JSON: {"labels":[{"i":1,"speaker":"rep"},{"i":2,"speaker":"customer"}]}`;

export type DiarizedTurn = { speaker: Speaker; text: string };

const SEGMENT_MAX = 240;

/** Splits text into sentence-sized segments without changing any word. Over-long sentences are cut at commas, then by word count. */
export function splitSegments(text: string): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.?!।॥…])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= SEGMENT_MAX) {
      out.push(sentence);
      continue;
    }
    let current = '';
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
      if (clause.length > SEGMENT_MAX) {
        if (current) out.push(current);
        current = '';
        const words = clause.split(' ');
        for (let i = 0; i < words.length; i += 30) out.push(words.slice(i, i + 30).join(' '));
      } else if (current && current.length + 1 + clause.length > SEGMENT_MAX) {
        out.push(current);
        current = clause;
      } else current = current ? `${current} ${clause}` : clause;
    }
    if (current) out.push(current);
  }
  return out;
}

/** Turns a label per segment into turns: consecutive segments from the same speaker join into one turn. */
export function groupTurns(segments: string[], speakers: Speaker[]): DiarizedTurn[] {
  const turns: DiarizedTurn[] = [];
  segments.forEach((segment, index) => {
    const speaker = speakers[index] ?? 'unknown';
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) last.text += ` ${segment}`;
    else turns.push({ speaker, text: segment });
  });
  return turns;
}

/** Reads the model's labels back into one speaker per segment. Returns undefined when too few segments were labelled to trust. */
function readLabels(labels: Array<{ i?: number; speaker: Speaker }>, count: number): Speaker[] | undefined {
  const bySegment: Array<Speaker | undefined> = new Array(count).fill(undefined);
  const indexed = labels.every((l) => typeof l.i === 'number' && Number.isFinite(l.i));
  labels.forEach((label, position) => {
    const at = indexed ? (label.i as number) - 1 : position;
    if (at >= 0 && at < count && label.speaker !== 'unknown') bySegment[at] = label.speaker;
  });
  const labelled = bySegment.filter(Boolean).length;
  if (labelled < Math.ceil(count * 0.8)) return undefined;
  // A skipped sentence belongs to whoever was speaking just before it (or just after, at the very start).
  const firstKnown = bySegment.find(Boolean) as Speaker;
  let carry: Speaker = firstKnown;
  return bySegment.map((speaker) => {
    if (speaker) carry = speaker;
    return carry;
  });
}

/**
 * Adds speaker labels to an unlabeled transcript. The text itself is never rewritten here: a piece the model cannot
 * label is kept as one unlabeled turn instead of failing the whole analysis.
 */
export async function diarize(
  key: string,
  model: string,
  text: string,
  options: { repName?: string; signal?: AbortSignal; onProgress?: (detail: string) => void; onUsage?: (usage: Usage, info: { part: number; parts: number; attempt: number }) => void } = {},
) {
  const pieces = chunkText(text);
  const turns: DiarizedTurn[] = [];
  let failed = 0;
  let previous: Speaker | 'none' = 'none';

  for (let index = 0; index < pieces.length; index++) {
    const segments = splitSegments(pieces[index]);
    options.onProgress?.(pieces.length > 1 ? `Part ${index + 1} of ${pieces.length}` : '');
    const numbered = segments.map((segment, i) => `${i + 1}. ${segment}`).join('\n');
    const user = `Speaker of the previous sentence: ${previous}\n${options.repName ? `Rep name (hint): ${options.repName}\n` : ''}NUMBERED SENTENCES (${segments.length}):\n${numbered}`;
    let speakers: Speaker[] | undefined;
    for (let attempt = 0; attempt < 2 && !speakers; attempt++) {
      try {
        const { data, usage } = await chatJson(key, model, system, user, schema, options.signal);
        options.onUsage?.(usage, { part: index + 1, parts: pieces.length, attempt: attempt + 1 });
        speakers = readLabels(data.labels, segments.length);
      } catch (error) {
        // Only "the model answered badly" is retried/skipped; auth, credit and network errors must surface.
        if (!(error instanceof RouterError && error.status === 502)) throw error;
      }
    }
    if (speakers) {
      turns.push(...groupTurns(segments, speakers));
      previous = speakers[speakers.length - 1];
    } else {
      failed++;
      turns.push({ speaker: 'unknown', text: segments.join(' ') });
    }
  }
  return { turns, failed, pieces: pieces.length };
}
