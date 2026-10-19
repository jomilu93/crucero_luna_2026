/**
 * Capitán Lunático's ship: one process that hosts the chat webhooks (Telegram, WhatsApp), the calendar feeds,
 * and the minute-by-minute scheduler (morning program, reminders, sponsor nudges).
 *
 * Env (see .env.example): DATABASE_URL (Postgres) or CRUCERO_DATA_FILE (dev JSON store),
 * TELEGRAM_BOT_TOKEN (wins when set), META_* or TWILIO_* (WhatsApp), PUBLIC_URL, PORT, WHATSAPP_TEMPLATES=on|off.
 */
import { createServer } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { ChatService, Director, buildMorningBrief, tick, writeMorningMessage, type TemplateOutbox } from "@crucero/agent";
import { MemoryStore, PgStore, fromPostgresJs, seedSample, type Store } from "@crucero/db";
import { createRouter } from "./http.js";
import { MetaWhatsAppOutbox } from "./meta.js";
import { TelegramOutbox, telegramWebhookSecret } from "./telegram.js";
import { TwilioWhatsAppOutbox } from "./twilio.js";

const env = process.env;
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// Store
let store: Store;
if (env.DATABASE_URL) {
  store = new PgStore(fromPostgresJs(postgres(env.DATABASE_URL, { max: 5 })));
  log("store: postgres");
} else {
  const mem = new MemoryStore({ file: env.CRUCERO_DATA_FILE || ".data/crucero.json" });
  if (!mem.snapshot().people.length && env.SEED_SAMPLE !== "off") seedSample(mem);
  store = mem;
  log(`store: json file (${env.CRUCERO_DATA_FILE || ".data/crucero.json"}) — dev only`);
}

// Outbox: Telegram (while WhatsApp is parked), Meta Cloud API direct, Twilio, or the console.
let outbox: TemplateOutbox;
let channel: "telegram" | "meta" | "twilio" | "console";
let telegram: TelegramOutbox | undefined;
if (env.TELEGRAM_BOT_TOKEN) {
  telegram = new TelegramOutbox({ botToken: env.TELEGRAM_BOT_TOKEN }, () => store.listPeople());
  outbox = telegram;
  channel = "telegram";
  log("outbox: telegram bot");
} else if (env.META_ACCESS_TOKEN && env.META_PHONE_NUMBER_ID) {
  channel = "meta";
  outbox = new MetaWhatsAppOutbox(
    {
      accessToken: env.META_ACCESS_TOKEN,
      phoneNumberId: env.META_PHONE_NUMBER_ID,
      appSecret: env.META_APP_SECRET,
      graphVersion: env.META_GRAPH_VERSION || undefined,
      templateLanguage: env.META_TEMPLATE_LANG || undefined,
      templates: {
        morning_knock: env.META_TEMPLATE_MORNING_KNOCK || undefined,
        activity_reminder: env.META_TEMPLATE_REMINDER || undefined,
        new_activity: env.META_TEMPLATE_NEW_ACTIVITY || undefined,
      },
    },
    () => store.listPeople(),
  );
  log(`outbox: meta cloud api (phone number id ${env.META_PHONE_NUMBER_ID})`);
} else if (env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_WHATSAPP_FROM) {
  outbox = new TwilioWhatsAppOutbox(
    {
      accountSid: env.TWILIO_ACCOUNT_SID,
      apiKeySid: env.TWILIO_API_KEY_SID,
      apiKeySecret: env.TWILIO_API_KEY_SECRET,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_WHATSAPP_FROM,
      templates: {
        morning_knock: env.TWILIO_TEMPLATE_MORNING_KNOCK || undefined,
        activity_reminder: env.TWILIO_TEMPLATE_REMINDER || undefined,
        new_activity: env.TWILIO_TEMPLATE_NEW_ACTIVITY || undefined,
      },
    },
    () => store.listPeople(),
  );
  log(`outbox: twilio whatsapp from ${env.TWILIO_WHATSAPP_FROM}`);
  channel = "twilio";
} else {
  channel = "console";
  outbox = {
    send: async (to, text) => log(`[console outbox] → ${to === "everyone" ? "EVERYONE" : to.name}: ${text.replace(/\n/g, " ⏎ ").slice(0, 160)}`),
  };
  log("outbox: console (set TELEGRAM_BOT_TOKEN, META_* or TWILIO_* to send real messages)");
}

// Brain
const client = new Anthropic();
const director = new Director(store, { client, outbox });
const chat = new ChatService(store, director, outbox);

// HTTP
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`;
const telegramSecret = env.TELEGRAM_BOT_TOKEN ? telegramWebhookSecret(env.TELEGRAM_BOT_TOKEN) : undefined;
const server = createServer(
  createRouter({
    store,
    chat,
    publicUrl,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    metaVerifyToken: env.META_VERIFY_TOKEN,
    metaAppSecret: env.META_APP_SECRET,
    metaPhoneNumberId: env.META_PHONE_NUMBER_ID,
    telegramSecret,
    answerTelegramCallback: telegram ? (id) => telegram.answerCallback(id) : undefined,
    // Only the active channel's webhook is live, so a parked channel can never board passengers.
    webhooks: channel === "console" ? undefined : [channel],
    privacyContact: env.PRIVACY_CONTACT || undefined,
    log,
  }),
);
server.listen(Number(env.PORT ?? 8080), () => {
  log(`listening on ${publicUrl} (channel: ${channel})`);
  // Telegram: (re)register the webhook on every boot, so a deploy is all it takes.
  if (telegram && telegramSecret) {
    telegram
      .setWebhook(`${publicUrl}/webhooks/telegram`, telegramSecret)
      .then(() => log(`telegram webhook → ${publicUrl}/webhooks/telegram`))
      .catch((err) => log(`telegram setWebhook ERROR ${err instanceof Error ? err.message : err}`));
  }
});

// Scheduler: every minute, idempotent.
const useTemplates = (env.WHATSAPP_TEMPLATES ?? "off") === "on";
let ticking = false;
async function runTick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const report = await tick(
      {
        store,
        outbox,
        useTemplates,
        log,
        writeMorning: async (person, date, at) => writeMorningMessage(client, store, await buildMorningBrief(store, person, date, at)),
      },
      now,
    );
    if (report.mornings.length || report.reminders.length || report.sponsorNudges.length || report.errors.length) {
      log(`tick: mornings=${report.mornings.length} reminders=${report.reminders.length} nudges=${report.sponsorNudges.length} errors=${report.errors.length}`);
      for (const e of report.errors) log(`tick error: ${e}`);
    }
  } finally {
    ticking = false;
  }
}
if (env.SCHEDULER !== "off") {
  setInterval(runTick, 60_000);
  void runTick();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
  });
}
