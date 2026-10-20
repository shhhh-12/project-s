import { describe, expect, it } from 'vitest';
import { computeAllMetrics, countQuestions, extrasOf, getMetricToggles, METRIC_NAMES } from './metrics';

const mkTurn = (speaker: 'rep' | 'customer', text: string, start: number, end: number) => ({
  id: `${speaker}-${start}`,
  speaker,
  name: speaker === 'rep' ? 'Rep' : 'Customer',
  start,
  end,
  text,
});

describe('computeAllMetrics', () => {
  it('computes all metrics for a labeled call', () => {
    const turns = [
      mkTurn('rep', 'Hello sir, how can I help you?', 0, 5),
      mkTurn('customer', 'I want to know about your plans', 5, 10),
      mkTurn('rep', 'Sure, what is your budget?', 10, 15),
      mkTurn('customer', 'Around 500 rupees', 15, 20),
      mkTurn('rep', 'We have a plan for that. Let me explain.', 20, 30),
    ];
    const result = computeAllMetrics(turns, 30);
    expect(result['Talk ratio']).toBeDefined();
    expect(result['Questions asked']).toBeDefined();
    expect(result['Longest monologue']).toBeDefined();
    expect(result['Interruptions']).toBeDefined();
    expect(result['Next step set']).toBeDefined();
    expect(result['Speed to lead']).toBeDefined();
  });

  it('estimates speech metrics when transcript turns have no timestamps', () => {
    const turns = [
      mkTurn('rep', 'Hello sir what plan do you need', 0, 0),
      mkTurn('customer', 'I need the premium plan', 0, 0),
      mkTurn('rep', 'I can send the details tomorrow', 0, 0),
    ];
    const result = computeAllMetrics(turns, 60);
    expect(result['Talk ratio'].status).not.toBe('n/a');
    expect(result['Filler words'].status).not.toBe('n/a');
    expect(result['Talk speed'].status).not.toBe('n/a');
    expect(result['Customer turns'].value).toBe('1');
    expect(result['Longest monologue'].status).not.toBe('n/a');
    expect(result['Questions asked'].value).toBe('0');
  });

  it('counts questions asked by rep', () => {
    const turns = [
      mkTurn('rep', 'What is your name? Where do you live? What do you need?', 0, 10),
      mkTurn('customer', 'I need a plan', 10, 15),
    ];
    const result = computeAllMetrics(turns, 15);
    expect(result['Questions asked'].value).toBe('3');
  });

  it('detects interruptions', () => {
    const turns = [
      mkTurn('rep', 'Let me explain the plan in detail', 0, 10),
      mkTurn('customer', 'Wait, I have a question', 10.2, 12), // starts 0.2s after rep ends
    ];
    const result = computeAllMetrics(turns, 12);
    expect(result['Interruptions'].value).toBe('1');
  });

  it('returns n/a for unlabeled calls', () => {
    const turns = [
      { ...mkTurn('rep', 'Hello', 0, 5), speaker: 'unknown' as const },
      { ...mkTurn('customer', 'Hi', 5, 10), speaker: 'unknown' as const },
    ];
    const result = computeAllMetrics(turns, 10);
    expect(result['Talk ratio'].status).toBe('n/a');
  });

  it('detects next step patterns', () => {
    const turns = [
      mkTurn('rep', 'I will send you the details on WhatsApp tomorrow', 0, 5),
      mkTurn('customer', 'Okay', 5, 7),
    ];
    const result = computeAllMetrics(turns, 7);
    expect(result['Next step set'].value).toBe('Yes');
  });
});

describe('getMetricToggles', () => {
  it('returns defaults when nothing saved', () => {
    const toggles = getMetricToggles();
    expect(toggles['Talk ratio']).toBe(true);
    expect(toggles['Speed to lead']).toBe(true);
  });

  it('merges saved toggles over defaults', () => {
    const toggles = getMetricToggles({ 'Talk ratio': false });
    expect(toggles['Talk ratio']).toBe(false);
    expect(toggles['Filler words']).toBe(true);
  });

  it('has a toggle for every metric name', () => {
    const toggles = getMetricToggles();
    for (const name of METRIC_NAMES) {
      expect(toggles).toHaveProperty(name);
    }
  });
});

describe('every metric in the settings list produces a value', () => {
  const turns = [
    mkTurn('rep', 'Vanakkam sir ABC internet pesuren', 0, 6),
    mkTurn('customer', 'Plan pathi therinjikanum', 6, 10),
    mkTurn('rep', 'Enna budget vachirukeenga', 10, 16),
    mkTurn('customer', 'Romba costly sir', 16, 20),
  ];
  const extras = {
    facts: { rep_questions: 3, customer_questions: 1, next_step: { set: true, detail: 'Callback tomorrow 5 pm', timestamp: '0:50' }, customer_sentiment: 'positive' as const, outcome: 'Callback agreed' },
    objections: [{ type: 'price', quote: 'Romba costly', timestamp: '0:16', response: '', verdict: 'handled well', better_response: '' }, { type: 'timing', quote: 'x', timestamp: '0:17', response: '', verdict: 'missed', better_response: '' }],
    redFlags: [],
    mistakes: [
      { timestamp: '0:10', quote: '', category: 'a', severity: 'major' as const, what_went_wrong: '', better_alternative: '', criterion: '' },
      { timestamp: '0:12', quote: '', category: 'b', severity: 'minor' as const, what_went_wrong: '', better_alternative: '', criterion: '' },
    ],
    enquiredAt: '2026-10-17T10:00:00Z',
    calledAt: '2026-10-17T10:04:00Z',
  };

  it('has real values for all of them when the speakers are labelled and the model supplied its facts', () => {
    const result = computeAllMetrics(turns, 20, extras);
    for (const name of METRIC_NAMES) {
      expect(result[name], name).toBeDefined();
      expect(result[name].status, name).not.toBe('n/a');
      expect(result[name].value, name).not.toBe('—');
    }
    expect(result['Questions asked']).toMatchObject({ value: '3', source: 'ai' });
    expect(result['Next step set']).toMatchObject({ value: 'Yes', note: 'Callback tomorrow 5 pm [0:50]' });
    expect(result['Speed to lead']).toMatchObject({ value: '4.0', unit: 'min', status: 'good' });
    expect(result['Objections handled well'].value).toBe('1 of 2');
    expect(result['Mistakes flagged']).toMatchObject({ value: '2', note: '0 critical · 1 major · 1 minor' });
    expect(result['Customer sentiment'].value).toBe('Positive');
    expect(result['Call outcome'].value).toBe('Callback agreed');
  });

  it('explains why a metric is unavailable instead of leaving it blank', () => {
    const result = computeAllMetrics(turns.map((t) => ({ ...t, speaker: 'unknown' as const })), 20);
    expect(result['Talk ratio']).toMatchObject({ status: 'n/a' });
    expect(result['Talk ratio'].note).toMatch(/could not be identified/);
    expect(result['Speed to lead'].note).toMatch(/Add the lead enquiry time/);
    expect(result['Customer sentiment'].note).toMatch(/did not report/);
  });

  it('still fills the AI-read facts when the speakers could not be identified', () => {
    const result = computeAllMetrics(turns.map((t) => ({ ...t, speaker: 'unknown' as const })), 20, extras);
    expect(result['Questions asked']).toMatchObject({ value: '3', source: 'ai' });
    expect(result['Next step set'].value).toBe('Yes');
    expect(result['Call outcome'].value).toBe('Callback agreed');
  });

  it('rejects an impossible Speed to lead rather than showing a negative number', () => {
    const result = computeAllMetrics(turns, 20, { enquiredAt: '2026-10-17T11:00:00Z', calledAt: '2026-10-17T10:00:00Z' });
    expect(result['Speed to lead'].status).toBe('n/a');
  });

  it('reads the extras straight off a saved analysis', () => {
    expect(extrasOf({ call_facts: undefined, objections: [], red_flags: [], mistakes: [], enquired_at: 'e', called_at: 'c' } as never)).toMatchObject({ enquiredAt: 'e', calledAt: 'c' });
  });
});

describe('countQuestions', () => {
  it('counts question marks', () => expect(countQuestions('What is your name? Where do you live?')).toBe(2));
  it('counts Tanglish questions that have no question mark', () => {
    expect(countQuestions('Enna plan venum sir.')).toBe(1);
    expect(countQuestions('Budget evvalavu irukkaa.')).toBe(1);
    expect(countQuestions('Veetla irukkingala.')).toBe(1);
    expect(countQuestions('Naan call pannuren. Details anuppuren.')).toBe(0);
  });
  it('does not count plain statements', () => expect(countQuestions('I will send the details tomorrow. Thank you.')).toBe(0));
});
