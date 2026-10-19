-- Telegram is the ship's channel while WhatsApp is parked; message logs record it.
alter type channel add value if not exists 'telegram';
