import { describe, expect, it } from 'vitest';
import { hasTamilScript, transliterateTamil } from './romanize';

describe('transliterateTamil', () => {
  it('writes Tamil the way people chat it, and leaves English untouched', () => {
    expect(transliterateTamil('start பண்ணலாம்')).toBe('start pannalam');
    expect(transliterateTamil('வணக்கம் sir')).toBe('vanakkam sir');
  });

  it.each([
    ['என்ன', 'enna'],
    ['ரொம்ப', 'romba'],
    ['இந்த', 'indha'],
    ['போகலாம்', 'pogalam'],
    ['வாங்க', 'vanga'],
    ['அதுக்கு', 'adhukku'],
    ['யோசிச்சு', 'yosichu'],
    ['சொல்றேன்', 'solren'],
    ['நன்றி', 'nandri'],
    ['மஞ்சள்', 'manjal'],
    ['தமிழ்', 'thamizh'],
  ])('%s -> %s', (tamil, expected) => expect(transliterateTamil(tamil)).toBe(expected));

  it('never leaves Tamil script behind, whatever the input', () => {
    const everyTamilCharacter = Array.from({ length: 0xbff - 0xb80 + 1 }, (_, i) => String.fromCharCode(0xb80 + i)).join('');
    expect(hasTamilScript(transliterateTamil(everyTamilCharacter))).toBe(false);
    expect(hasTamilScript(transliterateTamil('க்ஷ ஜ ஷ ஸ ஹ ஃ ௧௨௩ ப\u200dண்ணலாம்'))).toBe(false);
  });

  it('keeps punctuation, numbers and word order', () => {
    expect(transliterateTamil('சரி, 500 ரூபாய்?')).toBe('sari, 500 roobay?');
  });
});
