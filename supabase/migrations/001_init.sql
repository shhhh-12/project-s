-- CallScore Supabase schema
-- Teams, members, calls, analyses, cost items with row-level security

-- Teams
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- Team members with roles
create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('manager', 'rep')),
  created_at timestamptz not null default now(),
  unique(team_id, user_id)
);

-- Calls (audio recordings)
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  title text not null,
  audio_path text, -- path in Supabase Storage
  duration_seconds integer,
  created_at timestamptz not null default now()
);

-- Analyses
create table if not exists analyses (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  title text not null,
  summary text,
  score_total numeric(5,1),
  score_band text,
  compliance_status text,
  confidence text,
  transcript jsonb,
  criteria jsonb,
  red_flags jsonb,
  strengths jsonb,
  improvements jsonb,
  try_saying text,
  objections jsonb,
  warnings jsonb,
  timings jsonb,
  models jsonb,
  pack_version text,
  prompt_version text,
  created_at timestamptz not null default now()
);

-- Cost items
create table if not exists cost_items (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid not null references analyses(id) on delete cascade,
  step text not null,
  label text,
  model text,
  seconds numeric,
  prompt_tokens integer,
  completion_tokens integer,
  cost numeric(10,8),
  source text,
  created_at timestamptz not null default now()
);

-- Storage bucket for audio files
insert into storage.buckets (id, name, public) values ('call-audio', 'call-audio', false) on conflict do nothing;

-- RLS policies
alter table teams enable row level security;
alter table team_members enable row level security;
alter table calls enable row level security;
alter table analyses enable row level security;
alter table cost_items enable row level security;

-- Teams: managers see their team, reps see their team
create policy "teams_select" on teams for select using (
  exists (select 1 from team_members tm where tm.team_id = teams.id and tm.user_id = auth.uid())
);

-- Team members: see members of your team
create policy "team_members_select" on team_members for select using (
  exists (select 1 from team_members tm where tm.team_id = team_members.team_id and tm.user_id = auth.uid())
);

-- Calls: team members see team's calls
create policy "calls_select" on calls for select using (
  exists (select 1 from team_members tm where tm.team_id = calls.team_id and tm.user_id = auth.uid())
);
create policy "calls_insert" on calls for insert with check (
  exists (select 1 from team_members tm where tm.team_id = calls.team_id and tm.user_id = auth.uid())
);

-- Analyses: team members see team's analyses
create policy "analyses_select" on analyses for select using (
  exists (select 1 from team_members tm where tm.team_id = analyses.team_id and tm.user_id = auth.uid())
);
create policy "analyses_insert" on analyses for insert with check (
  exists (select 1 from team_members tm where tm.team_id = analyses.team_id and tm.user_id = auth.uid())
);

-- Cost items: team members see their team's cost items
create policy "cost_items_select" on cost_items for select using (
  exists (
    select 1 from team_members tm
    join analyses a on a.id = cost_items.analysis_id
    where a.team_id = tm.team_id and tm.user_id = auth.uid()
  )
);

-- Storage policies for call-audio bucket
create policy "call-audio_select" on storage.objects for select using (
  bucket_id = 'call-audio' and exists (
    select 1 from team_members tm
    join calls c on c.audio_path = storage.objects.name
    where c.team_id = tm.team_id and tm.user_id = auth.uid()
  )
);
create policy "call-audio_insert" on storage.objects for insert with check (
  bucket_id = 'call-audio' and exists (
    select 1 from team_members tm
    join calls c on c.audio_path = storage.objects.name
    where c.team_id = tm.team_id and tm.user_id = auth.uid()
  )
);
