// Explicit transport choice. The mode is a user setting; it is never inferred from a Supabase session.
//   direct: the browser calls OpenRouter with a key the user pasted.
//   server: calls go through the Supabase Edge Function, which holds the key.

export type Connection = { mode: 'direct'; key: string } | { mode: 'server' };

const MODE_KEY = 'callscore:mode';
const API_KEY = 'callscore:openrouter-key';

/** Storage can throw (private windows, blocked site data), so every access is guarded. */
const read = (store: () => Storage, name: string): string | null => {
  try {
    return store().getItem(name);
  } catch {
    return null;
  }
};
const write = (store: () => Storage, name: string, value: string | null) => {
  try {
    if (value === null) store().removeItem(name);
    else store().setItem(name, value);
  } catch {
    /* best effort: the app still works for this page load */
  }
};
const local = () => localStorage;
const session = () => sessionStorage;

/** The saved key: this tab's session first, then a remembered one. */
export const loadKey = (): string => read(session, API_KEY) ?? read(local, API_KEY) ?? '';

/** Whether the current key is persisted beyond this browser session. */
export const isKeyRemembered = (): boolean => Boolean(read(local, API_KEY));

/** Keeps the key for this tab only, or across restarts when `remember` is true. Never stores it in both places. */
export function saveKey(key: string, remember = false) {
  const value = key.trim();
  if (!value) return forgetKey();
  write(remember ? local : session, API_KEY, value);
  write(remember ? session : local, API_KEY, null);
}

export function forgetKey() {
  write(session, API_KEY, null);
  write(local, API_KEY, null);
}

export function getConnection(): Connection {
  return read(local, MODE_KEY) === 'server' ? { mode: 'server' } : { mode: 'direct', key: loadKey() };
}

/** Persists only the mode; the key is stored separately with `saveKey`. */
export function setConnection(mode: Connection['mode']) {
  write(local, MODE_KEY, mode);
}
