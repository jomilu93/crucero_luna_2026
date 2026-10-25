-- The passenger's own phone number (E.164), given when they join on the website. It is separate from phone_e164,
-- the chat address (tg:<chat id> today, the WhatsApp number later), so a web-only passenger has a number but no chat.
alter table person add column contact_phone text unique;
