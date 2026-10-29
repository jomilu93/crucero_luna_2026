-- Conchitas 🐚: who really went to an activity. The host confirms each guest who came (host_confirmed_at); a guest
-- confirms the activity happened (guest_confirmed_at). Points are derived from these rows, never stored.
create table attendance (
  activity_id         text not null references activity(id) on delete cascade,
  person_id           uuid not null references person(id) on delete cascade,
  host_confirmed_at   timestamptz,
  guest_confirmed_at  timestamptz,
  primary key (activity_id, person_id)
);
create index attendance_person on attendance (person_id);
alter table delivery drop constraint delivery_kind_check;
alter table delivery add constraint delivery_kind_check
  check (kind in ('morning', 'morning_full', 'reminder', 'sponsor_nudge', 'announcement', 'attendance_ask'));
