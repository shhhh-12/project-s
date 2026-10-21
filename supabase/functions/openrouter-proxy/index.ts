// Edge Function: openrouter-proxy
//
// Holds the OpenRouter API key server-side. The browser sends its Supabase JWT and a plain
// request body; this function forwards it to OpenRouter and returns the response untouched.
//
// Supported bodies:
//   { model, messages, ... }        -> POST /chat/completions
//   { model, input_audio, language } -> POST /audio/transcriptions
//   { listModels: true, kind }      -> GET  /models

import { createClient } from 'jsr:@supabase/supabase-js@2';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Allows diagnostics to correlate one request without logging call content, auth tokens or user IDs. */
const traceOf = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9-]{8,80}$/.test(value) ? value : crypto.randomUUID();
const routeOf = (body: Record<string, unknown>) => body.listModels === true ? 'models' : 'input_audio' in body ? 'transcription' : 'chat';
const audioBytesOf = (body: Record<string, unknown>) => {
  const data = (body.input_audio as { data?: unknown } | undefined)?.data;
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
};

/** Verifies the caller's JWT and returns their user id, or null when invalid. */
async function authenticate(req: Request): Promise<string | null> {
  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) {
    // Auth service unreachable: refuse rather than proxy unauthenticated traffic.
    return null;
  }
  const supabase = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const userId = await authenticate(req);
  if (!userId) {
    return new Response(JSON.stringify({ error: { message: 'Sign in to use the analysis service.' } }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) {
    return new Response(JSON.stringify({ error: { message: 'The server has no OpenRouter key configured.' } }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body.' } }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  const traceId = traceOf(requestBody.trace_id);
  const body = Object.fromEntries(Object.entries(requestBody).filter(([key]) => key !== 'trace_id'));
  const route = routeOf(body);
  const model = typeof body.model === 'string' ? body.model.slice(0, 160) : undefined;
  const started = performance.now();
  const log = (event: 'completed' | 'failed', status: number) => console.log(JSON.stringify({
    event: 'openrouter_proxy',
    outcome: event,
    trace_id: traceId,
    route,
    ...(model ? { model } : {}),
    ...(route === 'transcription' ? { audio_bytes: audioBytesOf(body) } : {}),
    status,
    elapsed_ms: Math.round(performance.now() - started),
  }));

  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': Deno.env.get('APP_ORIGIN') ?? 'http://localhost',
    'X-Title': 'CallScore',
  };

  try {
    let url: string;
    let payload: string;

    if (body.listModels === true) {
      const kind = typeof body.kind === 'string' ? body.kind : 'text';
      url = kind === 'transcription'
        ? `${OPENROUTER_URL}/models?output_modalities=transcription`
        : `${OPENROUTER_URL}/models`;
      payload = '{}';
    } else if (typeof body.model !== 'string' || !body.model) {
      log('failed', 400);
      return new Response(JSON.stringify({ error: { message: 'Missing model.' } }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } else if ('input_audio' in body) {
      url = `${OPENROUTER_URL}/audio/transcriptions`;
      payload = JSON.stringify(body);
    } else {
      url = `${OPENROUTER_URL}/chat/completions`;
      payload = JSON.stringify(body);
    }

    const upstream = await fetch(url, { method: 'POST', headers: upstreamHeaders, body: payload });
    const text = await upstream.text();
    const headers: Record<string, string> = { ...cors, 'Content-Type': 'application/json' };
    // The browser reads this to look up the billed amount for a transcription.
    const generationId = upstream.headers.get('x-generation-id');
    if (generationId) headers['x-generation-id'] = generationId;
    if (!upstream.ok) headers['x-openrouter-status'] = String(upstream.status);
    headers['x-callscore-trace-id'] = traceId;
    log(upstream.ok ? 'completed' : 'failed', upstream.status);
    return new Response(text, { status: upstream.status, headers });
  } catch (error) {
    log('failed', 502);
    return new Response(JSON.stringify({ error: { message: `Could not reach OpenRouter: ${error.message}` } }), {
      status: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
