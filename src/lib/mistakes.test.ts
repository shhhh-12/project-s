import { describe, expect, it } from 'vitest';
import { AnalysisSchema } from '../domain';
import { buildAnnotations, findSpans, segmentLine, turnForTimestamp } from './mistakes';

describe('findSpans', () => {
  const line = 'Hello sir, this plan is 999 rupees only.';
  it('finds an exact phrase', () => expect(findSpans(line, 'this plan is 999 rupees')).toEqual([[11, 34]]));
  it('ignores case, punctuation and spacing differences', () => {
    const [[start, end]] = findSpans(line, 'HELLO  sir this plan');
    expect(line.slice(start, end)).toBe('Hello sir, this plan');
  });
  it('highlights every fragment of a quote written with an ellipsis', () => {
    const spans = findSpans(line, 'Hello sir ... 999 rupees');
    expect(spans.map(([s, e]) => line.slice(s, e))).toEqual(['Hello sir', '999 rupees']);
  });
  it('returns nothing when the words are not in the line', () => {
    expect(findSpans(line, 'free installation')).toEqual([]);
    expect(findSpans(line, '')).toEqual([]);
  });
  it('works on text where the model dropped the punctuation', () => {
    const [[s, e]] = findSpans('Aama sir, romba costly. Yosichu solren.', 'romba costly yosichu solren');
    expect('Aama sir, romba costly. Yosichu solren.'.slice(s, e)).toBe('romba costly. Yosichu solren');
  });
});

const turn = (id: string, speaker: 'rep' | 'customer', start: number, text: string) => ({ id, speaker, name: speaker, start, end: start + 8, text });
const analysis = (extra: Record<string, unknown>) =>
  AnalysisSchema.parse({
    id: 'a', title: 't', created_at: '2026-01-01T00:00:00Z', pack_version: '1.0', prompt_version: '2.1.0', models: {}, product: '', summary: '', context_line: '',
    rep: 'Rep', customer: 'Customer', call_type: 'inbound_lead', segment: 'b2c', language: 'Tanglish', duration: 60, confidence: 'high',
    transcript: [turn('0', 'rep', 0, 'Hello sir, this plan is 999 rupees.'), turn('1', 'customer', 10, 'Romba costly sir.'), turn('2', 'rep', 20, 'Okay bye.')],
    criteria: [], red_flags: [], strengths: [], improvements: [], try_saying: '', objections: [], ...extra,
  });
const mistake = (over: Record<string, unknown>) => ({ timestamp: '0:00', quote: '', category: 'Cat', severity: 'major', what_went_wrong: 'Bad.', better_alternative: 'Better.', criterion: '', ...over });

describe('turnForTimestamp', () => {
  const turns = analysis({}).transcript;
  it('matches the line that starts at that time', () => expect(turnForTimestamp(turns, '0:10')?.id).toBe('1'));
  it('falls back to the last line that began before it', () => expect(turnForTimestamp(turns, '0:15')?.id).toBe('1'));
  it('returns nothing for text that is not a time', () => expect(turnForTimestamp(turns, '')).toBeUndefined());
});

describe('buildAnnotations', () => {
  it('attaches a mistake to the right line with the exact words highlighted', () => {
    const [a] = buildAnnotations(analysis({ mistakes: [mistake({ quote: 'this plan is 999 rupees', timestamp: '0:00' })] }));
    expect(a).toMatchObject({ kind: 'mistake', turnId: '0' });
    expect(segmentLine('Hello sir, this plan is 999 rupees.', [a]).map((s) => [s.text, Boolean(s.annotation)])).toEqual([
      ['Hello sir, ', false],
      ['this plan is 999 rupees', true],
      ['.', false],
    ]);
  });

  it('marks the whole line when only the timestamp is known', () => {
    const [a] = buildAnnotations(analysis({ mistakes: [mistake({ quote: '', timestamp: '0:20' })] }));
    expect(a.turnId).toBe('2');
    expect(a.spans).toEqual([]);
  });

  it('picks the line closest to the timestamp when the same words appear twice', () => {
    const a = analysis({
      transcript: [turn('0', 'rep', 0, 'Okay sir.'), turn('1', 'customer', 10, 'Hmm.'), turn('2', 'rep', 20, 'Okay sir.')],
      mistakes: [mistake({ quote: 'Okay sir', timestamp: '0:20' })],
    });
    expect(buildAnnotations(a)[0].turnId).toBe('2');
  });

  it('lists mistakes before evidence, worst first, and shows red flags as critical', () => {
    const result = buildAnnotations(
      analysis({
        mistakes: [mistake({ quote: 'Okay bye', timestamp: '0:20', severity: 'minor', category: 'Abrupt' }), mistake({ quote: 'Romba costly', timestamp: '0:10', severity: 'major', category: 'Price' })],
        red_flags: [{ type: 'misleading price', quote: '999 rupees', timestamp: '0:00' }],
        criteria: [{ id: 'discovery', score: 3, reasoning: 'Good', evidence: [{ quote: 'Hello sir', timestamp: '0:00', speaker: 'rep', evidence_type: 'quote' }], verified: true }],
      }),
    );
    expect(result.map((a) => `${a.kind}:${a.severity}`)).toEqual(['mistake:critical', 'mistake:major', 'mistake:minor', 'evidence:minor']);
  });

  it('for older analyses with no explicit mistakes, treats weakly-scored evidence as mistakes', () => {
    const result = buildAnnotations(
      analysis({ criteria: [{ id: 'discovery', score: 0, reasoning: 'No questions asked.', evidence: [{ quote: 'this plan is 999 rupees', timestamp: '0:00', speaker: 'rep', evidence_type: 'quote' }], verified: true }] }),
    );
    expect(result[0]).toMatchObject({ kind: 'mistake', severity: 'major', category: 'Discovery and need analysis', what: 'No questions asked.' });
  });

  it('does not show the same words flagged twice as two identical items', () => {
    const result = buildAnnotations(analysis({ mistakes: [mistake({ quote: 'Okay bye', timestamp: '0:20' }), mistake({ quote: 'okay bye', timestamp: '0:20' })] }));
    expect(result).toHaveLength(1);
  });
});

describe('segmentLine', () => {
  it('returns the plain text when nothing is highlighted', () => expect(segmentLine('Hi there', [])).toEqual([{ text: 'Hi there' }]));
  it('keeps the more severe highlight when two overlap', () => {
    const base = { id: 'x', kind: 'mistake' as const, category: '', what: '', better: '', timestamp: '', quote: '' };
    const out = segmentLine('abcdefghij', [
      { ...base, id: 'minor', severity: 'minor', spans: [[2, 8]] },
      { ...base, id: 'critical', severity: 'critical', spans: [[2, 5]] },
    ]);
    expect(out.map((s) => [s.text, s.annotation?.id])).toEqual([['ab', undefined], ['cde', 'critical'], ['fghij', undefined]]);
  });
});
