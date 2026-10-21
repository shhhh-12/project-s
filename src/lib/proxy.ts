import { z } from 'zod';
import type { RouterModel } from '../config/models';
import { getSession, getSupabase, isSupabaseConfigured } from './supabase';
import { RouterError, chatBody, extractJson, looksTruncated, nativeSegments, type TranscribeOptions, type Usage, withChatFallbacks } from './openrouter';
import { supportsNativeDiarization } from '../config/models';

/** The server transport is available only to an authenticated Supabase user. */
export async function hasSession(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    return Boolean(await getSession());
  } catch {
    return false;
  }
}

async function invoke<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  // This identifier is diagnostic-only. It lets a developer find one request in Edge Function logs
  // without sending a call recording, transcript, API key, or user identifier to the log stream.
  const traceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const { data, error } = await getSupabase().functions.invoke('openrouter-proxy', { body: { ...body, trace_id: traceId }, signal });
  if (error) {
    const context = (error as { context?: Response }).context;
    const status = context?.status ?? 502;
    const payload = (await context?.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
    throw new RouterError(status, `${payload?.error?.message ?? 'The team analysis service could not complete the request.'} (trace: ${traceId})`);
  }
  return data as T;
}

export async function proxyListModels(kind: 'text' | 'transcription'): Promise<RouterModel[]> {
  const payload = await invoke<{ data?: RouterModel[] }>({ listModels: true, kind });
  const models = (payload.data ?? []).filter((model): model is RouterModel => Boolean(model?.id));
  return kind === 'text'
    ? models.filter((model) => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'))
    : models;
}

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }), finish_reason: z.string().nullish() })).min(1),
  usage: z.object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish(), total_tokens: z.number().nullish(), cost: z.number().nullish() }).nullish(),
});
const describeIssues = (error: z.ZodError) => error.issues.slice(0, 2).map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`).join('; ');

export async function proxyChatJson<T>(_key: string, model: string, system: string, user: string, schema: z.ZodType<T>, signal?: AbortSignal, maxTokens = 6000): Promise<{ data: T; usage: Usage }> {
  const safeMaxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 6000;
  const result = await withChatFallbacks(async (jsonMode, strict) => responseSchema.safeParse(await invoke<Record<string, unknown>>(chatBody(model, system, user, safeMaxTokens, jsonMode, strict), signal)));
  if (!result.success) throw new RouterError(502, 'The team analysis service returned an unexpected response.');
  const choice = result.data.choices[0];
  const content = choice.message.content;
  if (!content?.trim()) throw new RouterError(502, 'The selected model returned an empty response. Try a different analysis model.');
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    throw new RouterError(502, choice.finish_reason === 'length' || looksTruncated(content) ? 'The model ran out of output space before finishing its answer.' : 'The selected model did not return valid JSON. Try again or choose another model.');
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) throw new RouterError(502, `The model's answer was not in the expected format (${describeIssues(checked.error)}). Try again or choose another model.`);
  return { data: checked.data, usage: result.data.usage };
}

export async function proxyTranscribe(_key: string, model: string, audio: { data: string; format: string }, options: TranscribeOptions = {}): Promise<string> {
  const nativeDiarization = Boolean(options.diarize && supportsNativeDiarization(model));
  const result = await invoke<{ text?: unknown; usage?: { cost?: unknown }; segments?: unknown }>({
    model,
    input_audio: audio,
    ...(options.language ? { language: options.language } : {}),
    ...(nativeDiarization && model === 'microsoft/mai-transcribe-2'
      ? { response_format: 'verbose_json', timestamp_granularities: ['word'], provider: { options: { azure: { diarization: { enabled: true } } } } }
      : nativeDiarization && model === 'elevenlabs/scribe-v2'
        ? { response_format: 'verbose_json', timestamp_granularities: ['word'], provider: { options: { elevenlabs: { diarize: true, num_speakers: 2, tag_audio_events: false } } } }
        : {}),
  }, options.signal);
  if (typeof result.text !== 'string') throw new RouterError(502, 'The transcription model returned no text.');
  if (nativeDiarization) options.onSegments?.(nativeSegments(model, result));
  options.onUsage?.({ cost: typeof result.usage?.cost === 'number' ? result.usage.cost : null });
  return result.text;
}
