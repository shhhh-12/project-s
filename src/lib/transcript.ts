import type { Analysis, Speaker } from '../domain';

export type ParsedTurn = Analysis['transcript'][number];
export type TimeWindow = { chars: number; start: number; end: number };
export const UNKNOWN_NAME = 'Unknown speaker';

/** m:ss for any number of seconds (never produces "1:60"). */
export const formatClock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Seconds for "m:ss", "h:mm:ss" or SRT-style "00:00:01,500"; 0 when it cannot be read. */
export const parseClock = (value: string) => {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
};

export const roleOf = (name: string): Speaker =>
  /\b(customer|caller|lead|prospect|client|buyer)\b/i.test(name)
    ? 'customer'
    : /\b(rep|agent|advisor|executive|sales)\b/i.test(name)
      ? 'rep'
      : 'unknown';

export const normalizeTranscript = (value: string) =>
  value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// A speaker label is a SHORT prefix (max 3 words) followed by a colon and a space: "Rep:", "Customer (Priya):".
// Hyphens, dashes and colons inside normal sentences ("5:30", "500-600") are NOT labels.
const LABEL = /^\[?([\p{L}][\p{L}\p{N} ._()'’-]{0,29}?)\]?\s*[:：]\s+(\S.*)$/u;
const VOICE = /^<v\.?[^\s>]*\s+([^>]+)>\s*(.*)$/;
const stripTags = (value: string) => value.replace(/<[^>]+>/g, '').trim();

function splitLabel(raw: string) {
  const voice = VOICE.exec(raw);
  if (voice) return { name: voice[1].trim(), text: stripTags(voice[2]) };
  const label = LABEL.exec(raw);
  if (label && label[1].trim().split(/\s+/).length <= 3) return { name: label[1].trim(), text: stripTags(label[2]) };
  return { name: UNKNOWN_NAME, text: stripTags(raw) };
}

export function parseTranscript(text: string, type?: 'srt' | 'vtt' | 'txt'): ParsedTurn[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  const timed = type ? type !== 'txt' : /-->/.test(clean);

  if (!timed) {
    return clean
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const { name, text: body } = splitLabel(line);
        return {
          id: String(index),
          speaker: roleOf(name),
          name,
          start: index * 10,
          end: index * 10 + 8,
          text: body || line,
        };
      });
  }

  const turns: ParsedTurn[] = [];
  const blocks = clean.replace(/^WEBVTT[^\n]*\n?/, '').trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue; // NOTE blocks, style blocks, stray indexes
    const [from, to] = lines[at].split('-->');
    const raw = lines.slice(at + 1).join(' ');
    const { name, text: body } = splitLabel(raw);
    turns.push({
      id: String(turns.length),
      speaker: roleOf(name),
      name,
      start: parseClock(from),
      end: parseClock(to.trim().split(/\s+/)[0]),
      text: body || raw,
    });
  }
  return turns;
}

export const hasSpeakerLabels = (turns: ParsedTurn[]) => turns.some((turn) => turn.name !== UNKNOWN_NAME);

/**
 * Finds where a quote sits in the transcript. A quote is supported when every fragment of it (split on "...")
 * appears, after normalization, in the transcript; quotes that span two turns are accepted. Returns the turn
 * where the first fragment starts, or null when the quote is empty, too short, or any fragment is missing.
 */
export function locateQuote(quote: string, turns: ParsedTurn[]): { turnIndex: number } | null {
  const fragments = quote
    .split(/…|\.{3}|\[\.\.\.\]/)
    .map(normalizeTranscript)
    .filter((fragment) => fragment.length > 0);
  if (!fragments.length || fragments.join('').length < 2) return null;
  const texts = turns.map((turn) => normalizeTranscript(turn.text));
  const haystack = texts.join(' ');
  if (!fragments.every((fragment) => haystack.includes(fragment))) return null;
  const at = haystack.indexOf(fragments[0]);
  let offset = 0;
  for (let turnIndex = 0; turnIndex < texts.length; turnIndex++) {
    if (at < offset + texts[turnIndex].length + 1) return { turnIndex };
    offset += texts[turnIndex].length + 1;
  }
  return null;
}

export const verifyQuote = (quote: string, turns: ParsedTurn[]) => locateQuote(quote, turns) !== null;

/** One window = a stretch of the source text (in characters) that maps to a stretch of audio (in seconds). */
export function estimateWindows(text: string, knownDuration = 0): TimeWindow[] {
  const words = text.split(/\s+/).filter(Boolean).length;
  const end = knownDuration > 0 ? knownDuration : Math.max(5, words / 2.5);
  return [{ chars: Math.max(1, text.length), start: 0, end }];
}

/** Spread turn start/end times across the known audio windows, proportionally to text length. */
export function retimeTurns<T extends { text: string; start: number; end: number }>(turns: T[], windows: TimeWindow[]): T[] {
  const usable = windows.filter((window) => window.chars > 0);
  if (!turns.length || !usable.length) return turns;
  const weights = turns.map((turn) => turn.text.length + 1);
  const scale = usable.reduce((n, w) => n + w.chars, 0) / weights.reduce((n, w) => n + w, 0);
  const timeAt = (char: number) => {
    let from = 0;
    for (const window of usable) {
      if (char <= from + window.chars) return window.start + ((char - from) / window.chars) * (window.end - window.start);
      from += window.chars;
    }
    return usable[usable.length - 1].end;
  };
  const round = (n: number) => Math.round(n * 10) / 10;
  let cursor = 0;
  return turns.map((turn, index) => {
    const start = timeAt(cursor * scale);
    cursor += weights[index];
    const end = timeAt((cursor - 1) * scale);
    return { ...turn, start: round(start), end: round(Math.max(start, end)) };
  });
}

/** Split text into pieces of at most `max` characters, preferring sentence boundaries. */
export function chunkText(text: string, max = 2500): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?।॥])\s+/)
    .filter(Boolean);
  const out: string[] = [];
  let current = '';
  const push = (piece: string) => {
    if (current && current.length + 1 + piece.length > max) {
      out.push(current);
      current = piece;
    } else current = current ? `${current} ${piece}` : piece;
  };
  for (const sentence of sentences) {
    if (sentence.length <= max) push(sentence);
    else sentence.split(' ').forEach(push);
  }
  if (current) out.push(current);
  return out;
}
