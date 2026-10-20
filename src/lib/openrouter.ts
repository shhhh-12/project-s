import { z } from 'zod';
import type { RouterModel } from '../config/models';
import { supportsNativeDiarization } from '../config/models';

const base = 'https://openrouter.ai/api/v1';

export class RouterError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

export const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'HTTP-Referer': typeof location === 'undefined' ? 'http://localhost' : location.origin,
  'X-Title': 'CallScore',
});

/** Turns an HTTP status into advice a person can act on. The raw message stays in brackets so callers can still match on it. Never echoes an API key. */
export const friendly = (status: number, message: string, key?: string) => {
  let text = message.replace(/sk-or-[\w-]+/gi, '[redacted]');
  if (key && key.length >= 8) text = text.split(key).join('[redacted]');
  if (status === 401) return 'OpenRouter rejected the API key. Check it in Settings.';
  if (status === 402) return 'OpenRouter reports insufficient credits for this model. Add credits or pick a cheaper model.';
  if (status === 403) return `OpenRouter refused this request. The content may have been flagged by moderation, or this key is not allowed to use the selected model. (${text})`;
  if (status === 408 || status === 504) return `The model timed out. Try again, or pick a faster model. (${text})`;
  if (status === 429) return `OpenRouter is rate-limiting this request. Wait a moment and retry. (${text})`;
  if (status === 400 && /model|endpoint|parameter|unsupported|not support|provider/i.test(text)) {
    return `OpenRouter could not find that model or it does not support a setting this app sends. Pick another model in Settings. (${text})`;
  }
  return text;
};

async function request(url: string, init: RequestInit, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal });
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new RouterError(0, 'Could not reach OpenRouter. Check your internet connection and try again.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: { message?: string; metadata?: { raw?: unknown } } };
      const raw = body.error?.metadata?.raw;
      message = (body.error?.message ?? message) + (typeof raw === 'string' && raw ? ` — ${raw.slice(0, 240)}` : '');
    } catch {
      /* response was not JSON */
    }
    const sent = (init.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer\s+/i, '');
    throw new RouterError(response.status, friendly(response.status, message, sent));
  }
  return response;
}

/** `kind: 'transcription'` is required to see speech-to-text models; the default models list does not include them. */
export async function listModels(key: string, kind: 'text' | 'transcription' = 'text') {
  if (await routedThroughProxy()) {
    const { proxyListModels } = await import('./proxy');
    const models = await proxyListModels(kind);
    return models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  const fetchList = async (query: string) => {
    const response = await request(`${base}/models${query}`, { headers: headers(key) });
    const body = (await response.json()) as { data?: RouterModel[] };
    return (body.data ?? []).filter((model) => model && model.id);
  };
  let models: RouterModel[];
  try {
    models = await fetchList(`?output_modalities=${kind}`);
  } catch (error) {
    if (kind === 'transcription' || !(error instanceof RouterError) || error.status === 401) throw error;
    models = await fetchList('');
  }
  if (kind === 'text') {
    models = models.filter((model) => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'));
  }
  return models.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      cost: z.number().nullish(),
    })
    .nullish(),
});

/**
 * Pulls a JSON object out of a model response. Models routinely wrap JSON in prose or a code fence,
 * emit trailing commas, use smart quotes, or get cut off mid-object, so this cleans each of those up
 * rather than failing on the first strict parse.
 */
export function extractJson(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json|jsonc)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const candidates = [trimmed];
  const from = trimmed.indexOf('{');
  const to = trimmed.lastIndexOf('}');
  if (from >= 0 && to > from) candidates.push(trimmed.slice(from, to + 1));

  for (const candidate of candidates) {
    for (const attempt of [candidate, repair(candidate)]) {
      try {
        return JSON.parse(attempt);
      } catch {
        /* try the next repair strategy */
      }
    }
  }
  throw new Error('No JSON object found');
}

/** Reverses the malformations that models actually produce: smart quotes, trailing commas, trailing text. */
function repair(value: string): string {
  return value
    // Smart quotes and full-width punctuation around JSON syntax.
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    // A comma followed only by whitespace and a closing bracket.
    .replace(/,\s*([}\]])/g, '$1')
    // Single-quoted keys, which some models emit.
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    // Literal newlines inside strings (invalid JSON) -> escaped.
    .replace(/"(?:[^"\\]|\\.)*"/g, (match) => match.replace(/\r?\n/g, '\\n'));
}

/** True when the model's answer is JSON that stopped mid-structure, i.e. it ran out of output space. */
export function looksTruncated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    else if (!inString && char === '{') depth++;
    else if (!inString && char === '}') depth--;
  }
  return depth > 0 || inString;
}

const describeIssues = (error: z.ZodError) =>
  error.issues
    .slice(0, 2)
    .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
    .join('; ');

/**
 * Transport choice: a signed-in user goes through the Supabase Edge Function (the OpenRouter key
 * stays on the server); everyone else calls OpenRouter directly with a browser-held key.
 * The proxy module is imported lazily so it stays out of the bundle when Supabase is not configured.
 */
const routedThroughProxy = async () => {
  try {
    const { hasSession } = await import('./proxy');
    return await hasSession();
  } catch {
    return false;
  }
};

export const DEFAULT_MAX_TOKENS = 6000;

/** Request body shared by the direct and proxy chat calls. `provider.require_parameters` makes OpenRouter skip providers that would silently ignore temperature/seed/response_format. */
export const chatBody = (model: string, system: string, user: string, maxTokens: number, jsonMode: boolean, strict: boolean) => {
  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    seed: 42,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (strict) body.provider = { require_parameters: true };
  return body;
};

/**
 * Runs a chat call and, on a 400/404/422 that names the cause, retries once per cause:
 * first without `provider.require_parameters`, then without JSON mode. At most three calls; anything else is rethrown.
 */
export async function withChatFallbacks<R>(call: (jsonMode: boolean, strict: boolean) => Promise<R>): Promise<R> {
  let jsonMode = true;
  let strict = true;
  for (;;) {
    try {
      return await call(jsonMode, strict);
    } catch (error) {
      const { status, message } = error as { status?: unknown; message?: unknown };
      if (typeof status !== 'number' || ![400, 404, 422].includes(status) || typeof message !== 'string') throw error;
      if (strict && /provider|parameter/i.test(message)) strict = false;
      else if (jsonMode && /response_format|json|structured|support/i.test(message)) jsonMode = false;
      else throw error;
    }
  }
}

export async function chatJson<T>(key: string, model: string, system: string, user: string, schema: z.ZodType<T>, signal?: AbortSignal, maxTokens = DEFAULT_MAX_TOKENS) {
  if (await routedThroughProxy()) {
    const { proxyChatJson } = await import('./proxy');
    return proxyChatJson<T>(key, model, system, user, schema, signal, maxTokens);
  }
  const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS;
  return directChatJson<T>(key, model, system, user, schema, signal, safeMaxTokens);
}

async function directChatJson<T>(key: string, model: string, system: string, user: string, schema: z.ZodType<T>, signal?: AbortSignal, maxTokens = DEFAULT_MAX_TOKENS) {
  const result = await withChatFallbacks(async (jsonMode, strict) => {
    const body = chatBody(model, system, user, maxTokens, jsonMode, strict);
    const response = await request(`${base}/chat/completions`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) }, signal);
    return responseSchema.safeParse(await response.json());
  });
  if (!result.success) throw new RouterError(502, 'OpenRouter returned an unexpected response.');

  const choice = result.data.choices[0];
  const content = choice.message.content;
  if (!content?.trim()) throw new RouterError(502, 'The selected model returned an empty response. Try a different analysis model.');

  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    const cutShort = choice.finish_reason === 'length' || looksTruncated(content);
    throw new RouterError(
      502,
      cutShort
        ? 'The model ran out of output space before finishing its answer. Try a model with a larger output limit, or score a shorter recording.'
        : 'The selected model did not return valid JSON. Try again or choose another model.',
    );
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new RouterError(502, `The model's answer was not in the expected format (${describeIssues(checked.error)}). Try again or choose another model.`);
  return { data: checked.data, usage: result.data.usage };
}

/** What OpenRouter reported for one chat call (cost is in USD when the provider reports it). */
export type Usage = { prompt_tokens?: number | null; completion_tokens?: number | null; total_tokens?: number | null; cost?: number | null } | null | undefined;
export type TranscribeUsage = { generationId?: string; cost?: number | null };
export type TranscriptSegment = { text: string; start: number; end: number; speaker: string };
export type TranscribeOptions = {
  language?: string;
  signal?: AbortSignal;
  onUsage?: (usage: TranscribeUsage) => void;
  /** Use a model's native diarization when it is documented to support it. */
  diarize?: boolean;
  onSegments?: (segments: TranscriptSegment[]) => void;
};

/** Converts provider-specific verbose transcription output into stable speaker-labelled turns. */
export function nativeSegments(model: string, value: unknown): TranscriptSegment[] {
  if (!value || typeof value !== 'object') return [];
  const response = value as { segments?: unknown; words?: unknown };
  const items = model === 'elevenlabs/scribe-v2' && Array.isArray(response.words) ? response.words : response.segments;
  if (!Array.isArray(items)) return [];
  const words = items.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const part = item as Record<string, unknown>;
    const text = typeof part.word === 'string' ? part.word : typeof part.text === 'string' ? part.text : '';
    const start = typeof part.start === 'number' ? part.start : NaN;
    const end = typeof part.end === 'number' ? part.end : NaN;
    const speaker = part.speaker_label ?? part.speaker;
    return text && Number.isFinite(start) && Number.isFinite(end) && speaker != null ? [{ text, start, end, speaker: String(speaker) }] : [];
  });
  // ElevenLabs returns one word at a time; grouping preserves its speaker boundaries while keeping the UI practical.
  return words.reduce<TranscriptSegment[]>((out, word) => {
    const previous = out[out.length - 1];
    if (previous && previous.speaker === word.speaker) {
      previous.text += `${/^[,.;:!?)]/.test(word.text) ? '' : ' '}${word.text}`;
      previous.end = word.end;
    } else out.push({ ...word });
    return out;
  }, []);
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('The analysis was cancelled.', 'AbortError'));
    });
  });

export async function transcribe(
  key: string,
  model: string,
  audio: { data: string; format: string },
  options: TranscribeOptions = {},
) {
  if (await routedThroughProxy()) {
    const { proxyTranscribe } = await import('./proxy');
    return proxyTranscribe(key, model, audio, options);
  }
  const nativeDiarization = Boolean(options.diarize && supportsNativeDiarization(model));
  const body = JSON.stringify({
    model,
    input_audio: { data: audio.data, format: audio.format },
    ...(options.language ? { language: options.language } : {}),
    ...(nativeDiarization && model === 'microsoft/mai-transcribe-2'
      ? {
          response_format: 'verbose_json',
          timestamp_granularities: ['word'],
          provider: { options: { azure: { diarization: { enabled: true } } } },
        }
      : nativeDiarization
        ? {
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
            provider: { options: { elevenlabs: { diarize: true, num_speakers: 2, tag_audio_events: false } } },
          }
        : {}),
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request(`${base}/audio/transcriptions`, { method: 'POST', headers: headers(key), body }, options.signal);
      const out = (await response.json()) as { text?: unknown; usage?: { cost?: unknown }; segments?: unknown; words?: unknown };
      if (typeof out.text !== 'string') throw new RouterError(502, 'The transcription model returned no text.');
      if (nativeDiarization) options.onSegments?.(nativeSegments(model, out));
      options.onUsage?.({
        generationId: response.headers?.get?.('x-generation-id') ?? undefined,
        cost: typeof out.usage?.cost === 'number' ? out.usage.cost : null,
      });
      return out.text;
    } catch (error) {
      const retryable = error instanceof RouterError && (error.status === 0 || error.status === 429 || error.status >= 500);
      if (attempt >= 1 || !retryable) throw error;
      await wait(1500, options.signal);
    }
  }
}

/** Best-effort lookup of the real billed cost of one request (used for speech-to-text, whose response carries no cost). */
export async function getGenerationCost(key: string, id: string): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await request(`${base}/generation?id=${encodeURIComponent(id)}`, { headers: headers(key) });
      const body = (await response.json()) as { data?: { total_cost?: unknown } };
      if (typeof body.data?.total_cost === 'number') return body.data.total_cost;
    } catch {
      /* the stats can lag a moment behind the request; try again */
    }
    await wait(1200);
  }
  return null;
}

export type KeyInfo = { ok: true; label: string; usage: number; limit: number | null; remaining: number | null };

/** Checks an OpenRouter key without spending anything. Throws a RouterError with readable text when the key is rejected. */
export async function validateKey(key: string, signal?: AbortSignal): Promise<KeyInfo> {
  const trimmed = key.trim();
  if (!trimmed) throw new RouterError(401, friendly(401, ''));
  const get = (path: string) => request(`${base}${path}`, { headers: headers(trimmed) }, signal);
  let response: Response;
  try {
    response = await get('/key');
  } catch (error) {
    if (!(error instanceof RouterError) || error.status !== 404) throw error;
    response = await get('/auth/key'); // older path, kept as a fallback
  }
  const body = (await response.json().catch(() => undefined)) as { data?: { label?: unknown; usage?: unknown; limit?: unknown } } | undefined;
  const data = body?.data;
  if (!data || typeof data !== 'object') throw new RouterError(502, 'OpenRouter returned an unexpected response while checking the key.');
  const usage = typeof data.usage === 'number' ? data.usage : 0;
  const limit = typeof data.limit === 'number' ? data.limit : null;
  return { ok: true, label: typeof data.label === 'string' ? data.label : '', usage, limit, remaining: limit == null ? null : limit - usage };
}
