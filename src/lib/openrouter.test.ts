import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatJson, DEFAULT_MAX_TOKENS, extractJson, listModels, nativeSegments, RouterError, transcribe, validateKey } from './openrouter';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

type Call = { url: string; body?: Record<string, unknown> };
function mock(respond: (call: Call, index: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const out = respond(call, calls.length - 1);
    return new Response(JSON.stringify(out.json), { status: out.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}
const chat = (content: string) => ({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } });

describe('openrouter client', () => {
  it('asks for speech-to-text models with output_modalities=transcription', async () => {
    const calls = mock(() => ({ json: { data: [{ id: 'openai/whisper-1', name: 'Whisper' }] } }));
    const models = await listModels('k', 'transcription');
    expect(calls[0].url).toContain('output_modalities=transcription');
    expect(models[0].id).toBe('openai/whisper-1');
  });
  it('falls back to the unfiltered text list if the filter is rejected', async () => {
    const calls = mock((_, i) => (i === 0 ? { status: 400, json: { error: { message: 'bad param' } } } : { json: { data: [{ id: 'a/b', architecture: { output_modalities: ['text'] } }, { id: 'c/d', architecture: { output_modalities: ['image'] } }] } }));
    const models = await listModels('k', 'text');
    expect(calls).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(['a/b']);
  });
  it('sends language only when set and returns the text', async () => {
    const calls = mock(() => ({ json: { text: 'vanakkam' } }));
    expect(await transcribe('k', 'm', { data: 'AAA', format: 'wav' })).toBe('vanakkam');
    await transcribe('k', 'm', { data: 'AAA', format: 'wav' }, { language: 'ta' });
    expect('language' in (calls[0].body ?? {})).toBe(false);
    expect(calls[1].body?.language).toBe('ta');
    expect(calls[1].body?.input_audio).toEqual({ data: 'AAA', format: 'wav' });
  });
  it('asks Scribe v2 for native diarization and converts labelled words into turns', async () => {
    const calls = mock(() => ({ json: {
      text: 'Vanakkam sir hello',
      words: [
        { word: 'Vanakkam', start: 0, end: 0.4, speaker_label: 'speaker_0' },
        { word: 'sir', start: 0.4, end: 0.6, speaker_label: 'speaker_0' },
        { word: 'hello', start: 0.7, end: 1, speaker_label: 'speaker_1' },
      ],
    } }));
    const segments: unknown[] = [];
    await transcribe('k', 'elevenlabs/scribe-v2', { data: 'AAA', format: 'wav' }, { diarize: true, onSegments: (items) => segments.push(...items) });
    expect(calls[0].body).toMatchObject({
      response_format: 'verbose_json',
      provider: { options: { elevenlabs: { diarize: true, num_speakers: 2 } } },
    });
    expect(segments).toEqual([
      { text: 'Vanakkam sir', start: 0, end: 0.6, speaker: 'speaker_0' },
      { text: 'hello', start: 0.7, end: 1, speaker: 'speaker_1' },
    ]);
  });
  it('normalizes Scribe punctuation while preserving speaker boundaries', () => {
    expect(nativeSegments('elevenlabs/scribe-v2', { words: [
      { word: 'Apadi', start: 0, end: 0.2, speaker: 0 },
      { word: 'thana?', start: 0.2, end: 0.5, speaker: 0 },
      { word: 'Yes.', start: 0.6, end: 0.9, speaker: 1 },
    ] })).toEqual([
      { text: 'Apadi thana?', start: 0, end: 0.5, speaker: '0' },
      { text: 'Yes.', start: 0.6, end: 0.9, speaker: '1' },
    ]);
  });
  it('extracts JSON from fenced or chatty answers', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
  });
  it('retries without JSON mode when the model does not support it', async () => {
    const calls = mock((call) => (call.body?.response_format ? { status: 400, json: { error: { message: 'No endpoints found that support response_format' } } } : chat('{"ok":true}')));
    const { data } = await chatJson('k', 'm', 's', 'u', z.object({ ok: z.boolean() }));
    expect(data.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect('response_format' in (calls[1].body ?? {})).toBe(false);
  });
  it('reports a readable error for malformed or mis-shaped answers', async () => {
    mock(() => chat('not json at all'));
    await expect(chatJson('k', 'm', 's', 'u', z.object({}))).rejects.toThrow(/valid JSON/);
    mock(() => chat('{"ok":"yes"}'));
    await expect(chatJson('k', 'm', 's', 'u', z.object({ ok: z.boolean() }))).rejects.toThrow(/expected format/);
  });
  it('sends deterministic settings: temperature 0, seed 42, max_tokens 6000, strict provider routing', async () => {
    const calls = mock(() => chat('{"ok":true}'));
    await chatJson('k', 'm', 's', 'u', z.object({ ok: z.boolean() }));
    expect(calls[0].body).toMatchObject({ temperature: 0, seed: 42, max_tokens: DEFAULT_MAX_TOKENS, provider: { require_parameters: true } });
    expect(DEFAULT_MAX_TOKENS).toBe(6000);
  });
  it('honours a larger maxTokens and ignores nonsense values', async () => {
    const calls = mock(() => chat('{"ok":true}'));
    const schema = z.object({ ok: z.boolean() });
    await chatJson('k', 'm', 's', 'u', schema, undefined, 12000);
    await chatJson('k', 'm', 's', 'u', schema, undefined, -5);
    expect(calls[0].body?.max_tokens).toBe(12000);
    expect(calls[1].body?.max_tokens).toBe(6000);
  });
  it('retries once without provider.require_parameters, keeping JSON mode', async () => {
    const calls = mock((call) => (call.body?.provider ? { status: 404, json: { error: { message: 'No allowed providers are available for the selected model' } } } : chat('{"ok":true}')));
    const { data } = await chatJson('k', 'm', 's', 'u', z.object({ ok: z.boolean() }));
    expect(data.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect('provider' in (calls[1].body ?? {})).toBe(false);
    expect(calls[1].body?.response_format).toEqual({ type: 'json_object' });
  });
  it('does not retry an error that is not about provider or parameters', async () => {
    const calls = mock(() => ({ status: 400, json: { error: { message: 'Prompt is too long' } } }));
    await expect(chatJson('k', 'm', 's', 'u', z.object({}))).rejects.toThrow(/too long/);
    expect(calls).toHaveLength(1);
  });
  it('explains moderation, timeout and unknown-model failures', async () => {
    mock(() => ({ status: 403, json: { error: { message: 'flagged' } } }));
    await expect(chatJson('k', 'm', 's', 'u', z.object({}))).rejects.toThrow(/moderation/);
    mock(() => ({ status: 504, json: { error: { message: 'gateway' } } }));
    await expect(chatJson('k', 'm', 's', 'u', z.object({}))).rejects.toThrow(/timed out/);
    mock(() => ({ status: 400, json: { error: { message: 'x/y is not a valid model ID' } } }));
    await expect(chatJson('k', 'm', 's', 'u', z.object({}))).rejects.toThrow(/could not find that model/);
  });
  it('never repeats an API key found in a provider error', async () => {
    mock(() => ({ status: 403, json: { error: { message: 'bad key sk-or-v1-abcDEF123_456 sent as Bearer sk-or-v1-abcDEF123_456' } } }));
    const error = (await chatJson('sk-or-v1-abcDEF123_456', 'm', 's', 'u', z.object({})).catch((e: unknown) => e)) as RouterError;
    expect(error.message).not.toContain('abcDEF123_456');
    expect(error.message).toContain('[redacted]');
  });
  it('validateKey reports usage, limit and what is left', async () => {
    const calls = mock(() => ({ json: { data: { label: 'sk-or-v1-abc...xyz', usage: 2.5, limit: 10 } } }));
    expect(await validateKey('k')).toEqual({ ok: true, label: 'sk-or-v1-abc...xyz', usage: 2.5, limit: 10, remaining: 7.5 });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/key');
  });
  it('validateKey reports remaining as null when the key has no limit', async () => {
    mock(() => ({ json: { data: { label: 'k', usage: 1, limit: null } } }));
    expect(await validateKey('k')).toMatchObject({ limit: null, remaining: null });
  });
  it('validateKey falls back to /auth/key when /key is a 404', async () => {
    const calls = mock((_, i) => (i === 0 ? { status: 404, json: { error: { message: 'Not Found' } } } : { json: { data: { label: 'old', usage: 0, limit: null } } }));
    expect(await validateKey('k')).toMatchObject({ ok: true, label: 'old' });
    expect(calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/auth/key']);
  });
  it('validateKey turns a 401 into the friendly key message and rejects an empty key without a request', async () => {
    const calls = mock(() => ({ status: 401, json: { error: { message: 'No auth credentials found' } } }));
    await expect(validateKey('bad')).rejects.toThrow(/rejected the API key/);
    await expect(validateKey('  ')).rejects.toThrow(/rejected the API key/);
    expect(calls).toHaveLength(1);
  });
  it('maps auth failures to a clear message', async () => {
    mock(() => ({ status: 401, json: { error: { message: 'No auth credentials found' } } }));
    const error = await chatJson('k', 'm', 's', 'u', z.object({})).catch((e: unknown) => e);
    expect(error instanceof RouterError).toBe(true);
    expect((error as RouterError).message).toContain('rejected the API key');
  });
});
