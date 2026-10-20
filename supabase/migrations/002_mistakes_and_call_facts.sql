-- CallScore: store the per-call mistakes, model-read call facts and the optional enquiry/call times.
-- Safe to run more than once. The app keeps working if this is not applied yet (the import function
-- retries without these columns), but the new data is only saved to the team database once it is.

alter table analyses add column if not exists mistakes jsonb;
alter table analyses add column if not exists call_facts jsonb;
alter table analyses add column if not exists enquired_at timestamptz;
alter table analyses add column if not exists called_at timestamptz;

