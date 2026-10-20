-- Admins (said the ADMIN_PASSWORD in the chat) and ship-wide settings such as the pause switch.
alter table person add column admin boolean not null default false;
create table ship_setting (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
