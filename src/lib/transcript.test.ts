import { describe, expect, it } from 'vitest';
import { chunkText, formatClock, hasSpeakerLabels, parseTranscript, locateQuote, retimeTurns, roleOf, verifyQuote } from './transcript';

describe('transcript parsers', () => {
  it('parses SRT labels and timestamps', () => {
    expect(parseTranscript('1\n00:00:01,000 --> 00:00:03,000\nRep: Vanakkam', 'srt')[0]).toMatchObject({ speaker: 'rep', start: 1, end: 3, text: 'Vanakkam' });
  });
  it('parses WEBVTT with a titled header, cue settings and voice tags', () => {
    const t = parseTranscript('WEBVTT - call\n\nNOTE hello\n\n00:01.000 --> 00:02.500 align:start\n<v Customer>Romba costly</v>');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ speaker: 'customer', start: 1, end: 2.5, text: 'Romba costly' });
  });
  it('verifies normalized quote', () => expect(verifyQuote('Hello, Priya!', parseTranscript('Priya: Hello Priya', 'txt'))).toBe(true));
  it('does not mislabel an unknown speaker as a customer', () => expect(parseTranscript('Maya: Hello', 'txt')[0].speaker).toBe('unknown'));

  it('keeps full text of unlabeled lines that contain colons, dashes or hyphens', () => {
    const lines = ['Call me at 5:30 pm tomorrow', 'Hello sir - I need a plan for my home', 'Vanakkam, ennoda budget 500-600 rupees'];
    const turns = parseTranscript(lines.join('\n'));
    expect(turns.map((t) => t.text)).toEqual(lines);
    expect(hasSpeakerLabels(turns)).toBe(false);
  });
  it('still recognises real labels', () => {
    const turns = parseTranscript('Rep: Hello sir\nCustomer (Priya): Hi, call me at 5:30');
    expect(turns.map((t) => t.speaker)).toEqual(['rep', 'customer']);
    expect(turns[1].text).toBe('Hi, call me at 5:30');
    expect(hasSpeakerLabels(turns)).toBe(true);
  });
  it('accepts quotes that span two turns or use an ellipsis, and rejects invented ones', () => {
    const turns = parseTranscript('Rep: I can offer the family plan\nCustomer: That sounds good to me');
    expect(verifyQuote('the family plan That sounds good', turns)).toBe(true);
    expect(verifyQuote('I can offer … sounds good to me', turns)).toBe(true);
    expect(verifyQuote('We guarantee a refund', turns)).toBe(false);
    expect(verifyQuote('', turns)).toBe(false);
  });
  it('keeps Tamil script combining marks when matching', () => {
    const turns = parseTranscript('Customer: இது ரொம்ப costly சார்');
    expect(verifyQuote('ரொம்ப costly', turns)).toBe(true);
    expect(verifyQuote('ரொம்ப cheap', turns)).toBe(false);
  });
});

describe('roleOf', () => {
  it('uses keywords only, customer before rep', () => {
    expect(roleOf('Arunachalam (customer)')).toBe('customer');
    expect(roleOf('Salesh')).toBe('unknown');
    expect(roleOf('Rep')).toBe('rep');
    expect(roleOf('Customer (Priya)')).toBe('customer');
  });
});

describe('timing and chunking helpers', () => {
  it('formats clocks without 1:60', () => {
    expect(formatClock(59.6)).toBe('0:59');
    expect(formatClock(119.9)).toBe('1:59');
    expect(formatClock(125)).toBe('2:05');
  });
  it('spreads turns across audio windows proportionally', () => {
    const turns = retimeTurns(
      [
        { text: 'a'.repeat(59), start: 0, end: 0 },
        { text: 'b'.repeat(29), start: 0, end: 0 },
      ],
      [
        { chars: 60, start: 0, end: 60 },
        { chars: 30, start: 60, end: 90 },
      ],
    );
    expect(turns[0].start).toBe(0);
    expect(turns[1].start).toBeGreaterThan(59);
    expect(turns[1].end).toBeGreaterThan(88);
  });
  it('chunks long text on sentence boundaries without losing words', () => {
    const text = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i}.`).join(' ');
    const parts = chunkText(text, 200);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts.join(' ')).toBe(text);
  });
});

describe('locateQuote', () => {
  const turns = parseTranscript('Rep: Hello sir, ABC Internet here\nCustomer: Romba costly\nRep: Let me check the family plan');
  it('returns the turn where the quote starts', () => {
    expect(locateQuote('Romba costly', turns)).toEqual({ turnIndex: 1 });
    expect(locateQuote('family plan', turns)).toEqual({ turnIndex: 2 });
  });
  it('accepts a quote that spans two turns and reports where it starts', () => {
    expect(locateQuote('ABC Internet here Romba costly', turns)).toEqual({ turnIndex: 0 });
  });
  it('joins fragments split on an ellipsis and uses the first one', () => {
    expect(locateQuote('Hello sir ... family plan', turns)).toEqual({ turnIndex: 0 });
  });
  it('returns null for a missing, empty or too-short quote', () => {
    expect(locateQuote('We guarantee a refund', turns)).toBeNull();
    expect(locateQuote('', turns)).toBeNull();
    expect(locateQuote('a', turns)).toBeNull();
  });
});
