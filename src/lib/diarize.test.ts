import { describe, expect, it } from 'vitest';
import { groupTurns, splitSegments } from './diarize';

describe('splitSegments', () => {
  it('splits on sentence ends in English and Tamil punctuation, without changing a word', () => {
    const text = 'Vanakkam sir. Plan pathi enquiry panneenga la? Aama sir! Romba costly… Yosichu solren';
    const parts = splitSegments(text);
    expect(parts).toEqual(['Vanakkam sir.', 'Plan pathi enquiry panneenga la?', 'Aama sir!', 'Romba costly…', 'Yosichu solren']);
    expect(parts.join(' ')).toBe(text);
  });

  it('cuts over-long run-on speech at commas, then by word count, keeping every word', () => {
    const clause = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const text = `${clause}, ${clause}, ${clause}, ${clause}`;
    const parts = splitSegments(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 240)).toBe(true);
    expect(parts.join(' ')).toBe(text);

    const noPunctuation = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const pieces = splitSegments(noPunctuation);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(' ')).toBe(noPunctuation);
  });
});

describe('groupTurns', () => {
  it('joins consecutive sentences from the same speaker', () => {
    expect(groupTurns(['a.', 'b.', 'c.', 'd.'], ['rep', 'rep', 'customer', 'rep'])).toEqual([
      { speaker: 'rep', text: 'a. b.' },
      { speaker: 'customer', text: 'c.' },
      { speaker: 'rep', text: 'd.' },
    ]);
  });
});
