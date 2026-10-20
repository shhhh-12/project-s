import type { Analysis } from '../domain';

export type MetricStatus = 'good' | 'watch' | 'poor' | 'n/a';
export type Metric = {
  value: string;
  unit: string;
  status: MetricStatus;
  benchmark_text: string;
  approx?: boolean;
  /** Where the number comes from, so a reader knows how far to trust it. */
  source?: 'measured' | 'estimated' | 'ai' | 'input';
  /** Extra context shown under the value (what was agreed as a next step, why a metric is unavailable...). */
  note?: string;
};

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'ah', 'basically', 'actually', 'like', 'ennanu', 'apdina', 'ennana', 'athavathu', 'matrum']);

export const METRIC_NAMES = [
  'Talk ratio',
  'Filler words',
  'Talk speed',
  'Customer turns',
  'Questions asked',
  'Longest monologue',
  'Interruptions',
  'Next step set',
  'Speed to lead',
  'Customer questions',
  'Customer sentiment',
  'Call outcome',
  'Objections raised',
  'Objections handled well',
  'Red flags',
  'Mistakes flagged',
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

/** One line per metric for the Settings screen: what it is and where the number comes from. */
export const METRIC_HELP: Record<MetricName, string> = {
  'Talk ratio': 'Share of the talking done by the rep. Measured from speaking time (estimated from text length when the recording has no timings).',
  'Filler words': 'Rep filler words per minute (um, uh, basically, ennanu…). Counted in code.',
  'Talk speed': 'Rep words per minute.',
  'Customer turns': 'How many times the customer spoke.',
  'Questions asked': 'Questions the rep asked. Read by the AI, so Tanglish questions without a "?" are counted; falls back to counting question marks.',
  'Longest monologue': 'Longest uninterrupted stretch of rep talking, in seconds.',
  'Interruptions': 'Times the customer started speaking almost instantly after the rep (needs real timings).',
  'Next step set': 'Whether the rep agreed a clear next step. Read by the AI, with the agreed step shown.',
  'Speed to lead': 'Minutes from the lead enquiry to this call. Needs the enquiry time and call time under "Add context" when you analyse.',
  'Customer questions': 'Questions the customer asked: a sign of engagement. Read by the AI.',
  'Customer sentiment': 'How the customer sounded by the end of the call. Read by the AI.',
  'Call outcome': 'Where the call ended up. Read by the AI.',
  'Objections raised': 'Objections the customer raised, such as price or timing.',
  'Objections handled well': 'Objections the rep handled well out of those raised.',
  'Red flags': 'Serious problems flagged in the call. Zero is the goal.',
  'Mistakes flagged': 'Specific rep mistakes marked on the transcript, with how serious they were.',
};

const DEFAULT_METRICS = Object.fromEntries(METRIC_NAMES.map((name) => [name, true])) as Record<MetricName, boolean>;

export function getMetricToggles(saved?: Record<string, boolean>): Record<MetricName, boolean> {
  return { ...DEFAULT_METRICS, ...(saved ?? {}) };
}

/** What the scoring model and the rest of the analysis contribute on top of what can be measured from the transcript. */
export type MetricExtras = {
  facts?: Analysis['call_facts'];
  objections?: Analysis['objections'];
  redFlags?: Analysis['red_flags'];
  mistakes?: Analysis['mistakes'];
  /** ISO date-times. Both are needed for "Speed to lead". */
  enquiredAt?: string;
  calledAt?: string;
};

/** The extras carried by a saved analysis. */
export const extrasOf = (analysis: Analysis): MetricExtras => ({
  facts: analysis.call_facts,
  objections: analysis.objections,
  redFlags: analysis.red_flags,
  mistakes: analysis.mistakes,
  enquiredAt: analysis.enquired_at,
  calledAt: analysis.called_at,
});

// Words that make a sentence a question when the speech model leaves out the question mark.
const QUESTION_WORDS = /\b(what|why|how|when|where|which|who|enna|yenna|eppo|eppadi|epdi|evlo|evvalavu|evlavu|evalo|yaaru|yaar|yar|enga|engae|enge|yen|edhu|ethu|edhukku|ethanai|yethanai)\b/i;
// Endings that on their own mark a Tanglish question ("irukkingala", "pannuveengala", "illaya")...
const STRONG_ENDING = /(ingala|ngala|ingalaa|ngalaa|illaya|illiya)\s*[.!]?$/i;
// ...and shorter endings that only count together with a question word ("budget evvalavu irukkaa").
const WEAK_ENDING = /(aa|ah|ma|va)\s*[.!]?$/i;

/** Counts question sentences: question marks, plus Tanglish sentences that are clearly questions even without one. */
export function countQuestions(text: string): number {
  const sentences = text.split(/(?<=[.?!।])\s+/).map((s) => s.trim()).filter(Boolean);
  let count = 0;
  for (const sentence of sentences) {
    const marks = (sentence.match(/\?/g) ?? []).length;
    if (marks) {
      count += marks;
      continue;
    }
    const words = sentence.split(/\s+/);
    if (words.length < 2) continue;
    const opensWithQuestionWord = QUESTION_WORDS.test(words[0].replace(/[^\p{L}]/gu, ''));
    if (STRONG_ENDING.test(sentence) || opensWithQuestionWord || (QUESTION_WORDS.test(sentence) && WEAK_ENDING.test(sentence))) count++;
  }
  return count;
}

const NEXT_STEP = /\b(next step|follow up|follow-up|schedule|appointment|call back|callback|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|send|email|whatsapp|message|confirm|book|setup|install|installation|delivery|payment|pay|sign|contract|agreement|anuppuren|anupuren|call pannuren|naalaiku|naalaikku|naalai)\b/i;

const speedToLead = (extras: MetricExtras): Metric => {
  const benchmark = 'Under 5 minutes from enquiry to first call';
  const enquired = extras.enquiredAt ? new Date(extras.enquiredAt).getTime() : NaN;
  const called = extras.calledAt ? new Date(extras.calledAt).getTime() : NaN;
  if (Number.isNaN(enquired) || Number.isNaN(called)) {
    return { value: '—', unit: '', status: 'n/a', benchmark_text: benchmark, source: 'input', note: 'Add the lead enquiry time and the call time under “Add context” before analysing to measure this.' };
  }
  const minutes = (called - enquired) / 60000;
  if (minutes < 0) return { value: '—', unit: '', status: 'n/a', benchmark_text: benchmark, source: 'input', note: 'The call time is earlier than the enquiry time. Check both times.' };
  return {
    value: minutes < 120 ? minutes.toFixed(1) : (minutes / 60).toFixed(1),
    unit: minutes < 120 ? 'min' : 'hours',
    status: minutes <= 5 ? 'good' : minutes <= 15 ? 'watch' : 'poor',
    benchmark_text: benchmark,
    source: 'input',
  };
};

export function computeAllMetrics(turns: Analysis['transcript'], audioDuration = 0, extras: MetricExtras = {}): Record<string, Metric> {
  const rep = turns.filter((t) => t.speaker === 'rep');
  const customer = turns.filter((t) => t.speaker === 'customer');
  const labeled = rep.length > 0 && customer.length > 0;
  const hasRealTiming = turns.some((t) => t.end > t.start);
  // Pasted transcripts often have no timestamps, so speaking time is estimated from word counts and the call length.
  // Timing-derived values are then marked approximate.
  const estimatedSeconds = (turn: (typeof turns)[number]) => Math.max(0.4, turn.text.trim().split(/\s+/).filter(Boolean).length / 2.5);
  const durationFor = (turn: (typeof turns)[number]) => (hasRealTiming ? Math.max(0, turn.end - turn.start) : estimatedSeconds(turn));
  const seconds = (items: typeof turns) => {
    const raw = items.reduce((sum, t) => sum + durationFor(t), 0);
    if (hasRealTiming || !audioDuration || !turns.length) return raw;
    const totalEstimated = turns.reduce((sum, t) => sum + estimatedSeconds(t), 0);
    return totalEstimated ? (raw * Math.max(audioDuration, totalEstimated)) / totalEstimated : raw;
  };
  const repSec = seconds(rep);
  const allSec = seconds([...rep, ...customer]);
  const words = rep.flatMap((t) =>
    t.text
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean),
  );
  const youKnow = words.filter((w, i) => w === 'you' && words[i + 1] === 'know').length;
  const fillers = words.filter((w) => FILLERS.has(w)).length + youKnow;
  const repMinutes = repSec / 60;
  const speakerHint = 'Speakers could not be identified for this call, so this cannot be measured.';
  const na = (benchmark_text: string, note?: string): Metric => ({ value: '—', unit: '', status: 'n/a', benchmark_text, note });
  const needsRep = (benchmark: string) => na(benchmark, speakerHint);
  const ratio = allSec ? (repSec / allSec) * 100 : 0;
  const perMinute = repMinutes ? fillers / repMinutes : 0;
  const wpm = repMinutes ? words.length / repMinutes : 0;
  const timingSource = hasRealTiming && audioDuration ? ('measured' as const) : ('estimated' as const);

  // Questions: the model's count understands Tanglish; the code count is the fallback.
  const aiRepQuestions = extras.facts?.rep_questions ?? null;
  const codeQuestions = rep.reduce((count, t) => count + countQuestions(t.text), 0);
  const repQuestions = aiRepQuestions ?? codeQuestions;
  const haveQuestionSource = aiRepQuestions !== null || rep.length > 0;

  const longestMonologue = repSec > 0 ? Math.max(...rep.map(durationFor), 0) : 0;

  let interruptions = 0;
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].speaker === 'customer' && turns[i - 1].speaker === 'rep') {
      const gap = turns[i].start - turns[i - 1].end;
      if (gap >= 0 && gap < 0.5) interruptions++;
    }
  }

  // Next step: the model's reading first (it sees the whole conversation), else commitment words in the rep's turns.
  const aiNext = extras.facts?.next_step;
  const codeNext = rep.some((t) => NEXT_STEP.test(t.text));
  const nextKnown = aiNext?.set === true || aiNext?.set === false;
  const nextSet = nextKnown ? aiNext!.set === true : codeNext;

  const objections = extras.objections ?? [];
  const handledWell = objections.filter((o) => /well|good|handled/i.test(o.verdict) && !/not|missed|poor|badly/i.test(o.verdict)).length;
  const redFlags = extras.redFlags ?? [];
  const mistakes = extras.mistakes ?? [];
  const bySeverity = (level: string) => mistakes.filter((m) => m.severity === level).length;
  const sentiment = extras.facts?.customer_sentiment ?? 'unknown';
  const customerQuestions = extras.facts?.customer_questions ?? (customer.length ? customer.reduce((count, t) => count + countQuestions(t.text), 0) : null);

  return {
    'Talk ratio': labeled && allSec
      ? { value: ratio.toFixed(0), unit: '%', status: ratio >= 40 && ratio <= 55 ? 'good' : 'watch', benchmark_text: '40–55% rep talk', approx: !hasRealTiming, source: timingSource }
      : needsRep('Needs both speakers identified'),
    'Filler words': repMinutes
      ? { value: perMinute.toFixed(1), unit: 'per minute', status: perMinute < 3 ? 'good' : 'watch', benchmark_text: 'Under 3 per minute', approx: !hasRealTiming, source: timingSource }
      : needsRep('Needs rep speech identified'),
    'Talk speed': repMinutes
      ? { value: Math.round(wpm).toString(), unit: 'wpm', status: wpm >= 110 && wpm <= 180 ? 'good' : 'watch', benchmark_text: '120–170 wpm', approx: true, source: timingSource }
      : needsRep('Needs rep speech identified'),
    'Customer turns': customer.length
      ? { value: customer.length.toString(), unit: 'turns', status: 'good', benchmark_text: 'A balanced conversation has the customer speaking often', source: 'measured' }
      : na('Needs customer speech identified', speakerHint),
    'Questions asked': haveQuestionSource
      ? { value: repQuestions.toString(), unit: 'questions', status: repQuestions >= 3 ? 'good' : repQuestions >= 1 ? 'watch' : 'poor', benchmark_text: '3+ discovery questions per call', source: aiRepQuestions !== null ? 'ai' : 'measured' }
      : needsRep('Needs rep speech identified'),
    'Longest monologue': repSec > 0
      ? { value: longestMonologue.toFixed(1), unit: 'sec', status: longestMonologue <= 60 ? 'good' : longestMonologue <= 120 ? 'watch' : 'poor', benchmark_text: 'Under 60 seconds per monologue', approx: !hasRealTiming, source: timingSource }
      : needsRep('Needs rep speech identified'),
    'Interruptions': labeled
      ? { value: interruptions.toString(), unit: 'times', status: interruptions <= 2 ? 'good' : interruptions <= 5 ? 'watch' : 'poor', benchmark_text: 'Under 3 interruptions per call', approx: true, source: timingSource, note: hasRealTiming && audioDuration ? undefined : 'Turn timings are estimated from text length, so interruptions cannot be detected precisely.' }
      : needsRep('Needs both speakers identified'),
    'Next step set': !nextKnown && rep.length === 0
      ? needsRep('Clear next step committed')
      : {
      value: nextSet ? 'Yes' : 'No',
      unit: '',
      status: nextSet ? 'good' : 'poor',
      benchmark_text: 'Clear next step committed',
      source: nextKnown ? 'ai' : 'measured',
      note: nextKnown && aiNext!.detail ? `${aiNext!.detail}${aiNext!.timestamp ? ` [${aiNext!.timestamp}]` : ''}` : undefined,
    },
    'Speed to lead': speedToLead(extras),
    'Customer questions': customerQuestions !== null
      ? { value: String(customerQuestions), unit: 'questions', status: customerQuestions >= 1 ? 'good' : 'watch', benchmark_text: 'Customers who ask questions are engaged', source: extras.facts?.customer_questions != null ? 'ai' : 'measured' }
      : na('Needs customer speech identified', speakerHint),
    'Customer sentiment': sentiment === 'unknown'
      ? na('How the customer sounded by the end', 'The scoring model did not report sentiment for this call.')
      : { value: sentiment[0].toUpperCase() + sentiment.slice(1), unit: '', status: sentiment === 'positive' ? 'good' : sentiment === 'neutral' ? 'watch' : 'poor', benchmark_text: 'Positive or neutral by the end of the call', source: 'ai' },
    'Call outcome': extras.facts?.outcome
      ? { value: extras.facts.outcome, unit: '', status: nextSet ? 'good' : 'watch', benchmark_text: 'A defined outcome beats an open end', source: 'ai' }
      : na('Where the call ended up', 'The scoring model did not report an outcome for this call.'),
    'Objections raised': { value: String(objections.length), unit: objections.length === 1 ? 'objection' : 'objections', status: 'good', benchmark_text: 'Raised objections are chances to sell; none is also fine', source: 'ai' },
    'Objections handled well': objections.length
      ? { value: `${handledWell} of ${objections.length}`, unit: '', status: handledWell === objections.length ? 'good' : handledWell > 0 ? 'watch' : 'poor', benchmark_text: 'Every objection handled well', source: 'ai' }
      : { value: '—', unit: '', status: 'n/a', benchmark_text: 'Every objection handled well', note: 'No objections were raised in this call.' },
    'Red flags': { value: String(redFlags.length), unit: redFlags.length === 1 ? 'flag' : 'flags', status: redFlags.length === 0 ? 'good' : 'poor', benchmark_text: 'Zero red flags', source: 'ai' },
    'Mistakes flagged': !extras.facts && mistakes.length === 0
      ? na('Fewer is better; critical mistakes first', 'This call was analysed before mistakes were tracked. Analyze the recording again to see them.')
      : {
      value: String(mistakes.length),
      unit: mistakes.length === 1 ? 'mistake' : 'mistakes',
      status: bySeverity('critical') ? 'poor' : bySeverity('major') ? 'watch' : mistakes.length > 3 ? 'watch' : 'good',
      benchmark_text: 'Fewer is better; critical mistakes first',
      source: 'ai',
      note: mistakes.length ? `${bySeverity('critical')} critical · ${bySeverity('major')} major · ${bySeverity('minor')} minor` : 'The scoring model found no mistakes to mark.',
    },
  };
}
