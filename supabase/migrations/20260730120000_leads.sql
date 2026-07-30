-- QuantumCX — lead capture
-- Safe to re-run: creates the table if missing, and backfills the company
-- column onto an older version of the table that predates it.

create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text,
  email       text not null,
  company     text,
  source      text,
  user_agent  text,
  crm_synced  boolean not null default false
);

alter table public.leads add column if not exists company    text;
alter table public.leads add column if not exists source     text;
alter table public.leads add column if not exists user_agent text;
alter table public.leads add column if not exists crm_synced boolean not null default false;

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_email_idx      on public.leads (email);

-- RLS on, and deliberately NO policies.
--
-- The browser never talks to this table: it posts to the submit-lead Edge
-- Function, which uses the service role and bypasses RLS. With RLS enabled and
-- zero policies, the public anon key can neither read nor write here — so even
-- if that key leaks (it is public by design), your lead list stays private.
alter table public.leads enable row level security;
