import { z } from 'zod';
import { AnalysisSchema, SEVERITIES, criterionIds, type Analysis, type CostItem, type Criterion, type CriterionId } from '../domain';
import { RUBRIC } from '../config/rubric';
import type { ModelSlots } from '../config/models';
import { systemPrompt, PROMPT_VERSION } from '../prompts/analysis';
import { prepareAudio, type PreparedAudio } from './audio';
import { chatCostItem, transcribeCostItem } from './cost';
import { scoreCall } from './scoring';
import { diarize, speakerOf } from './diarize';
import { chatJson, transcribe, type TranscribeUsage } from './openrouter';
import { hasTamilScript, romanizeTamilText } from './romanize';
import { computeAllMetrics } from './metrics';
import { turnForTimestamp } from './mistakes';
import { bytesHash, getReport, getTranscript, setReport, setTranscript, textHash } from './cache';
import {
  estimateWindows,
  formatClock,
  hasSpeakerLabels,
  locateQuote,
  parseTranscript,
  retimeTurns,
  UNKNOWN_NAME,
  type ParsedTurn,
  type TimeWindow,
} from './transcript';

export type StepId = 'prepare' | 'transcribe' | 'romanize' | 'speakers' | 'score' | 'validate';
export const STEP_LABELS: Record<StepId, string> = {
  prepare: 'Preparing audio',
  transcribe: 'Transcribing audio',
  romanize: 'Converting to Thanglish',
  speakers: 'Identifying speakers',
  score: 'Scoring against the rubric',
  validate: 'Validating evidence',
};
export const stepsFor = (hasAudio: boolean): StepId[] => (hasAudio ? ['prepare', 'transcribe', 'romanize', 'speakers', 'score', 'validate'] : ['romanize', 'speakers', 'score', 'validate']);
export type Progress = (step: StepId, detail?: string) => void;
export type CallContext = { repName: string; product: string; vocabulary: string; enquiredAt: string; calledAt: string };
/** Context fields that are passed to the model as hints. The two times are only used for the Speed to lead metric. */
const HINT_FIELDS = ['repName', 'product', 'vocabulary'] as const;

/** Run tasks with a concurrency limit, preserving order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// The model's answer is parsed leniently (coerce, default, trim) and then validated by our own code.
// A model that is slightly off-format should still produce a result; a model that invents evidence should not.
const text = (fallback = '') => z.preprocess((v) => (v == null ? fallback : typeof v === 'string' ? v : String(v)), z.string());
const list = <T extends z.ZodType>(item: T) => z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(item));
const speaker = z.preprocess(speakerOf, z.enum(['rep', 'customer', 'unknown']));
const score = z.preprocess((v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(3, Math.max(0, Math.round(n))) : null;
}, z.number().int().min(0).max(3).nullable());

const count = z.preprocess((v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}, z.number().int().min(0).nullable());
const boolish = z.preprocess((v) => (v === true || /^(true|yes|y)$/i.test(String(v)) ? true : v === false || /^(false|no|n)$/i.test(String(v)) ? false : null), z.boolean().nullable());
const severity = z.preprocess((v) => {
  const s = String(v ?? '').toLowerCase();
  return s.startsWith('crit') || s === 'severe' ? 'critical' : s.startsWith('maj') || s === 'high' || s === 'serious' ? 'major' : 'minor';
}, z.enum(SEVERITIES));
/** Models rename keys now and then; accept the common alternatives for each field of a mistake. */
const mistakeAliases = (v: unknown) => {
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  return {
    ...o,
    category: o.category ?? o.type ?? o.title ?? o.label,
    what_went_wrong: o.what_went_wrong ?? o.issue ?? o.description ?? o.mistake ?? o.explanation ?? o.reason,
    better_alternative: o.better_alternative ?? o.better_response ?? o.suggestion ?? o.try_instead ?? o.fix,
    quote: o.quote ?? o.text ?? o.evidence,
    timestamp: o.timestamp ?? o.time ?? o.at,
  };
};
const callFacts = z.preprocess(
  (v) => (v && typeof v === 'object' ? v : undefined),
  z
    .object({
      rep_questions: count,
      customer_questions: count,
      next_step: z.preprocess((v) => (v && typeof v === 'object' ? v : {}), z.object({ set: boolish, detail: text(), timestamp: text() })),
      customer_sentiment: z.preprocess((v) => {
        const s = String(v ?? '').toLowerCase();
        return s.startsWith('pos') ? 'positive' : s.startsWith('neg') ? 'negative' : s.startsWith('neu') || s === 'mixed' ? 'neutral' : 'unknown';
      }, z.enum(['positive', 'neutral', 'negative', 'unknown'])),
      outcome: text(),
    })
    .optional(),
);

const reportSchema = z.object({
  title: text(),
  product: text(),
  summary: text(),
  context_line: text(),
  rep: text('Rep'),
  customer: text('Customer'),
  call_type: text('inbound_lead'),
  segment: text('b2c'),
  language: text(),
  confidence: z.preprocess((v) => (['high', 'medium', 'low'].includes(String(v).toLowerCase()) ? String(v).toLowerCase() : 'medium'), z.enum(['high', 'medium', 'low'])),
  criteria: list(
    z.object({
      id: text(),
      score,
      reasoning: text(),
      evidence: list(
        z.object({
          quote: text(),
          timestamp: text(),
          speaker,
          evidence_type: z.preprocess((v) => (v === 'absence' ? 'absence' : 'quote'), z.enum(['quote', 'absence'])),
        }),
      ),
    }),
  ),
  red_flags: list(z.object({ type: text(), quote: text(), timestamp: text() })),
  strengths: list(text()).transform((items) => items.filter(Boolean).slice(0, 3)),
  improvements: list(text()).transform((items) => items.filter(Boolean).slice(0, 3)),
  try_saying: text(),
  mistakes: list(
    z.preprocess(
      mistakeAliases,
      z.object({ timestamp: text(), quote: text(), category: text(), severity, what_went_wrong: text(), better_alternative: text(), criterion: text() }),
    ),
  ),
  call_facts: callFacts,
  objections: list(z.object({ type: text(), quote: text(), timestamp: text(), response: text(), verdict: text(), better_response: text() })),
});
type Report = z.infer<typeof reportSchema>;

const aborted = () => new DOMException('The analysis was cancelled.', 'AbortError');
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const criterionName = (id: CriterionId) => RUBRIC.criteria.find((c) => c.id === id)?.name ?? id;
/** A date-time typed into the form (or an ISO string) as an ISO string; undefined when empty or unreadable. */
const isoOrUndefined = (value?: string) => {
  if (!value?.trim()) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export type RunOptions = {
  key: string;
  models: ModelSlots;
  text: string;
  audio?: File;
  context?: Partial<CallContext>;
  /** ISO-639-1 code for the speech-to-text model; empty = auto-detect. */
  language?: string;
  /** Score twice and flag disagreements. Doubles the scoring cost. */
  doubleScore?: boolean;
  signal?: AbortSignal;
  onProgress: Progress;
  /** Test seam: replaces browser audio decoding. */
  deps?: { prepareAudio?: (file: File, signal?: AbortSignal) => Promise<PreparedAudio> };
};

/** Build the same criteria shape the validator produces, but without quote verification — used to total each scoring run. */
function criteriaOf(report: Report): Criterion[] {
  return criterionIds.map((id) => {
    const found = report.criteria.find((c) => c.id.trim().toLowerCase() === id);
    return { id, score: found?.score ?? null, reasoning: found?.reasoning ?? '', evidence: [], verified: true };
  });
}

const scoreOf = (report: Report, id: CriterionId) => report.criteria.find((c) => c.id.trim().toLowerCase() === id)?.score ?? null;

/** Compares two scoring runs and records what a human should look at. */
function buildDoubleRun(a: Report, b: Report, warnings: string[]): NonNullable<Analysis['double_run']> {
  const run_a = Object.fromEntries(criterionIds.map((id) => [id, scoreOf(a, id)])) as Record<string, number | null>;
  const run_b = Object.fromEntries(criterionIds.map((id) => [id, scoreOf(b, id)])) as Record<string, number | null>;
  const disagreements = criterionIds.filter((id) => {
    const x = run_a[id];
    const y = run_b[id];
    return x !== null && y !== null && Math.abs(x - y) > 1;
  });
  const totals = [scoreCall(criteriaOf(a)).total, scoreCall(criteriaOf(b)).total];
  const total_range = Math.abs(totals[0] - totals[1]);
  if (disagreements.length) {
    warnings.push(`The two scoring runs disagreed by more than one point on ${disagreements.map(criterionName).join(', ')}. A sales lead should review ${disagreements.length === 1 ? 'this criterion' : 'these criteria'}.`);
  }
  if (total_range > 0) {
    warnings.push(`The two scoring runs finished ${total_range.toFixed(1)} points apart (${Math.min(...totals).toFixed(1)} to ${Math.max(...totals).toFixed(1)}).`);
  }
  return { run_a, run_b, disagreements, total_range };
}

export async function runAnalysis({ key, models, text: pasted, audio, context, language, doubleScore = false, signal, onProgress, deps }: RunOptions): Promise<Analysis> {
  const warnings: string[] = [];
  let source = pasted.trim();
  let windows: TimeWindow[] | undefined;
  let audioDuration = 0;
  const costs: CostItem[] = [];
  const speechCalls: Array<{ label: string; seconds: number; usage: TranscribeUsage }> = [];
  const timings: Record<string, number> = {};
  const timed = <T>(step: StepId, label: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    onProgress(step);
    return fn().finally(() => { timings[label] = Math.round(performance.now() - start); });
  };

  if (audio) {
    if (!models.transcribe) throw new Error('Choose a transcription model in Settings.');

    // Fingerprint the recording so an identical file skips transcription entirely.
    let parts: string[];
    let audioHash: string | undefined;
    try {
      audioHash = await bytesHash(await audio.arrayBuffer());
    } catch {
      audioHash = undefined; // unreadable buffer: fall through to a normal run
    }
    const cached = audioHash ? await getTranscript(audioHash, models.transcribe, language) : undefined;

    if (cached) {
      onProgress('transcribe', 'Using the transcript cached from this recording');
      parts = cached.pieces;
      source = parts.join(' ');
      audioDuration = cached.seconds.reduce((sum, s) => sum + s, 0);
      let cursor = 0;
      windows = parts.map((piece, i) => {
        const span = cached.seconds[i] ?? 60;
        const window = { chars: piece.length + 1, start: cursor, end: cursor + span };
        cursor += span;
        return window;
      });
      timings['prepare'] = 0;
      timings['transcribe'] = 0;
    } else {
      const prepared = await timed('prepare', 'prepare', () => (deps?.prepareAudio ?? prepareAudio)(audio, signal));
      audioDuration = prepared.duration;

      // Transcribe chunks in parallel (3 at a time) for speed
      const transcribeStarted = performance.now();
      const transcribed = await mapWithLimit(prepared.chunks, 3, async (chunk, i) => {
        if (signal?.aborted) throw aborted();
        const partLabel = prepared.chunks.length > 1 ? `part ${i + 1} of ${prepared.chunks.length}` : 'full call';
        const usage: TranscribeUsage = {};
        const piece = (await transcribe(key, models.transcribe, chunk, { language, signal, onUsage: (u) => Object.assign(usage, u) })).trim();
        const span = chunk.end > chunk.start ? chunk.end - chunk.start : prepared.duration;
        return { chunk, partLabel, piece, span, usage };
      });
      const nonEmpty = transcribed.filter(({ piece }) => Boolean(piece));
      parts = nonEmpty.map(({ piece }) => piece);
      const seconds = nonEmpty.map(({ span }) => span);
      windows = nonEmpty.map(({ chunk, piece }) => ({ chars: piece.length + 1, start: chunk.start, end: chunk.end }));
      speechCalls.push(...transcribed.map(({ partLabel, span, usage }) => ({ label: `Transcription · ${partLabel}`, seconds: span, usage })));
      onProgress('transcribe', `Transcribed ${prepared.chunks.length} part${prepared.chunks.length > 1 ? 's' : ''}`);
      timings['transcribe'] = Math.round(performance.now() - transcribeStarted);
      if (audioHash) await setTranscript(audioHash, models.transcribe, language, { pieces: parts, seconds }).catch(() => undefined);
    }

    if (!parts.some(Boolean)) throw new Error('No speech could be transcribed from this recording. Check the file, or try a different transcription model.');
    source = parts.join(' ');
  }
  if (!source) throw new Error('Add a transcript or choose an audio recording.');
  if (!models.understand) throw new Error('Choose an analysis model in Settings.');

  // ---- Tamil script -> Tanglish -----------------------------------------------------------------------
  // Runs for every input (audio or pasted) so no Tamil letters reach the transcript, the scoring model or the metrics.
  // The model converts distinct words; anything it skips or mangles is converted by built-in rules instead.
  const prepModel = models.prep?.trim() || models.understand;
  if (hasTamilScript(source)) {
    onProgress('romanize', 'Converting Tamil words to Tanglish');
    const converted = await timed('romanize', 'romanize', () =>
      romanizeTamilText(key, prepModel, source, {
        signal,
        onProgress: (detail) => onProgress('romanize', detail),
        onUsage: (u, { part, parts }) => costs.push(chatCostItem('thanglish', `Tanglish conversion${parts > 1 ? ` · part ${part} of ${parts}` : ''}`, prepModel, u)),
      }),
    );
    source = converted.text;
    if (converted.words > 0 && converted.byModel === 0) {
      warnings.push('The model could not convert the Tamil words to Tanglish, so the built-in spelling rules were used. Spellings may look slightly different from usual chat Tanglish.');
    }
  }

  // ---- speakers ----------------------------------------------------------------------------------------
  const defaultRep = context?.repName?.trim() || 'Rep';
  let turns: ParsedTurn[] = parseTranscript(source);
  const hasTimed = /-->/.test(source);
  let diarizationFailed = 0;

  if (hasSpeakerLabels(turns) || hasTimed) {
    onProgress('speakers', 'Using the speaker labels in the transcript');
    timings['speakers'] = 0;
  } else {
    onProgress('speakers');
    const result = await timed('speakers', 'speakers', () =>
      diarize(key, prepModel, source, {
        repName: context?.repName?.trim(),
        signal,
        onProgress: (detail) => onProgress('speakers', detail || undefined),
        onUsage: (u, { part, parts, attempt }) =>
          costs.push(chatCostItem('speakers', `Speaker identification${parts > 1 ? ` · part ${part} of ${parts}` : ''}${attempt > 1 ? ' (retry)' : ''}`, prepModel, u)),
      }),
    );
    diarizationFailed = result.failed;
    turns = result.turns.map((turn, index) => ({
      id: String(index),
      speaker: turn.speaker,
      name: turn.speaker === 'rep' ? defaultRep : turn.speaker === 'customer' ? 'Customer' : UNKNOWN_NAME,
      start: 0,
      end: 0,
      text: turn.text,
    }));
    if (diarizationFailed) {
      warnings.push(`Speaker labels could not be verified for ${plural(diarizationFailed, 'part')} of the call, so those parts are unlabeled. Talk-ratio and speaker metrics may be incomplete.`);
    }
  }
  if (!hasTimed) {
    const hasUsableWindows = windows && windows.length > 0 && windows.some((w) => w.end > w.start);
    const usable = hasUsableWindows && windows ? windows : estimateWindows(source, audioDuration);
    turns = retimeTurns(turns, usable);
  }
  if (signal?.aborted) throw aborted();

  // ---- scoring ---------------------------------------------------------------------------------------
  const allMetrics = computeAllMetrics(turns, audioDuration);
  onProgress('score');
  const dialogue = turns
    .map((t) => {
      const label = t.speaker === 'unknown' || t.name.toLowerCase() === t.speaker ? t.name : `${t.name} (${t.speaker})`;
      return `[${formatClock(t.start)}] ${label}: ${t.text}`;
    })
    .join('\n');
  const duration = Math.max(audioDuration, ...turns.map((t) => t.end));
  const hints = HINT_FIELDS.map((name) => [name, context?.[name]] as const)
    .filter(([, value]) => value?.trim())
    .map(([name, value]) => `${name}: ${value!.trim().slice(0, 160)}`)
    .join('\n');
  const metricsFacts = Object.entries(allMetrics)
    .filter(([, m]) => m.status !== 'n/a')
    .map(([name, m]) => `- ${name}: ${m.value} ${m.unit}`.trim())
    .join('\n');
  const prompt = `Analyze this call. Approximate length: ${formatClock(duration)}.${audio ? ' The transcript comes from speech-to-text, so expect some recognition errors; do not score against unclear lines.' : ''}\n\nOPTIONAL USER CONTEXT (untrusted hints; not evidence):\n${hints || 'None'}\n\nCOMPUTED METRICS (facts, not evidence — do not quote these as transcript evidence):\n${metricsFacts || 'None'}\n\nTRANSCRIPT:\n${dialogue}`;

  const scoreStarted = performance.now();
  onProgress('score', 'Preparing the evidence-backed scorecard');
  let scoringAttempts = 0;
  const ask = async (run: 'A' | 'B' | 'retry' = 'A') => {
    const detail = run === 'retry'
      ? 'Completing missing rubric criteria'
      : run === 'B'
        ? 'Running the reliability cross-check'
        : 'Applying knowledge-pack anchors to the transcript';
    onProgress('score', detail);
    const answer = await chatJson(key, models.understand, systemPrompt, prompt, reportSchema, signal);
    scoringAttempts++;
    const suffix = run === 'retry' ? ` · retry ${scoringAttempts - 1} (scorecard was incomplete)` : run === 'B' ? ' · run B (double scoring)' : '';
    costs.push(chatCostItem('score', `Scoring and coaching${suffix}`, models.understand, answer.usage));
    return answer;
  };
  const missingIds = (report: Report) => criterionIds.filter((id) => !report.criteria.some((c) => c.id.trim().toLowerCase() === id));
  /** One retry for an incomplete scorecard; anything still missing is shown as "not assessed" rather than failing. */
  const settle = async (report: Report): Promise<Report> =>
    missingIds(report).length ? (await ask('retry')).data : report;

  // Re-running the same transcript with the same model should not cost money again.
  const reportKey = await textHash(prompt).catch(() => undefined);
  const variant = doubleScore ? 'double' : 'single';
  const cachedReport = reportKey ? ((await getReport(reportKey, models.understand, PROMPT_VERSION, variant).catch(() => undefined)) as { a: Report; b?: Report } | undefined) : undefined;

  let data: Report;
  let doubleRun: Analysis['double_run'];
  if (cachedReport) {
    onProgress('score', 'Using the cached report for this transcript');
    data = cachedReport.a;
    warnings.push('This transcript and scoring model had already been analysed in this browser, so the saved result was reused and nothing was charged.');
    if (cachedReport.b) {
      doubleRun = buildDoubleRun(cachedReport.a, cachedReport.b, warnings);
    }
    timings['score'] = 0;
  } else if (doubleScore) {
    // Score twice in parallel: catches criteria where the model is unreliable.
    const [a, b] = await Promise.all([ask('A').then((r) => settle(r.data)), ask('B').then((r) => settle(r.data))]);
    if (reportKey) await setReport(reportKey, models.understand, PROMPT_VERSION, variant, { a, b }).catch(() => undefined);
    doubleRun = buildDoubleRun(a, b, warnings);
    // Use the run with fewer missing criteria as the report of record.
    data = missingIds(a).length <= missingIds(b).length ? a : b;
  } else {
    data = await settle((await ask('A')).data);
    if (reportKey) await setReport(reportKey, models.understand, PROMPT_VERSION, variant, { a: data }).catch(() => undefined);
  }
  timings['score'] = Math.round(performance.now() - scoreStarted);

  // ---- evidence validation ---------------------------------------------------------------------------
  const validateStarted = performance.now();
  onProgress('validate', 'Checking every cited quote against the transcript');
  // Every quote the model cites must be located in the transcript. Removals are recorded with a short reason and
  // reported per criterion or section below, so the reader can see what was lost and why.
  const removed = new Map<string, Map<string, number>>();
  const drop = (where: string, reason: string) => {
    const reasons = removed.get(where) ?? new Map<string, number>();
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    removed.set(where, reasons);
  };
  const NOT_FOUND = 'could not be found in the transcript';
  // Words from the wrong side of the call are a misattribution. An 'unknown' turn (speaker labels failed) cannot be
  // contradicted, so it passes rather than discarding everything on an unlabeled call.
  const wrongSide = (turn: ParsedTurn, expected: 'rep' | 'customer') =>
    turn.speaker !== 'unknown' && turn.speaker !== expected ? `was said by the ${turn.speaker}, not the ${expected}` : undefined;
  /** The turn where the quote starts, or undefined (and a recorded reason) when it is absent or said by the wrong speaker. */
  const locate = (quote: string, expected: 'rep' | 'customer' | null, where: string, what = '') => {
    const prefix = what ? `${what} ` : '';
    const found = locateQuote(quote, turns);
    if (!found) {
      drop(where, `${prefix}${NOT_FOUND}`);
      return undefined;
    }
    const turn = turns[found.turnIndex];
    const wrong = expected ? wrongSide(turn, expected) : undefined;
    if (wrong) {
      drop(where, `${prefix}${wrong}`);
      return undefined;
    }
    return turn;
  };
  const exclusions: string[] = [];

  const criteria = criterionIds.map((id) => {
    const found = data.criteria.find((c) => c.id.trim().toLowerCase() === id);
    if (!found) {
      warnings.push(`The model did not score "${criterionName(id)}"; it is excluded from the total.`);
      return { id, score: null, reasoning: 'The model did not assess this criterion.', evidence: [], verified: true };
    }
    const evidence = found.evidence.flatMap((e) => {
      if (e.evidence_type === 'absence') return [{ ...e }];
      const turn = locate(e.quote, null, criterionName(id));
      // The model's timestamp and speaker are hints only; the turn where the quote was found decides both.
      return turn ? [{ ...e, timestamp: formatClock(turn.start), speaker: turn.speaker }] : [];
    });
    // A score of 2 or 3 must rest on words actually said. Absence evidence ("never asked about budget") can support only 0 or 1.
    const quoted = evidence.some((e) => e.evidence_type !== 'absence');
    const verified = found.score === null || found.score === 0 ? true : found.score >= 2 ? quoted : evidence.length > 0;
    if (!verified) {
      exclusions.push(
        found.score !== null && found.score >= 2
          ? `${criterionName(id)} scored ${found.score}, but no quote supporting it could be found in the transcript (absence alone supports only 0 or 1), so it is excluded from the total.`
          : `${criterionName(id)} scored ${found.score} with no supporting evidence, so it is excluded from the total.`,
      );
    }
    return { id, score: found.score, reasoning: found.reasoning, evidence, verified };
  });

  const redFlags = data.red_flags.filter((flag) => Boolean(locate(flag.quote, 'rep', 'Red flags')));
  const objections = data.objections.filter((o) => {
    if (!locate(o.quote, 'customer', 'Objections', 'objection')) return false;
    return !o.response.trim() || Boolean(locate(o.response, 'rep', 'Objections', 'rep response'));
  });

  // A mistake needs the rep's exact words. If the words cannot be found but the timestamp points at a real rep line,
  // keep it as a whole-line mark rather than losing the coaching; otherwise it is dropped like any invented evidence.
  // Words that are found but belong to the customer are a misattribution and are dropped outright.
  const severityRank = { critical: 0, major: 1, minor: 2 } as const;
  const mistakes = data.mistakes
    .map((m) => {
      const criterion = criterionIds.find((id) => id === m.criterion.trim().toLowerCase()) ?? '';
      const base = { ...m, criterion, timestamp: m.timestamp.trim(), what_went_wrong: m.what_went_wrong.trim(), better_alternative: m.better_alternative.trim(), category: m.category.trim() };
      if (!base.what_went_wrong && !base.category) return undefined;
      const located = base.quote.trim() ? locateQuote(base.quote, turns) : null;
      if (located) {
        const wrong = wrongSide(turns[located.turnIndex], 'rep');
        if (!wrong) return base;
        drop('Mistakes', wrong);
        return undefined;
      }
      const line = turnForTimestamp(turns, base.timestamp);
      if (line) {
        const wrong = wrongSide(line, 'rep');
        if (!wrong) return { ...base, quote: '' };
        drop('Mistakes', `its line ${wrong}`);
        return undefined;
      }
      drop('Mistakes', base.quote.trim() ? NOT_FOUND : 'had no quote or timestamp to anchor it');
      return undefined;
    })
    .filter((m): m is NonNullable<typeof m> => Boolean(m))
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .slice(0, 8);

  for (const [where, reasons] of removed) {
    const total = [...reasons.values()].reduce((n, count) => n + count, 0);
    const why = [...reasons].map(([reason, count]) => (reasons.size > 1 ? `${count} ${reason}` : reason)).join('; ');
    warnings.push(`${where}: removed ${plural(total, 'quote')} the model cited (${why}).`);
  }
  warnings.push(...exclusions);
  timings['validate'] = Math.round(performance.now() - validateStarted);

  const named = turns.map((t) => {
    if (t.speaker === 'rep' && t.name === defaultRep && data.rep && data.rep !== 'Rep') return { ...t, name: data.rep };
    if (t.speaker === 'customer' && t.name === 'Customer' && data.customer && data.customer !== 'Customer') return { ...t, name: data.customer };
    return t;
  });

  // Speech-to-text cost is fire-and-forget: don't block the results screen
  const speechCostsPromise = Promise.all(speechCalls.map((call) => transcribeCostItem(key, models.transcribe, call.label, call.seconds, call.usage)));
  speechCostsPromise.catch(() => undefined);

  // Return immediately with placeholder costs, then update when speech costs resolve
  const analysis = AnalysisSchema.parse({
    ...data,
    title: data.title || 'Sales call analysis',
    confidence: diarizationFailed && data.confidence === 'high' ? 'medium' : data.confidence,
    id: newId(),
    created_at: new Date().toISOString(),
    pack_version: '1.0',
    prompt_version: PROMPT_VERSION,
    models,
    duration,
    transcript: named,
    criteria,
    red_flags: redFlags,
    objections,
    mistakes,
    call_facts: data.call_facts,
    ...(isoOrUndefined(context?.enquiredAt) ? { enquired_at: isoOrUndefined(context?.enquiredAt) } : {}),
    ...(isoOrUndefined(context?.calledAt) ? { called_at: isoOrUndefined(context?.calledAt) } : {}),
    warnings,
    costs: [],
    timings,
    ...(doubleRun ? { double_run: doubleRun } : {}),
  });

  // Resolve speech costs and update the analysis when ready
  const speechCosts = await speechCostsPromise;
  analysis.costs = [...speechCosts, ...costs];
  return analysis;
}
