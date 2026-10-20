import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL ?? '';
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!url || !publishableKey) {
      throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in your .env file.');
    }
    client = createClient(url, publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

export async function signIn(email: string, password: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signUp(email: string, password: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const supabase = getSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function getSession() {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(callback: (session: unknown) => void) {
  const supabase = getSupabase();
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

export async function getUserTeam(userId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('team_members')
    .select('team_id, role, teams(name)')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createTeam(name: string, userId: string) {
  const supabase = getSupabase();
  const { data: team, error: teamError } = await supabase
    .from('teams')
    .insert({ name, created_by: userId })
    .select()
    .single();
  if (teamError) throw teamError;
  const { error: memberError } = await supabase
    .from('team_members')
    .insert({ team_id: team.id, user_id: userId, role: 'manager' });
  if (memberError) throw memberError;
  return team;
}

export async function joinTeam(teamId: string, userId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('team_members')
    .insert({ team_id: teamId, user_id: userId, role: 'rep' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function listTeamMembers(teamId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('team_members')
    .select('user_id, role, created_at')
    .eq('team_id', teamId);
  if (error) throw error;
  return data;
}

export async function saveCall(call: { id: string; team_id: string; title: string; audio_path?: string; duration_seconds?: number }) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('calls').insert(call).select().single();
  if (error) throw error;
  return data;
}

export async function listCalls(teamId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('calls')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function saveAnalysis(analysis: Record<string, unknown>) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('analyses').insert(analysis).select().single();
  if (error) throw error;
  return data;
}

export async function listAnalyses(teamId: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('analyses')
    .select('*')
    .eq('team_id', teamId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function uploadAudio(callId: string, file: File) {
  const supabase = getSupabase();
  const path = `${callId}/${file.name || 'audio.wav'}`;
  const { error } = await supabase.storage.from('call-audio').upload(path, file, { upsert: true });
  if (error) throw error;
  return path;
}

export async function getAudioUrl(path: string) {
  const supabase = getSupabase();
  const { data } = await supabase.storage.from('call-audio').createSignedUrl(path, 3600);
  return data?.signedUrl ?? '';
}

export function isSupabaseConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
}

export async function deleteCall(callId: string) {
  const supabase = getSupabase();
  const { error } = await supabase.from('calls').delete().eq('id', callId);
  if (error) throw error;
}

export async function deleteAnalysis(analysisId: string) {
  const supabase = getSupabase();
  const { error } = await supabase.from('analyses').delete().eq('id', analysisId);
  if (error) throw error;
}

/**
 * One-time migration of analyses that are only in this browser's IndexedDB.
 * Existing ids are skipped server-side, so running it twice is harmless.
 */
export async function importLocalHistory(teamId: string, analyses: unknown[]) {
  const supabase = getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Sign in before importing history.');
  const url = import.meta.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const response = await fetch(`${url}/functions/v1/import-history`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId, analyses }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || `Import failed (${response.status}).`);
  return body as { imported: number; skipped: number; failed: number; failures?: string[] };
}
