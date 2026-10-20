# CallScore — Supabase Backend Setup Guide

The OpenRouter key now lives on your server. When Supabase is configured, the app requires sign-in and all model calls go through the `openrouter-proxy` Edge Function. Without those env vars the app falls back to the original browser-held-key mode, so nothing breaks locally.

## Prerequisites

- Supabase CLI: `npm install -g supabase-cli`
- App dependencies installed: `npm install`
- Link the project once: `supabase link --project-ref acrhlzlosbbyprmbpdtw`

---

## Step 1: Run the SQL migration

1. Supabase dashboard → **SQL Editor** → **New Query**
2. Paste the whole of `supabase/migrations/001_init.sql`
3. Click **Run**

Creates `teams`, `team_members`, `calls`, `analyses`, `cost_items`, enables RLS on all of them, and creates the private `call-audio` storage bucket.

---

## Step 2: Deploy the Edge Functions

```bash
supabase functions deploy openrouter-proxy
supabase functions deploy import-history
```

Both include a `deno.json` with `"verify_jwt": false`. That is deliberate: the functions verify the caller's JWT themselves via `auth.getUser(token)`, which returns the real error message instead of a bare gateway rejection. JWT verification is not skipped.

---

## Step 3: Set secrets

```bash
supabase secrets set OPENROUTER_API_KEY=sk-or-your-key-here
supabase secrets set APP_ORIGIN=https://your-app-domain.com
```

`OPENROUTER_API_KEY` is the key that moves off the browser. `APP_ORIGIN` is optional and only affects the `HTTP-Referer` header OpenRouter uses for its dashboard.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically by the platform — do not set them by hand.

---

## Step 4: Rotate the service key

The service key posted in chat is compromised. In the dashboard go to **Settings → API** and roll it. The app never uses it; rotating it invalidates only past exposures.

---

## Step 5: Configure the app

Create `.env` in the project root:

```
VITE_SUPABASE_URL=https://acrhlzlosbbyprmbpdtw.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_HemZjRguq5Xdzt4tw0pB2Q_UxUr_BfK
```

Only the **publishable** key belongs here. Never put the service key in a `VITE_` variable — everything prefixed `VITE_` is inlined into the browser bundle.

To run in the original browser-only mode, delete `.env` or leave the values blank.

---

## Step 6: Create your team

The migration creates no team, so the first account needs one:

1. Sign in at your app (Dashboard tab appears in the header).
2. Call `createTeam` from the dashboard, or paste this once in the SQL editor with your user id:

```sql
insert into teams (name, created_by)
select 'My Sales Team', id from auth.users where email = 'you@example.com'
returning id;
```

```sql
insert into team_members (team_id, user_id, role)
select '<team id from above>', id, 'manager' from auth.users where email = 'you@example.com';
```

Team creation from the UI is the one piece still to build; until then this is a one-time manual step.

---

## Step 7: Import existing browser history

Open **Dashboard** → **Import this browser's history**. This posts every analysis currently in IndexedDB to `import-history`, which creates the `calls` and `analyses` rows plus the cost rows. Existing ids are skipped, so running it twice is safe. Audio blobs stay in the browser and are not uploaded.

---

## What changed in behaviour

| Before | Now |
|---|---|
| API key typed into Settings | No key in the browser when signed in |
| Calls go straight to `openrouter.ai` | Calls go to `openrouter-proxy`, which holds the key |
| No sign-in | Sign-in required when Supabase is configured |
| History in IndexedDB only | History still local, plus optional one-time import to Postgres |
| Re-analysing a recording always cost money | Transcripts and reports are cached; a repeat run is free |

---

## Cache

Transcripts and reports are fingerprinted with SHA-256 and stored in IndexedDB, so analysing the same recording twice costs nothing the second time.

- **Transcript key** — audio bytes + speech-to-text model + language. Change the model or language and it re-transcribes.
- **Report key** — the exact scoring prompt (which contains the transcript) + analysis model + prompt version + single/double-scoring mode. Change any of those and it re-scores.

Cached results carry a review note saying the saved result was reused. **Settings → Cache** shows the entry count and total size, with a **Clear cache** button.

The cache is an optimisation only: if IndexedDB is unavailable (private browsing) every call silently no-ops rather than failing the analysis. Cached data stays in the browser — nothing is sent to Supabase.

---

## Troubleshooting

**401 on every call** — the session expired or the token is not reaching the function. Check the request headers in DevTools; `Authorization: Bearer <jwt>` must be present.

**"The server has no OpenRouter key configured"** — `supabase secrets list` and confirm `OPENROUTER_API_KEY` is set for the environment you deployed to.

**Sign-in succeeds but analysis fails immediately** — the function cannot reach the auth service. Confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` are present in the function environment.

**"You are not a member of a team yet"** — complete Step 6.

**Cost shows as estimated rather than billed** — expected. The Edge Function forwards the `x-generation-id` header, but the billed lookup happens browser-side and needs the key, so it falls back to the published per-hour price.

**Build warns about a chunk over 500 kB** — the Supabase client is bundled. Expected; not an error.

---

## Security checklist

- [x] Service key rotated
- [x] OpenRouter key server-side only, never in `VITE_` vars
- [x] Both functions verify the caller JWT with `auth.getUser` before doing any work
- [x] `import-history` checks team membership before writing
- [x] RLS enabled on all five tables
- [x] `call-audio` bucket is private
- [x] Browser only ever holds the publishable key