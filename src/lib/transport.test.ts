import { afterEach, describe, expect, it } from 'vitest';
import { chatJson, listModels, transcribe } from './openrouter';
import { z } from 'zod';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const schema = z.object({ ok: z.boolean() });
const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });

describe('transport routing', () => {
  it('calls OpenRouter directly when there is no session', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return ok({ choices: [{ message: { content: '{"ok":true}' } }] });
    }) as typeof fetch;

    const result = await chatJson('sk-or-key', 'model', 'sys', 'user', schema);
    expect(result.data.ok).toBe(true);
    expect(calls[0]).toContain('openrouter.ai');
  });

  it('propagates an abort so cancellation still works', async () => {
    globalThis.fetch = (async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('turns a network failure into a friendly router error', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('failed to fetch');
    }) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).rejects.toThrow(/Could not reach OpenRouter/);
  });

  it('maps a 401 to a message about the key', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).rejects.toThrow(/rejected the API key/);
  });

  it('rejects a response that is not the expected shape', async () => {
    globalThis.fetch = (async () => ok({ choices: [{ message: { content: '{"nope":1}' } }] })) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).rejects.toThrow(/not in the expected format/);
  });

  it('rejects an empty model response', async () => {
    globalThis.fetch = (async () => ok({ choices: [{ message: { content: '  ' } }] })) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).rejects.toThrow(/empty response/);
  });

  it('surfaces the transcription text', async () => {
    globalThis.fetch = (async () => ok({ text: 'vanakkam' })) as typeof fetch;
    await expect(transcribe('k', 'stt', { data: 'AA==', format: 'wav' })).resolves.toBe('vanakkam');
  });

  it('surfaces a transcription failure as a router error', async () => {
    globalThis.fetch = (async () => ok({})) as typeof fetch;
    await expect(transcribe('k', 'stt', { data: 'AA==', format: 'wav' })).rejects.toThrow(/returned no text/);
  });

  it('lists speech-to-text models when asked for them', async () => {
    let asked = '';
    globalThis.fetch = (async (url: unknown) => {
      asked = String(url);
      return ok({ data: [{ id: 'a/stt', name: 'A stt' }, { id: 'b/stt', name: 'B stt' }] });
    }) as typeof fetch;
    const models = await listModels('k', 'transcription');
    expect(asked).toContain('output_modalities=transcription');
    expect(models.map((m) => m.id)).toEqual(['a/stt', 'b/stt']);
  });

  it('falls back to a direct call when the proxy module is unavailable', async () => {
    // No Supabase env vars, so hasSession() reports no session and the direct path is used.
    globalThis.fetch = (async (url: unknown) => {
      expect(String(url)).toContain('openrouter.ai');
      return ok({ choices: [{ message: { content: '{"ok":true}' } }] });
    }) as typeof fetch;
    await expect(chatJson('k', 'm', 's', 'u', schema)).resolves.toMatchObject({ data: { ok: true } });
  });
});