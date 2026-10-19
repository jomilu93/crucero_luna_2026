-- Passenger opted out of proactive messages ("ya no me mandes nada"): no morning program,
-- reminders, nudges or announcements. The Capitán still answers when they write.
alter table person add column muted boolean not null default false;
