import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { criterionIds } from '../domain';
import { RUBRIC } from '../config/rubric';
import { runAnalysis } from './pipeline';
import { formatClock } from './transcript';

// The cache layer reads and writes through idb-keyval; stand it up in memory and expose indexedDB
// so the cache is genuinely exercised across repeated runs.
const cacheStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: vi.fn(async (key: string) => cacheStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => void cacheStore.set(key, value)),
  del: vi.fn(async (key: string) => void cacheStore.delete(key)),
  keys: vi.fn(async () => [...cacheStore.keys()]),
}));

beforeEach(() => {
  cacheStore.clear();
  vi.stubGlobal('indexedDB', {});
});

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

type Body = { model: string; messages?: Array<{ role: string; content: string }> };
const models = { transcribe: 'stt/model', understand: 'llm/model', prep: 'prep/model' };
const quiet = () => undefined;

/** The numbered sentences the speaker-labelling prompt carries: ["Hello sir.", "Hi."]. */
const sentencesOf = (user: string) =>
  user
    .split('NUMBERED SENTENCES')[1]
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^\d+\.\s/, ''));
/** A speaker-labelling answer in the real protocol: one {i, speaker} per sentence. */
const labels = (speakers: string[]) => ({ labels: speakers.map((speaker, index) => ({ i: index + 1, speaker })) });

function install(handlers: {
  stt?: (n: number) => unknown;
  diarize?: (sentences: string[], attempt: number) => unknown;
  roleMap?: () => unknown;
  romanize?: (items: Array<{ ta: string; ctx: string }>, attempt: number) => unknown;
  score: (prompt: string, attempt: number) => unknown;
}) {
  const log: string[] = [];
  let stt = 0;
  let diarizeCalls = 0;
  let romanizeCalls = 0;
  let scoreCalls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const path = String(url).replace('https://openrouter.ai/api/v1', '');
    const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/audio/transcriptions') {
      log.push('stt');
      const transcript = handlers.stt!(stt++);
      return ok(typeof transcript === 'string' ? { text: transcript } : transcript);
    }
    const system = body.messages![0].content;
    const user = body.messages![1].content;
    if (system.startsWith('You convert Tamil-script words')) {
      log.push('romanize');
      return ok({ choices: [{ message: { content: JSON.stringify(handlers.romanize!(JSON.parse(user), romanizeCalls++)) } }] });
    }
    if (system.startsWith('You label who is speaking')) {
      log.push('diarize');
      return ok({ choices: [{ message: { content: JSON.stringify(handlers.diarize!(sentencesOf(user), diarizeCalls++)) } }] });
    }
    if (system.startsWith('You map anonymous speaker labels')) {
      log.push('role-map');
      return ok({ choices: [{ message: { content: JSON.stringify(handlers.roleMap!()) } }] });
    }
    log.push('score');
    return ok({ choices: [{ message: { content: JSON.stringify(handlers.score(user, scoreCalls++)) } }] });
  }) as typeof fetch;
  return log;
}

const criterion = (id: string, score: unknown, quote?: string, timestamp = '0:00') => ({
  id,
  score,
  reasoning: `reason for ${id}`,
  evidence: quote ? [{ quote, timestamp, speaker: 'customer', evidence_type: 'quote' }] : [],
});
const report = (criteria: unknown[], extra: Record<string, unknown> = {}) => ({
  title: 'Internet plan enquiry',
  product: 'Home fibre',
  summary: 'Customer asked about plans.',
  context_line: 'Enquiry about fibre',
  rep: 'Arun',
  customer: 'Priya',
  call_type: 'inbound_lead',
  segment: 'b2c',
  language: 'Tanglish',
  confidence: 'high',
  criteria,
  red_flags: [],
  strengths: ['a', 'b', 'c', 'd', 'e'],
  improvements: ['x'],
  try_saying: 'Let me find the best plan for your home.',
  objections: [],
  ...extra,
});

const chunk1 = 'Vanakkam sir ABC Internet la irundhu pesuren. Plan pathi enquiry panneenga la?';
const chunk2 = 'Aama sir. Romba costly. Yosichu solren.';
const fakeAudio = {
  prepareAudio: async () => ({
    duration: 90,
    converted: true,
    chunks: [
      { data: 'AA==', format: 'wav', start: 0, end: 60 },
      { data: 'AA==', format: 'wav', start: 60, end: 90 },
    ],
  }),
};
const audioFile = new File([new Uint8Array(4)], 'call.mp3', { type: 'audio/mpeg' });

describe('audio → transcript → speakers → score', () => {
  it('uses Scribe native diarization plus one role mapping call instead of sentence-by-sentence speaker labelling', async () => {
    let prepareOptions: { preserveOriginal?: boolean } | undefined;
    const log = install({
      stt: (n) => n === 0
        ? { text: 'Hello sir. I am calling from ABC. Hi, I need a plan.', words: [
          { word: 'Hello', start: 0, end: 0.2, speaker_label: 'speaker_0' }, { word: 'sir.', start: 0.2, end: 0.4, speaker_label: 'speaker_0' },
          { word: 'I', start: 0.5, end: 0.6, speaker_label: 'speaker_0' }, { word: 'am', start: 0.6, end: 0.7, speaker_label: 'speaker_0' }, { word: 'calling', start: 0.7, end: 0.9, speaker_label: 'speaker_0' }, { word: 'from', start: 0.9, end: 1.1, speaker_label: 'speaker_0' }, { word: 'ABC.', start: 1.1, end: 1.3, speaker_label: 'speaker_0' },
          { word: 'Hi,', start: 1.4, end: 1.5, speaker_label: 'speaker_1' }, { word: 'I', start: 1.5, end: 1.6, speaker_label: 'speaker_1' }, { word: 'need', start: 1.6, end: 1.8, speaker_label: 'speaker_1' }, { word: 'a', start: 1.8, end: 1.9, speaker_label: 'speaker_1' }, { word: 'plan.', start: 1.9, end: 2.1, speaker_label: 'speaker_1' },
        ] }
        : { text: 'What is the price? It is 999.', words: [
          { word: 'What', start: 0, end: 0.2, speaker_label: 'speaker_1' }, { word: 'is', start: 0.2, end: 0.3, speaker_label: 'speaker_1' }, { word: 'the', start: 0.3, end: 0.4, speaker_label: 'speaker_1' }, { word: 'price?', start: 0.4, end: 0.6, speaker_label: 'speaker_1' },
          { word: 'It', start: 0.7, end: 0.8, speaker_label: 'speaker_0' }, { word: 'is', start: 0.8, end: 0.9, speaker_label: 'speaker_0' }, { word: '999.', start: 0.9, end: 1.1, speaker_label: 'speaker_0' },
        ] },
      roleMap: () => ({ roles: [{ label: 'speaker_0', speaker: 'rep' }, { label: 'speaker_1', speaker: 'customer' }] }),
      score: () => report(criterionIds.map((id) => criterion(id, null))),
    });
    const result = await runAnalysis({
      key: 'k',
      models: { ...models, transcribe: 'elevenlabs/scribe-v2' },
      text: '',
      audio: audioFile,
      onProgress: quiet,
      deps: { prepareAudio: async (_file, _signal, options) => {
        prepareOptions = options;
        return fakeAudio.prepareAudio();
      } },
    });
    expect(log).toEqual(['stt', 'stt', 'role-map', 'score']);
    expect(prepareOptions).toEqual({ preserveOriginal: true });
    expect(result.transcript.map((turn) => turn.speaker)).toEqual(['rep', 'customer', 'rep']);
    expect(result.transcript.map((turn) => turn.start)).toEqual([0, 1.4, 60.7]);
  });

  it('uses Fish inline speaker markers as native turns, then maps each voice once', async () => {
    const log = install({
      stt: (n) => n === 0
        ? '<|speaker:0|> Vanakkam, ABC Internet la irundhu pesuren. <|speaker:1|> Plan price enna?'
        : '<|speaker:1|> Cost konjam high. <|speaker:0|> Monthly 999 rupees.',
      roleMap: () => ({ roles: [{ label: 'speaker_0', speaker: 'rep' }, { label: 'speaker_1', speaker: 'customer' }] }),
      score: () => report(criterionIds.map((id) => criterion(id, null))),
    });
    const result = await runAnalysis({
      key: 'k',
      models: { ...models, transcribe: 'fish-audio/transcribe-1-pro' },
      text: '',
      audio: audioFile,
      onProgress: quiet,
      deps: fakeAudio,
    });
    expect(log).toEqual(['stt', 'stt', 'role-map', 'score']);
    // The customer's adjacent turns at the chunk boundary are intentionally merged.
    expect(result.transcript.map((turn) => turn.speaker)).toEqual(['rep', 'customer', 'rep']);
    expect(result.transcript.map((turn) => turn.text).join(' ')).not.toContain('<|speaker:');
  });

  it('runs the whole audio flow and produces a validated analysis', async () => {
    const log = install({
      stt: (n) => [chunk1, chunk2][n],
      // Sentences 1-2 are the rep's greeting, 3-5 are the customer's reply.
      diarize: (sentences) => labels(sentences.map((_, i) => (i < 2 ? 'agent' : 'Customer'))),
      score: () =>
        report(
          [
            criterion('opening_rapport', '3', 'Vanakkam sir ABC Internet', '0:00'),
            criterion('lead_context', 2, 'Plan pathi enquiry panneenga la', '0:20'),
            criterion('discovery', 1, 'This sentence was never said', '0:30'), // invented -> dropped -> unverified
            criterion('listening_control', 2, 'Yosichu solren', '1:10'),
            criterion('solution_fit', null),
            criterion('objection_handling', 1, 'Aama sir. Romba costly.', '1:05'),
            criterion('closing_next_step', 0),
            criterion('compliance', 3, 'Vanakkam sir', '0:00'),
          ],
          { objections: [{ type: 'price', quote: 'Aama sir. Romba costly.', timestamp: '1:05', response: '', verdict: 'missed', better_response: 'Ask what they compare with.' }] },
        ),
    });
    const steps: string[] = [];
    const result = await runAnalysis({ key: 'k', models, text: '', audio: audioFile, context: { repName: '' }, onProgress: (s) => steps.push(s), deps: fakeAudio });

    expect(log).toEqual(['stt', 'stt', 'diarize', 'score']);
    expect(steps.includes('prepare') && steps.includes('transcribe') && steps.includes('speakers') && steps.includes('validate')).toBe(true);
    expect(result.transcript.map((t) => t.speaker)).toEqual(['rep', 'customer']);
    expect(result.transcript.map((t) => t.name)).toEqual(['Arun', 'Priya']);
    expect(result.transcript[1].start).toBeGreaterThan(59);
    expect(result.duration).toBe(90);
    expect(result.criteria).toHaveLength(8);
    expect(result.criteria.find((c) => c.id === 'opening_rapport')!.score).toBe(3);
    const discovery = result.criteria.find((c) => c.id === 'discovery')!;
    expect(discovery.verified).toBe(false);
    expect(discovery.evidence).toHaveLength(0);
    expect(result.strengths).toHaveLength(3);
    expect(result.objections).toHaveLength(1);
    expect(result.warnings.some((w) => /could not be found/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /Discovery/.test(w))).toBe(true);
  });

  it('does not fail when speaker labels cannot be verified; it keeps the transcript and warns', async () => {
    install({
      stt: (n) => [chunk1, chunk2][n],
      diarize: () => ({ labels: [] }), // the model labelled nothing, so nothing can be trusted
      score: () => report(criterionIds.map((id) => criterion(id, null))),
    });
    const result = await runAnalysis({ key: 'k', models, text: '', audio: audioFile, onProgress: quiet, deps: fakeAudio });
    expect(result.transcript.every((t) => t.speaker === 'unknown')).toBe(true);
    expect(result.transcript.map((t) => t.text).join(' ')).toBe(`${chunk1} ${chunk2}`);
    expect(result.warnings.some((w) => /Speaker labels could not be verified/.test(w))).toBe(true);
    expect(result.confidence).toBe('medium');
  });

  it('requires a transcription model for audio and an analysis model always', async () => {
    await expect(runAnalysis({ key: 'k', models: { transcribe: '', understand: 'm', prep: '' }, text: '', audio: audioFile, onProgress: quiet, deps: fakeAudio })).rejects.toThrow(/transcription model/);
    await expect(runAnalysis({ key: 'k', models: { transcribe: 't', understand: '', prep: '' }, text: 'Rep: hi', onProgress: quiet })).rejects.toThrow(/analysis model/);
  });
});

describe('transcript flow', () => {
  it('skips speaker labelling for labeled text and keeps lines containing colons and hyphens intact', async () => {
    const log = install({
      score: () => report(criterionIds.map((id) => criterion(id, 2, id === 'discovery' ? 'Call me at 5:30 pm tomorrow' : 'Hello sir - this is ABC calling', '0:10'))),
    });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir - this is ABC calling\nCustomer: Call me at 5:30 pm tomorrow', onProgress: quiet });
    expect(log).toEqual(['score']);
    expect(result.transcript[1].text).toBe('Call me at 5:30 pm tomorrow');
    expect(result.criteria.every((c) => c.verified)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('retries once for a missing criterion, then marks what is still missing as not assessed', async () => {
    let calls = 0;
    install({
      score: () => {
        calls++;
        return report(criterionIds.slice(0, 5).map((id) => criterion(id, 2, 'Hello sir')));
      },
    });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    expect(calls).toBe(2);
    expect(result.criteria).toHaveLength(8);
    expect(result.criteria.filter((c) => c.score === null)).toHaveLength(3);
    expect(result.warnings.filter((w) => /did not score/.test(w))).toHaveLength(3);
  });

  it('drops a red flag whose quote is not in the transcript instead of failing', async () => {
    install({
      score: () => report(criterionIds.map((id) => criterion(id, 2, 'Hello sir')), { red_flags: [{ type: 'pressure', quote: 'Buy now or lose it forever', timestamp: '0:05' }] }),
    });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    expect(result.red_flags).toHaveLength(0);
    expect(result.warnings.some((w) => /could not be found/.test(w))).toBe(true);
  });

  it('scores twice and flags criteria where the runs disagree by more than one point', async () => {
    let calls = 0;
    install({
      score: () => {
        calls++;
        // Run A (first call) and run B (second call) disagree on discovery: 3 vs 1.
        const discoveryScore = calls === 1 ? 3 : 1;
        return report(
          criterionIds.map((id) =>
            criterion(id, id === 'discovery' ? discoveryScore : 2, 'Hello sir'),
          ),
        );
      },
    });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', doubleScore: true, onProgress: quiet });
    expect(calls).toBe(2);
    expect(result.double_run).toBeDefined();
    expect(result.double_run!.disagreements).toContain('discovery');
    expect(result.warnings.some((w) => /disagreed by more than one point/.test(w))).toBe(true);
    expect(result.warnings.some((w) => /points apart/.test(w))).toBe(true);
  });

  it('does not set double_run when the toggle is off', async () => {
    install({ score: () => report(criterionIds.map((id) => criterion(id, 2, 'Hello sir'))) });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    expect(result.double_run).toBeUndefined();
  });
});

describe('cache reuse', () => {
  it('reuses the report when the same transcript is analysed twice', async () => {
    let calls = 0;
    install({ score: () => { calls++; return report(criterionIds.map((id) => criterion(id, 2, 'Hello sir'))); } });
    const options = { key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet };
    const first = await runAnalysis(options);
    const second = await runAnalysis(options);

    expect(calls).toBe(1); // the second run was served from cache
    expect(second.criteria).toEqual(first.criteria);
    expect(second.costs.some((c) => c.step === 'score')).toBe(false); // nothing was charged
    expect(second.warnings.some((w) => /already been analysed/.test(w))).toBe(true);
  });

  it('re-analyses when the scoring model changes', async () => {
    let calls = 0;
    install({ score: () => { calls++; return report(criterionIds.map((id) => criterion(id, 2, 'Hello sir'))); } });
    await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    await runAnalysis({ key: 'k', models: { ...models, understand: 'other/model' }, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    expect(calls).toBe(2);
  });

  it('re-analyses when the transcript itself changes', async () => {
    let calls = 0;
    install({ score: () => { calls++; return report(criterionIds.map((id) => criterion(id, 2, 'Hello sir'))); } });
    await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    await runAnalysis({ key: 'k', models, text: 'Rep: Completely different words\nCustomer: Yes', onProgress: quiet });
    expect(calls).toBe(2);
  });
});

const hasTamil = (value: string) => /[\u0B80-\u0BFF]/.test(value);
const allNull = () => report(criterionIds.map((id) => criterion(id, null)));

describe('Tamil script is always converted to Tanglish', () => {
  it('uses the model for the words it converts and the built-in rules for the words it skips', async () => {
    const log = install({
      stt: (n) => (n === 0 ? 'வணக்கம் sir. start பண்ணலாம். ரொம்ப costly.' : ''),
      // The model converts two words, skips பண்ணலாம், and tries to sneak Tamil letters back in for ரொம்ப.
      romanize: (items) => ({
        words: items.flatMap((item) => (item.ta === 'வணக்கம்' ? [{ ta: item.ta, en: 'vanakkam' }] : item.ta === 'ரொம்ப' ? [{ ta: item.ta, en: 'ரொம்ப' }] : [])),
      }),
      diarize: (sentences) => labels(sentences.map((_, i) => (i === 0 ? 'rep' : 'customer'))),
      score: allNull,
    });
    const result = await runAnalysis({ key: 'k', models, text: '', audio: audioFile, onProgress: quiet, deps: fakeAudio });
    const text = result.transcript.map((t) => t.text).join(' ');
    expect(log).toContain('romanize');
    expect(hasTamil(text)).toBe(false);
    expect(text).toContain('vanakkam sir.'); // from the model
    expect(text).toContain('start pannalam.'); // skipped by the model -> built-in rules
    expect(text).toContain('romba costly.'); // the model's Tamil answer was refused -> built-in rules
    expect(result.costs.some((c) => c.step === 'thanglish')).toBe(true);
  });

  it('still converts everything when the model answers badly, and says so', async () => {
    install({
      stt: (n) => (n === 0 ? 'start பண்ணலாம்' : ''),
      romanize: () => ({ nonsense: true }),
      diarize: (sentences) => labels(sentences.map(() => 'rep')),
      score: allNull,
    });
    const result = await runAnalysis({ key: 'k', models, text: '', audio: audioFile, onProgress: quiet, deps: fakeAudio });
    expect(result.transcript.map((t) => t.text).join(' ')).toBe('start pannalam');
    expect(result.warnings.some((w) => /built-in spelling rules/.test(w))).toBe(true);
  });

  it('also converts a pasted transcript that already has speaker labels', async () => {
    const log = install({
      romanize: (items) => ({ words: items.map((item) => ({ ta: item.ta, en: item.ta === 'பண்ணலாம்' ? 'pannalam' : 'seri' })) }),
      score: allNull,
    });
    const result = await runAnalysis({ key: 'k', models, text: 'Rep: start பண்ணலாம் sir\nCustomer: சரி', onProgress: quiet });
    expect(log).toEqual(['romanize', 'score']);
    expect(result.transcript.map((t) => t.text)).toEqual(['start pannalam sir', 'seri']);
    expect(result.transcript.map((t) => t.speaker)).toEqual(['rep', 'customer']);
  });

  it('does not call the model at all when there is no Tamil script', async () => {
    const log = install({ score: allNull });
    await runAnalysis({ key: 'k', models, text: 'Rep: Hello sir\nCustomer: Hi', onProgress: quiet });
    expect(log).toEqual(['score']);
  });
});

describe('speaker labels survive a model that skips or fumbles', () => {
  it('fills in sentences the model skipped and joins consecutive sentences of one speaker into a turn', async () => {
    install({
      stt: (n) => (n === 0 ? 'Vanakkam sir. ABC internet pesuren. Plan venum. Evvalavu aagum? Seri.' : ''),
      // The model skips sentence 2 (4 of 5 labelled is enough to trust); it belongs to whoever was speaking before it.
      diarize: () => ({ labels: [{ i: 1, speaker: 'rep' }, { i: 3, speaker: 'customer' }, { i: 4, speaker: 'customer' }, { i: 5, speaker: 'customer' }] }),
      score: allNull,
    });
    const result = await runAnalysis({ key: 'k', models, text: '', audio: audioFile, onProgress: quiet, deps: fakeAudio });
    expect(result.transcript.map((t) => [t.speaker, t.text])).toEqual([
      ['rep', 'Vanakkam sir. ABC internet pesuren.'],
      ['customer', 'Plan venum. Evvalavu aagum? Seri.'],
    ]);
  });
});

describe('mistakes and call facts from the scoring model', () => {
  const dialogue = 'Rep: Hello sir, this plan is 999 rupees.\nCustomer: Romba costly sir.\nRep: Okay bye.';
  const mistake = (over: Record<string, unknown>) => ({ timestamp: '0:00', quote: '', category: 'Skipped discovery', severity: 'major', what_went_wrong: 'Pitched a price before asking needs.', better_alternative: 'Ask what they use the internet for.', criterion: 'discovery', ...over });

  it('keeps verified mistakes, keeps a line-level mistake whose words cannot be found, and drops one it cannot place', async () => {
    install({
      score: () =>
        report(criterionIds.map((id) => criterion(id, null)), {
          mistakes: [
            mistake({ quote: 'this plan is 999 rupees', timestamp: '0:00' }), // verified
            mistake({ quote: 'completely invented words', timestamp: '0:20', severity: 'critical', category: 'No next step' }), // timestamp points at a real line
            mistake({ quote: 'also invented', timestamp: '', category: 'Ghost' }), // nothing to anchor it to
          ],
        }),
    });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.mistakes.map((m) => m.category)).toEqual(['No next step', 'Skipped discovery']); // worst first
    expect(result.mistakes[0].quote).toBe(''); // whole-line mark
    expect(result.mistakes[1].quote).toBe('this plan is 999 rupees');
    expect(result.mistakes.every((m) => m.criterion === '' || m.criterion === 'discovery')).toBe(true);
    expect(result.warnings.some((w) => /1 quote/.test(w))).toBe(true);
  });

  it('accepts models that rename the mistake fields or give severity in other words', async () => {
    install({
      score: () =>
        report(criterionIds.map((id) => criterion(id, null)), {
          mistakes: [{ time: '0:10', text: 'Okay bye.', type: 'Abrupt close', severity: 'High', description: 'Ended the call without a next step.', suggestion: 'Offer a callback time.' }],
        }),
    });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.mistakes).toHaveLength(1);
    expect(result.mistakes[0]).toMatchObject({ category: 'Abrupt close', severity: 'major', what_went_wrong: 'Ended the call without a next step.', better_alternative: 'Offer a callback time.' });
  });

  it('keeps the call facts and the times the user typed in', async () => {
    install({
      score: () =>
        report(criterionIds.map((id) => criterion(id, null)), {
          call_facts: { rep_questions: '4', customer_questions: 2, next_step: { set: 'yes', detail: 'Callback tomorrow 5 pm', timestamp: '0:20' }, customer_sentiment: 'Positive', outcome: 'Callback agreed' },
        }),
    });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet, context: { enquiredAt: '2026-10-17T10:00', calledAt: '2026-10-17T10:04' } });
    expect(result.call_facts).toEqual({ rep_questions: 4, customer_questions: 2, next_step: { set: true, detail: 'Callback tomorrow 5 pm', timestamp: '0:20' }, customer_sentiment: 'positive', outcome: 'Callback agreed' });
    expect(new Date(result.called_at!).getTime() - new Date(result.enquired_at!).getTime()).toBe(4 * 60000);
  });

  it('an analysis without mistakes or facts is still valid (older models, older saved results)', async () => {
    install({ score: allNull });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.mistakes).toEqual([]);
    expect(result.call_facts).toBeUndefined();
  });
});

describe('evidence validation against the located turn', () => {
  const dialogue = 'Rep: Hello sir, this plan is 999 rupees.\nCustomer: Romba costly sir.\nRep: Okay bye.';
  const name = (id: string) => RUBRIC.criteria.find((c) => c.id === id)!.name;
  const quoteEvidence = (quote: string, timestamp: string, speaker: string) => ({ quote, timestamp, speaker, evidence_type: 'quote' });
  const absence = { quote: 'Never asked about budget', timestamp: '0:00', speaker: 'rep', evidence_type: 'absence' };
  const withCriterion = (id: string, score: unknown, evidence: unknown[]) =>
    criterionIds.map((c) => (c === id ? { id: c, score, reasoning: 'r', evidence } : criterion(c, null)));
  // The pipeline caches reports by transcript, so every run in this block starts from an empty cache.
  const run = (extra: Record<string, unknown>, text = dialogue) => {
    cacheStore.clear();
    cacheStore.clear();
    install({ score: () => report(criterionIds.map((id) => criterion(id, null)), extra) });
    return runAnalysis({ key: 'k', models, text, onProgress: quiet });
  };
  const mistake = (over: Record<string, unknown>) => ({ timestamp: '0:00', quote: '', category: 'Skipped discovery', severity: 'major', what_went_wrong: 'Pitched a price before asking needs.', better_alternative: 'Ask first.', criterion: 'discovery', ...over });

  it('overwrites a wrong model timestamp and speaker from the turn where the quote was found', async () => {
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 2, [quoteEvidence('Romba costly sir.', '9:59', 'rep')])) });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    const evidence = result.criteria.find((c) => c.id === 'discovery')!.evidence[0];
    expect(evidence.speaker).toBe('customer');
    expect(evidence.timestamp).toBe(formatClock(result.transcript[1].start));
    expect(evidence.timestamp).not.toBe('9:59');
  });

  it('excludes a score of 3 that rests only on absence evidence, and says why', async () => {
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 3, [absence])) });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.criteria.find((c) => c.id === 'discovery')!.verified).toBe(false);
    expect(result.warnings.some((w) => w.includes(name('discovery')) && /absence/.test(w) && /excluded from the total/.test(w))).toBe(true);
  });

  it('lets a score of 0 or 1 rest on absence evidence, but still needs a quote for 2', async () => {
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 1, [absence])) });
    expect((await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet })).criteria.find((c) => c.id === 'discovery')!.verified).toBe(true);
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 0, [])) });
    expect((await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet })).criteria.find((c) => c.id === 'discovery')!.verified).toBe(true);
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 2, [absence])) });
    expect((await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet })).criteria.find((c) => c.id === 'discovery')!.verified).toBe(false);
  });

  it('keeps a score of 2 when a real quote sits next to an absence entry', async () => {
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 2, [absence, quoteEvidence('Romba costly sir.', '0:10', 'customer')])) });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.criteria.find((c) => c.id === 'discovery')).toMatchObject({ verified: true });
    expect(result.criteria.find((c) => c.id === 'discovery')!.evidence).toHaveLength(2);
  });

  it('names the criterion and the reason when a quote is removed', async () => {
    cacheStore.clear();
    install({ score: () => report(withCriterion('discovery', 1, [quoteEvidence('We guarantee a full refund', '0:05', 'rep')])) });
    const result = await runAnalysis({ key: 'k', models, text: dialogue, onProgress: quiet });
    expect(result.warnings).toContain(`${name('discovery')}: removed 1 quote the model cited (could not be found in the transcript).`);
  });

  it('drops customer words attributed to the rep as a mistake, even when the timestamp points at a rep line', async () => {
    const result = await run({ mistakes: [mistake({ quote: 'Romba costly sir.', timestamp: '0:00' })] });
    expect(result.mistakes).toHaveLength(0);
    expect(result.warnings.some((w) => /^Mistakes: removed 1 quote.*said by the customer, not the rep/.test(w))).toBe(true);
  });

  it('keeps a mistake whose quote is in a rep turn', async () => {
    const result = await run({ mistakes: [mistake({ quote: 'this plan is 999 rupees', timestamp: '5:00' })] });
    expect(result.mistakes).toHaveLength(1);
    expect(result.mistakes[0].quote).toBe('this plan is 999 rupees');
  });

  it('does not turn a customer line into a whole-line mistake mark', async () => {
    const customerTime = formatClock((await run({})).transcript[1].start);
    const result = await run({ mistakes: [mistake({ quote: 'invented rep words that were never said', timestamp: customerTime })] });
    expect(result.mistakes).toHaveLength(0);
    expect(result.warnings.some((w) => /^Mistakes:.*its line was said by the customer/.test(w))).toBe(true);
  });

  it('requires an objection quote from the customer and its response from the rep', async () => {
    const objection = (quote: string, response: string) => ({ type: 'price', quote, timestamp: '0:10', response, verdict: 'missed', better_response: 'Ask what they compare with.' });
    const result = await run({
      objections: [
        objection('Romba costly sir.', 'Hello sir, this plan is 999 rupees.'), // right on both sides
        objection('Hello sir, this plan is 999 rupees.', ''), // the "customer" quote is the rep's
        objection('Romba costly sir.', 'Romba costly sir.'), // the "rep" response is the customer's
      ],
    });
    expect(result.objections).toHaveLength(1);
    expect(result.objections[0].quote).toBe('Romba costly sir.');
    expect(result.warnings.some((w) => /^Objections: removed 2 quotes/.test(w) && /objection was said by the rep/.test(w) && /rep response was said by the customer/.test(w))).toBe(true);
  });

  it('keeps a red flag said by the rep and drops one said by the customer', async () => {
    const flag = (quote: string) => ({ type: 'pressure', quote, timestamp: '0:00' });
    const result = await run({ red_flags: [flag('this plan is 999 rupees'), flag('Romba costly sir.')] });
    expect(result.red_flags.map((f) => f.quote)).toEqual(['this plan is 999 rupees']);
    expect(result.warnings.some((w) => /^Red flags: removed 1 quote.*said by the customer, not the rep/.test(w))).toBe(true);
  });

  it('does not discard quotes on a call whose speakers are unknown', async () => {
    const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello sir this plan is 999 rupees\n\n2\n00:00:04,000 --> 00:00:06,000\nRomba costly sir okay';
    const result = await run({ mistakes: [mistake({ quote: 'this plan is 999 rupees', timestamp: '0:01' })], red_flags: [{ type: 'pressure', quote: 'Romba costly sir okay', timestamp: '0:04' }] }, srt);
    expect(result.transcript.every((t) => t.speaker === 'unknown')).toBe(true);
    expect(result.mistakes).toHaveLength(1);
    expect(result.red_flags).toHaveLength(1);
  });
});
