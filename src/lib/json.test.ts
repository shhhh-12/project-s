import { describe, expect, it } from 'vitest';
import { extractJson, looksTruncated } from './openrouter';

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
  });

  it('strips a code fence', () => {
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
  });

  it('finds JSON inside surrounding prose', () => {
    expect(extractJson('Here is the result:\n{"ok":true}\nHope that helps.')).toEqual({ ok: true });
  });

  it('tolerates trailing commas', () => {
    expect(extractJson('{"ok":true,"items":[1,2,],}')).toEqual({ ok: true, items: [1, 2] });
  });

  it('tolerates smart quotes', () => {
    expect(extractJson('{“ok”:true}')).toEqual({ ok: true });
  });

  it('tolerates single-quoted keys', () => {
    expect(extractJson("{'ok':true}")).toEqual({ ok: true });
  });

  it('tolerates a raw newline inside a string', () => {
    expect(extractJson('{"summary":"first\nsecond"}')).toEqual({ summary: 'first\nsecond' });
  });

  it('handles a nested structure with all of the above', () => {
    const messy = 'Result: ```json\n{“turns”:[{"speaker":"rep","text":"vanakkam sir"},],"total":3,}\n```';
    expect(extractJson(messy)).toEqual({ turns: [{ speaker: 'rep', text: 'vanakkam sir' }], total: 3 });
  });

  it('throws when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(/No JSON object/);
  });
});

describe('looksTruncated', () => {
  it('reports a balanced object as complete', () => {
    expect(looksTruncated('{"a":1}')).toBe(false);
  });

  it('detects an unclosed object', () => {
    expect(looksTruncated('{"a":1,"b":')).toBe(true);
  });

  it('detects an unterminated string', () => {
    expect(looksTruncated('{"a":"still going')).toBe(true);
  });

  it('is not fooled by braces inside strings', () => {
    expect(looksTruncated('{"a":"a } brace in a string"}')).toBe(false);
  });

  it('is not fooled by escaped quotes', () => {
    expect(looksTruncated('{"a":"she said \\"hi\\""}')).toBe(false);
  });
});