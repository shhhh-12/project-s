// Edge Function: import-history
//
// One-time import of analyses that already live in the browser's IndexedDB. The browser reads its
// own local history and posts it here; this function creates the call + analysis rows and writes
// the itemised cost rows so the dashboard and cost reporting have real data to work with.
//
// Verifies the caller's JWT and refuses to write into a team the caller is not a member of.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const header = req.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) return json({ error: 'Sign in to import history.' }, 401);
  const token = header.slice(7);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return json({ error: 'The server is missing its Supabase configuration.' }, 500);

  const supabase = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } } });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) return json({ error: 'Sign in to import history.' }, 401);
  const userId = userData.user.id;

  let body: { team_id?: string; analyses?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }
  const teamId = body.team_id;
  const incoming = Array.isArray(body.analyses) ? body.analyses : [];
  if (!teamId) return json({ error: 'Missing team_id.' }, 400);
  if (!incoming.length) return json({ imported: 0, skipped: 0, message: 'Nothing to import.' });

  // Authorization check: the caller must belong to the target team.
  const { data: membership, error: memberError } = await supabase
    .from('team_members')
    .select('team_id, role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memberError) return json({ error: `Membership check failed: ${memberError.message}` }, 500);
  if (!membership) return json({ error: 'You are not a member of that team.' }, 403);

  // Already-imported analyses are skipped so re-running is safe.
  const ids = incoming.map((a) => (a as { id?: unknown }).id).filter((id): id is string => typeof id === 'string');
  const { data: existing } = await supabase.from('analyses').select('id').in('id', ids);
  const seen = new Set((existing ?? []).map((row) => row.id));

  let imported = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (const raw of incoming) {
    const a = raw as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id : crypto.randomUUID();
    if (typeof a.id === 'string' && seen.has(a.id)) {
      skipped++;
      continue;
    }
    const createdAt = typeof a.created_at === 'string' ? a.created_at : new Date().toISOString();
    const title = typeof a.title === 'string' && a.title.trim() ? a.title : 'Imported call';
    const duration = typeof a.duration === 'number' ? a.duration : 0;

    const { data: call, error: callError } = await supabase
      .from('calls')
      .insert({ id: crypto.randomUUID(), team_id: teamId, uploaded_by: userId, title, duration_seconds: Math.round(duration), created_at: createdAt })
      .select('id')
      .single();
    if (callError || !call) {
      failures.push(`${title}: ${callError?.message ?? 'could not create the call row'}`);
      continue;
    }

    const row = {
      id,
      call_id: call.id,
      team_id: teamId,
      title,
      summary: typeof a.summary === 'string' ? a.summary : '',
      confidence: typeof a.confidence === 'string' ? a.confidence : 'medium',
      transcript: a.transcript ?? [],
      criteria: a.criteria ?? [],
      red_flags: a.red_flags ?? [],
      strengths: a.strengths ?? [],
      improvements: a.improvements ?? [],
      try_saying: typeof a.try_saying === 'string' ? a.try_saying : '',
      objections: a.objections ?? [],
      warnings: a.warnings ?? [],
      timings: a.timings ?? {},
      models: a.models ?? {},
      pack_version: typeof a.pack_version === 'string' ? a.pack_version : '1.0',
      prompt_version: typeof a.prompt_version === 'string' ? a.prompt_version : 'unknown',
      created_at: createdAt,
    };
    // Columns added by migration 002. If it has not been applied yet, retry without them so the import still works.
    const extra = {
      mistakes: a.mistakes ?? [],
      call_facts: a.call_facts ?? null,
      enquired_at: typeof a.enquired_at === 'string' ? a.enquired_at : null,
      called_at: typeof a.called_at === 'string' ? a.called_at : null,
    };
    let { error: analysisError } = await supabase.from('analyses').insert({ ...row, ...extra });
    if (analysisError && /mistakes|call_facts|enquired_at|called_at|schema cache|column/i.test(analysisError.message)) {
      ({ error: analysisError } = await supabase.from('analyses').insert(row));
    }
    if (analysisError) {
      failures.push(`${title}: ${analysisError.message}`);
      continue;
    }
    imported++;

    // Cost rows, only when the browser recorded them.
    const costs = Array.isArray(a.costs) ? (a.costs as Array<Record<string, unknown>>) : [];
    if (costs.length) {
      const rows = costs.map((cost) => ({
        analysis_id: id,
        step: typeof cost.step === 'string' ? cost.step : 'score',
        label: typeof cost.label === 'string' ? cost.label : '',
        model: typeof cost.model === 'string' ? cost.model : '',
        seconds: typeof cost.seconds === 'number' ? cost.seconds : null,
        prompt_tokens: typeof cost.prompt_tokens === 'number' ? cost.prompt_tokens : null,
        completion_tokens: typeof cost.completion_tokens === 'number' ? cost.completion_tokens : null,
        cost: typeof cost.cost === 'number' ? cost.cost : null,
        source: typeof cost.source === 'string' ? cost.source : 'unavailable',
      }));
      await supabase.from('cost_items').insert(rows);
    }
  }

  return json({ imported, skipped, failed: failures.length, failures: failures.slice(0, 10) });
});