-- QuantumCX Form Service — client_sites + client_leads
--
-- Multi-tenant lead capture for the 48-Hour Form Fix. One row per client site,
-- one row per enquiry. Separate from public.leads, which is quantumcx.net's own
-- funnel and has a different shape.

create table if not exists public.client_sites (
  id            uuid primary key default gen_random_uuid(),
  clinic_name   text not null,
  domain        text not null,               -- allowed Origin, e.g. heliosclinickw.com
  notify_email  text not null,               -- where enquiries are sent
  api_key       text not null unique,        -- public key in the snippet
  active        boolean not null default true,
  -- Not in the spec's schema, but the spec's own email template asks for the
  -- timestamp "in the clinic's local timezone" — unimplementable without
  -- storing one. IANA name, e.g. Asia/Kolkata.
  timezone      text not null default 'UTC',
  created_at    timestamptz not null default now()
);

create table if not exists public.client_leads (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references public.client_sites(id),
  name          text,
  email         text,
  phone         text,
  message       text,
  source_url    text,
  user_agent    text,
  notified_at   timestamptz,                 -- null = email failed, needs retry
  created_at    timestamptz not null default now()
);

create index if not exists client_leads_site_created_idx
  on public.client_leads (site_id, created_at desc);

-- Supports the 60-second rate-limit count without scanning the site's history.
create index if not exists client_leads_created_idx
  on public.client_leads (created_at desc);

-- Lookup by the key the snippet carries.
create unique index if not exists client_sites_api_key_idx
  on public.client_sites (api_key);

-- RLS on, no policies: service role only, exactly as public.leads is set up.
-- The api_key is public by design; it identifies a site, it authorises nothing.
alter table public.client_sites enable row level security;
alter table public.client_leads enable row level security;
