import type { Analysis, Severity } from '../domain';
import { RUBRIC } from '../config/rubric';
import { formatClock, parseClock } from './transcript';

type Turn = Analysis['transcript'][number];

/** A character range [start, end) inside one turn's text. */
export type Span = [number, number];

const isWord = (ch: string) => /[\p{L}\p{M}\p{N}]/u.test(ch);

/** Lower-cased text with punctuation and runs of spaces collapsed, plus a map from each kept character back to its original index. */
function squash(text: string) {
  let out = '';
  const map: number[] = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isWord(ch)) {
      if (gap && out) {
        out += ' ';
        map.push(i - 1);
      }
      gap = false;
      const lower = ch.toLowerCase();
      for (let k = 0; k < lower.length; k++) {
        out += lower[k];
        map.push(i);
      }
    } else gap = true;
  }
  return { out, map };
}

/**
 * Finds where a quote sits inside a line. Tolerates differences in case, punctuation and spacing, and quotes written with
 * "..." (every fragment that is found is returned). An empty list means the quote is not in this line.
 */
export function findSpans(text: string, quote: string): Span[] {
  const fragments = quote
    .split(/…|\.{3}|\[\.\.\.\]/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (!fragments.length) return [];
  const haystack = squash(text);
  const spans: Span[] = [];
  for (const fragment of fragments) {
    const needle = squash(fragment).out;
    if (needle.length < 2) continue;
    const at = haystack.out.indexOf(needle);
    if (at < 0) continue;
    const start = haystack.map[at];
    const end = haystack.map[at + needle.length - 1] + 1;
    if (end > start) spans.push([start, end]);
  }
  return spans;
}

/** The turn a "m:ss" timestamp points at: an exact start match, else the last turn that began before it. */
export function turnForTimestamp(turns: Turn[], timestamp: string): Turn | undefined {
  if (!turns.length || !/\d/.test(timestamp)) return undefined;
  const seconds = parseClock(timestamp.replace(/[[\]]/g, ''));
  const exact = turns.find((t) => formatClock(t.start) === formatClock(seconds));
  if (exact) return exact;
  let found: Turn | undefined;
  for (const turn of turns) if (turn.start <= seconds + 0.5) found = turn;
  return found;
}

export type Annotation = {
  id: string;
  kind: 'mistake' | 'evidence';
  severity: Severity;
  category: string;
  what: string;
  better: string;
  timestamp: string;
  quote: string;
  /** Turn this annotation is attached to, or undefined when it could not be placed on any line. */
  turnId?: string;
  spans: Span[];
};

const criterionName = (id: string) => RUBRIC.criteria.find((c) => c.id === id)?.name ?? id.replaceAll('_', ' ');
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };

/** Picks the turn that contains the quote; if several do, the one closest to the stated timestamp. */
function place(turns: Turn[], quote: string, timestamp: string) {
  const hits = quote.trim()
    ? turns.map((turn) => ({ turn, spans: findSpans(turn.text, quote) })).filter((h) => h.spans.length > 0)
    : [];
  const target = turnForTimestamp(turns, timestamp);
  if (hits.length) {
    const best = (target && hits.find((h) => h.turn.id === target.id)) ?? hits.reduce((a, b) => (Math.abs(a.turn.start - (target?.start ?? a.turn.start)) <= Math.abs(b.turn.start - (target?.start ?? b.turn.start)) ? a : b));
    return { turnId: best.turn.id, spans: best.spans };
  }
  // The exact words could not be located (quote spans two turns, or was lightly reworded): mark the whole line.
  return { turnId: target?.id, spans: [] as Span[] };
}

/**
 * Everything worth marking on the transcript: the model's explicit mistakes, its red flags, and (as a fallback for
 * calls analysed before mistakes existed) the evidence behind weakly-scored criteria. Positive scoring evidence is
 * returned as 'evidence'. Each item is attached to the line it belongs to.
 */
export function buildAnnotations(analysis: Analysis): Annotation[] {
  const turns = analysis.transcript;
  const items: Annotation[] = [];
  let n = 0;
  const add = (a: Omit<Annotation, 'id' | 'turnId' | 'spans'>) => items.push({ ...a, id: `a${n++}`, ...place(turns, a.quote, a.timestamp) });

  for (const m of analysis.mistakes) {
    add({
      kind: 'mistake',
      severity: m.severity,
      category: m.category || (m.criterion ? criterionName(m.criterion) : 'Mistake'),
      what: m.what_went_wrong,
      better: m.better_alternative,
      timestamp: m.timestamp,
      quote: m.quote,
    });
  }
  for (const flag of analysis.red_flags) {
    add({
      kind: 'mistake',
      severity: 'critical',
      category: `Red flag: ${flag.type || 'issue'}`,
      what: 'This was flagged as a red flag in the call.',
      better: '',
      timestamp: flag.timestamp,
      quote: flag.quote,
    });
  }
  const explicit = analysis.mistakes.length > 0;
  for (const criterion of analysis.criteria) {
    const weak = criterion.score !== null && criterion.score < 2;
    for (const e of criterion.evidence) {
      if (e.evidence_type === 'absence' || !e.quote.trim()) continue;
      // With explicit mistakes available, weak-criterion quotes are shown as context rather than repeated as mistakes.
      if (weak && !explicit) {
        add({
          kind: 'mistake',
          severity: criterion.score === 0 ? 'major' : 'minor',
          category: criterionName(criterion.id),
          what: criterion.reasoning,
          better: '',
          timestamp: e.timestamp,
          quote: e.quote,
        });
      } else {
        add({
          kind: 'evidence',
          severity: 'minor',
          category: criterionName(criterion.id),
          what: criterion.reasoning,
          better: '',
          timestamp: e.timestamp,
          quote: e.quote,
        });
      }
    }
  }

  // The same words flagged twice (say a mistake and a red flag) should not be shown twice on one line.
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.kind}|${item.turnId ?? item.timestamp}|${item.quote.trim().toLowerCase()}|${item.category.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.kind === b.kind ? SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] : a.kind === 'mistake' ? -1 : 1));
}

export type Segment = { text: string; annotation?: Annotation };

/** Cuts a line into plain and highlighted segments. Overlapping ranges keep the more severe annotation. */
export function segmentLine(text: string, annotations: Annotation[]): Segment[] {
  const ranges = annotations
    .flatMap((annotation) => annotation.spans.map((span) => ({ span, annotation })))
    .sort((a, b) => a.span[0] - b.span[0] || SEVERITY_RANK[a.annotation.severity] - SEVERITY_RANK[b.annotation.severity]);
  const out: Segment[] = [];
  let cursor = 0;
  for (const { span, annotation } of ranges) {
    const [start, end] = span;
    if (start < cursor) continue; // overlaps something already highlighted
    if (start > cursor) out.push({ text: text.slice(cursor, start) });
    out.push({ text: text.slice(start, end), annotation });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out.length ? out : [{ text }];
}

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', major: 'Major', minor: 'Minor' };
