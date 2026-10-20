import { z } from 'zod';
import { chatJson, RouterError, type Usage } from './openrouter';

/** True when the text contains any Tamil-script character. */
export const hasTamilScript = (text: string) => /[\u0B80-\u0BFF]/.test(text);

/** A maximal run of Tamil script (optionally joined by zero-width joiners the speech model sometimes emits). */
const TAMIL_RUN = /[\u0B80-\u0BFF]+(?:[\u200C\u200D]+[\u0B80-\u0BFF]+)*/g;
const stripJoiners = (value: string) => value.replace(/[\u200C\u200D]/g, '');

// ---------------------------------------------------------------------------------------------------------------------
// 1. Deterministic transliteration.
//
// This is the safety net: it can never leave Tamil script behind, never changes word order and never costs money.
// It writes the way Tamil speakers type in chat ("பண்ணலாம்" -> "pannalam", "வணக்கம்" -> "vanakkam"):
// long vowels are shortened, and stop consonants are voiced between vowels / after a nasal ("போகலாம்" -> "pogalam").
// The LLM pass below improves on it for lexical choices ("சார்" -> "sir"); this guarantees the baseline.
// ---------------------------------------------------------------------------------------------------------------------

const INDEPENDENT_VOWELS: Record<string, string> = {
  'அ': 'a', 'ஆ': 'aa', 'இ': 'i', 'ஈ': 'ee', 'உ': 'u', 'ஊ': 'oo', 'எ': 'e', 'ஏ': 'e', 'ஐ': 'ai', 'ஒ': 'o', 'ஓ': 'o', 'ஔ': 'au',
};
const VOWEL_SIGNS: Record<string, string> = {
  'ா': 'a', 'ி': 'i', 'ீ': 'ee', 'ு': 'u', 'ூ': 'oo', 'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au', 'ௗ': 'au',
};
const PULLI = '்';
const NASALS = new Set(['ங', 'ஞ', 'ண', 'ந', 'ம', 'ன']);
const NASAL_SOUND: Record<string, string> = { 'ங': 'n', 'ஞ': 'n', 'ண': 'n', 'ந': 'n', 'ம': 'm', 'ன': 'n' };

// Stops have a voiceless form (word start / after a non-nasal consonant) and a voiced form (between vowels / after a nasal).
const STOPS: Record<string, { plain: string; voiced: string; double: string }> = {
  'க': { plain: 'k', voiced: 'g', double: 'kk' },
  'ச': { plain: 's', voiced: 's', double: 'ch' },
  'ட': { plain: 't', voiced: 'd', double: 'tt' },
  'த': { plain: 'th', voiced: 'dh', double: 'thth' },
  'ப': { plain: 'p', voiced: 'b', double: 'pp' },
};
const NASAL_VOICED_OVERRIDE: Record<string, string> = { 'ச': 'j' };
const CONSONANTS: Record<string, string> = {
  'ங': 'ng', 'ஞ': 'ny', 'ண': 'n', 'ந': 'n', 'ம': 'm', 'ன': 'n',
  'ய': 'y', 'ர': 'r', 'ல': 'l', 'வ': 'v', 'ழ': 'zh', 'ள': 'l', 'ற': 'r',
  'ஜ': 'j', 'ஷ': 'sh', 'ஸ': 's', 'ஹ': 'h',
};
const TAMIL_DIGITS = '௦௧௨௩௪௫௬௭௮௯';

type Unit = { consonant?: string; vowel: string };
/** Marks a consonant that carries no vowel (it has a pulli). */
const NONE = '';

function parseUnits(run: string): Unit[] {
  const units: Unit[] = [];
  const chars = [...stripJoiners(run)];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (INDEPENDENT_VOWELS[ch]) {
      units.push({ vowel: INDEPENDENT_VOWELS[ch] });
    } else if (ch === 'ஃ') {
      units.push({ vowel: 'h' });
    } else if (ch === 'க' && chars[i + 1] === PULLI && chars[i + 2] === 'ஷ') {
      // க்ஷ conjunct ("ksh")
      const next = chars[i + 3];
      i += 2;
      if (next === PULLI) {
        units.push({ consonant: 'க்ஷ', vowel: NONE });
        i += 1;
      } else if (next && VOWEL_SIGNS[next]) {
        units.push({ consonant: 'க்ஷ', vowel: VOWEL_SIGNS[next] });
        i += 1;
      } else units.push({ consonant: 'க்ஷ', vowel: 'a' });
    } else if (STOPS[ch] || CONSONANTS[ch]) {
      const next = chars[i + 1];
      if (next === PULLI) {
        units.push({ consonant: ch, vowel: NONE });
        i += 1;
      } else if (next && VOWEL_SIGNS[next]) {
        units.push({ consonant: ch, vowel: VOWEL_SIGNS[next] });
        i += 1;
      } else {
        units.push({ consonant: ch, vowel: 'a' });
      }
    } else {
      const digit = TAMIL_DIGITS.indexOf(ch);
      if (digit >= 0) units.push({ vowel: String(digit) });
      // Any other Tamil-block symbol is dropped rather than left behind in Tamil script.
    }
  }
  return units;
}

const bare = (unit?: Unit) => Boolean(unit?.consonant) && unit!.vowel === NONE;

/** Writes Tamil-script text in plain lowercase English letters. Non-Tamil characters are left untouched. */
export function transliterateTamil(text: string): string {
  return text.replace(TAMIL_RUN, (run) => {
    const units = parseUnits(run);
    let out = '';
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const prev = units[i - 1];
      const next = units[i + 1];
      if (!unit.consonant) {
        out += unit.vowel;
        continue;
      }
      const c = unit.consonant;
      if (c === 'க்ஷ') {
        out += `ksh${unit.vowel}`;
        continue;
      }
      const stop = STOPS[c];
      if (stop) {
        if (unit.vowel === NONE) {
          if (next?.consonant === c) {
            // A doubled stop is written once as a geminate; its second half then adds only its vowel.
            out += stop.double;
            units[i + 1] = { vowel: next.vowel };
          } else out += stop.plain;
          continue;
        }
        const afterNasal = bare(prev) && NASALS.has(prev!.consonant!);
        const betweenVowels = Boolean(prev) && !bare(prev);
        const form = afterNasal ? (NASAL_VOICED_OVERRIDE[c] ?? stop.voiced) : betweenVowels ? stop.voiced : stop.plain;
        out += form + unit.vowel;
        continue;
      }
      if (c === 'ற' && unit.vowel !== NONE && bare(prev) && prev!.consonant === 'ன') {
        out += `dr${unit.vowel}`; // நன்றி -> nandri
        continue;
      }
      if (unit.vowel === NONE && NASALS.has(c)) {
        out += NASAL_SOUND[c];
        continue;
      }
      out += (CONSONANTS[c] ?? '') + unit.vowel;
    }
    return out.replace(/(.)\1{2,}/g, '$1$1').toLowerCase();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. LLM pass, done per WORD instead of over the whole transcript.
//
// Asking a model to re-type an entire transcript is fragile: one merged or split word and the answer is rejected,
// which is how Tamil letters used to survive into the final transcript. Instead we collect each distinct Tamil word,
// send it with a few words of context, and get back a small {tamil -> tanglish} dictionary. The substitution is then
// done locally, so the transcript can never lose, reorder or invent words. Any word the model skips or mangles falls
// back to the deterministic transliteration above.
// ---------------------------------------------------------------------------------------------------------------------

const wordSchema = z.object({
  words: z.array(
    z.object({
      ta: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
      en: z.preprocess((v) => (v == null ? '' : String(v)), z.string()),
    }),
  ),
});

const system = `You convert Tamil-script words from a phone-call transcript into romanized Tanglish: the way Tamil speakers type Tamil in English letters in chat.
You receive a JSON list of items {"ta": "<Tamil word>", "ctx": "<a few surrounding words, for meaning only>"}.
Rules:
- Return one entry per item, with "ta" copied EXACTLY as given and "en" holding its Tanglish spelling.
- "en" uses only plain lowercase English letters a-z (an apostrophe or hyphen is allowed). No Tamil script, no digits, no spaces, no diacritics.
- Write phonetically as people chat: "பண்ணலாம்" -> "pannalam", "வணக்கம்" -> "vanakkam", "என்ன" -> "enna", "சொல்றேன்" -> "solren", "ரொம்ப" -> "romba", "இந்த" -> "indha".
- A Tamil-script spelling of an English word is written as that English word: "சார்" -> "sir", "பிளான்" -> "plan", "ஓகே" -> "okay".
- Never translate the meaning, never merge or split words, and spell the same Tamil word the same way every time.
Return ONLY JSON: {"words":[{"ta":"...","en":"..."}]}`;

const BATCH = 120;
const CONTEXT_WORDS = 3;
const SAFE_SPELLING = /^[a-z][a-z'-]*$/;

/** The model's spelling is only trusted if it is a plausible, Latin-only rendering of that word. */
const acceptable = (tamil: string, spelling: string) => {
  const cleaned = spelling.trim().toLowerCase();
  return SAFE_SPELLING.test(cleaned) && cleaned.length <= tamil.length * 3 + 6 ? cleaned : undefined;
};

/** For each distinct Tamil word: a short snippet of the words around its first occurrence. */
function collectWords(text: string) {
  const words = new Map<string, string>();
  const tokens = text.split(/\s+/).filter(Boolean);
  tokens.forEach((token, index) => {
    for (const run of token.match(TAMIL_RUN) ?? []) {
      const key = stripJoiners(run);
      if (!words.has(key)) words.set(key, tokens.slice(Math.max(0, index - CONTEXT_WORDS), index + CONTEXT_WORDS + 1).join(' ').slice(0, 120));
    }
  });
  return words;
}

export type RomanizeResult = {
  text: string;
  /** Distinct Tamil words found. */
  words: number;
  /** Distinct words the model converted. */
  byModel: number;
  /** Distinct words converted by the built-in rules because the model skipped or mangled them. */
  byRules: number;
};

/**
 * Converts every Tamil-script word in `text` to Tanglish. Guarantees that no Tamil script remains and that every
 * non-Tamil character is untouched. Auth, credit and network errors are raised; a model that answers badly is skipped.
 */
export async function romanizeTamilText(
  key: string,
  model: string,
  text: string,
  options: { signal?: AbortSignal; onProgress?: (detail: string) => void; onUsage?: (usage: Usage, info: { part: number; parts: number }) => void } = {},
): Promise<RomanizeResult> {
  const words = collectWords(text);
  if (!words.size) return { text, words: 0, byModel: 0, byRules: 0 };

  const entries = [...words.entries()];
  const batches: Array<Array<[string, string]>> = [];
  for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH));

  const dictionary = new Map<string, string>();
  for (let index = 0; index < batches.length; index++) {
    options.onProgress?.(batches.length > 1 ? `Converting Tamil words · part ${index + 1} of ${batches.length}` : `Converting ${entries.length} Tamil words`);
    const user = JSON.stringify(batches[index].map(([ta, ctx]) => ({ ta, ctx })));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data, usage } = await chatJson(key, model, system, user, wordSchema, options.signal);
        options.onUsage?.(usage, { part: index + 1, parts: batches.length });
        for (const item of data.words) {
          const tamil = stripJoiners(item.ta.trim());
          const spelling = acceptable(tamil, item.en);
          if (spelling && words.has(tamil)) dictionary.set(tamil, spelling);
        }
        break;
      } catch (error) {
        // "The model answered badly" is retried and then covered by the rules; auth, credit and network errors must surface.
        if (!(error instanceof RouterError && error.status === 502)) throw error;
      }
    }
  }

  const converted = text.replace(TAMIL_RUN, (run) => dictionary.get(stripJoiners(run)) ?? transliterateTamil(run));
  const byModel = [...words.keys()].filter((w) => dictionary.has(w)).length;
  return { text: converted, words: words.size, byModel, byRules: words.size - byModel };
}
