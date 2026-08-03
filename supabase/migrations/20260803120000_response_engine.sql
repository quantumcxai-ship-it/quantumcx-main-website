-- Phase 1 — response engine
--
-- Additive only: nothing is dropped or retyped, so this is safe on live data.
-- first_response_at is the point of the whole migration — without it,
-- "sub-60-second response" is a claim rather than a query.

alter table public.leads
  add column if not exists phone             text,
  add column if not exists message           text,
  add column if not exists channel           text not null default 'form',
  add column if not exists status            text not null default 'new',
  add column if not exists qualified         boolean,
  add column if not exists first_response_at timestamptz,
  add column if not exists booked_at         timestamptz,
  add column if not exists transcript        jsonb not null default '[]'::jsonb;

create index if not exists leads_status_idx  on public.leads (status);
create index if not exists leads_channel_idx on public.leads (channel);

-- Reporting view. security_invoker keeps RLS behaviour identical to the base
-- table: the view does not become a way around the zero-policy lockdown.
create or replace view public.lead_response_times
with (security_invoker = true) as
select
  id,
  created_at,
  channel,
  source,
  status,
  qualified,
  first_response_at,
  booked_at,
  extract(epoch from (first_response_at - created_at))::int as response_seconds
from public.leads;
