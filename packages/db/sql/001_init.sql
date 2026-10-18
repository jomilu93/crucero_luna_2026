-- Crucero Luna 2026 · Postgres schema (Supabase). Mirrors packages/db/src/types.ts.
-- All timestamps are timestamptz (UTC); the ship's clock is America/Mexico_City (fixed UTC-6).

-- gen_random_uuid() is core Postgres (13+); no extensions needed, so the schema also runs on PGlite in tests.

-- Accent-insensitive matching for passenger names without the unaccent extension
-- (Supabase has it, PGlite in tests does not).
create or replace function unaccent_lite(t text) returns text language sql immutable as $$
  select translate(t, 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')
$$;

create type language as enum ('es', 'en');
create type person_role as enum ('adult', 'kid');
create type humor_level as enum ('full', 'light', 'off');
create type activity_status as enum ('draft', 'published', 'cancelled');
create type signup_status as enum ('going', 'maybe', 'out');
create type channel as enum ('cli', 'whatsapp', 'web', 'voice', 'system');

create table person (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  nickname      text,
  phone_e164    text unique,
  language      language not null default 'es',
  role          person_role not null default 'adult',
  guardian_id   uuid references person(id),
  humor         humor_level not null default 'full',
  quiet_start   time,
  quiet_end     time,
  wake_time     time not null default '07:30',
  ics_token     text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 20),
  joined_at     timestamptz not null default now(),
  preferences   jsonb not null default '{}'::jsonb
);

create table activity (
  id               text primary key default substr(gen_random_uuid()::text, 1, 8),
  title            text not null,
  emoji            text not null default '🚢',
  description      text,
  sponsor_id       uuid not null references person(id),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  location         text not null,
  capacity         int check (capacity is null or capacity > 0),
  bring            text,
  status           activity_status not null default 'published',
  flyer_url        text,
  created_via      channel not null default 'web',
  created_at       timestamptz not null default now(),
  cancelled_reason text,
  check (ends_at > starts_at)
);
create index activity_starts_at_idx on activity (starts_at) where status <> 'cancelled';

create table signup (
  activity_id  text not null references activity(id) on delete cascade,
  person_id    uuid not null references person(id) on delete cascade,
  status       signup_status not null default 'going',
  created_at   timestamptz not null default now(),
  reminded_at  timestamptz,
  primary key (activity_id, person_id)
);

create table memory (
  person_id   uuid not null references person(id) on delete cascade,
  key         text not null,
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (person_id, key)
);

create table message_log (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid references person(id) on delete set null,
  channel     channel not null,
  direction   text not null check (direction in ('in', 'out')),
  body        text not null,
  media_url   text,
  tool_calls  jsonb,
  ts          timestamptz not null default now()
);
create index message_log_person_ts_idx on message_log (person_id, ts desc);

-- Chat history per passenger (Anthropic message params as JSON), so WhatsApp turns continue.
create table conversation (
  person_id   uuid primary key references person(id) on delete cascade,
  history     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Idempotency for scheduled sends (morning program, reminders, nudges).
create table delivery (
  kind     text not null check (kind in ('morning', 'morning_full', 'reminder', 'sponsor_nudge', 'announcement')),
  key      text not null,
  sent_at  timestamptz not null default now(),
  payload  jsonb,
  primary key (kind, key)
);

-- Reminder sweep: every (activity, person) going/maybe pair whose T-30 has arrived and is unsent.
create view due_reminders as
select s.activity_id, s.person_id, a.starts_at
from signup s
join activity a on a.id = s.activity_id
where a.status = 'published'
  and s.status in ('going', 'maybe')
  and s.reminded_at is null
  and a.starts_at between now() and now() + interval '30 minutes';
