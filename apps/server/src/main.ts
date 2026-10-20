/**
 * Capitán Lunático's ship: one process that hosts the chat webhooks (Telegram, WhatsApp), the calendar feeds,
 * and the minute-by-minute scheduler (morning program, reminders, sponsor nudges).
 *
 * Env (see .env.example): DATABASE_URL (Postgres) or CRUCERO_DATA_FILE (dev JSON store),
 * TELEGRAM_BOT_TOKEN (wins when set), META_* or TWILIO_* (WhatsApp), PUBLIC_URL, PORT, WHATSAPP_TEMPLATES=on|off.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { ChatService, Director, buildMorningBrief, tick, writeMorningMessage, type TemplateOutbox } from "@crucero/agent";
import { MemoryStore, PgStore, fromPostgresJs, seedSample, type Store } from "@crucero/db";
import { createRouter } from "./http.js";
import { FalImageGenerator, FlyerService } from "./flyer.js";
import { DiskMediaStore, type MediaStore, SupabaseMediaStore } from "./media.js";
import { MetaWhatsAppOutbox } from "./meta.js";
import { cabinUrl, tvKey } from "./web.js";
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

const publicUrl = env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8080}`;
const client = new Anthropic();

// Media (flyers): Supabase Storage when configured, else the data volume served at /media.
let media: MediaStore;
let diskMedia: DiskMediaStore | undefined;
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  media = new SupabaseMediaStore({ url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SUPABASE_BUCKET || undefined });
  log("media: supabase storage");
} else {
  diskMedia = new DiskMediaStore(env.MEDIA_DIR || join(dirname(env.CRUCERO_DATA_FILE || ".data/crucero.json"), "media"), publicUrl);
  media = diskMedia;
  log("media: local volume (/media)");
}

// Web links and TV mode share one server-side secret. WEB_SECRET wins; otherwise one is derived from a
// secret the server already has, so links stay stable across deploys without another setting.
const webSecret =
  env.WEB_SECRET || createHash("sha256").update(`crucero-web:${env.TELEGRAM_BOT_TOKEN ?? env.META_APP_SECRET ?? env.ANTHROPIC_API_KEY ?? "dev"}`).digest("hex");
let botUsername: string | undefined;
const signupUrl = (a: { id: string }) => (botUsername ? `https://t.me/${botUsername}?start=signup_${a.id}` : `${publicUrl}/`);

const flyers = new FlyerService({
  store,
  media,
  client,
  images: env.FAL_KEY ? new FalImageGenerator(env.FAL_KEY, env.FAL_MODEL || undefined) : undefined,
  signupUrl,
  log,
});
log(`flyers: ${env.FAL_KEY ? `flux via fal.ai (${env.FAL_MODEL || "fal-ai/flux/dev"})` : "designed templates (set FAL_KEY for AI art)"}`);

// Brain
const cabinLink = (p: Parameters<typeof cabinUrl>[1]) => cabinUrl({ publicUrl, secret: webSecret }, p);
const director = new Director(store, { client, outbox, flyers, cabinLink });
const chat = new ChatService(store, director, outbox);

// HTTP
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
    web: { store, outbox, publicUrl, secret: webSecret, flyers, botUsername: () => botUsername },
    tv: { store, key: tvKey(webSecret), botUsername: () => botUsername },
    botUsername: () => botUsername,
    diskMedia,
    log,
  }),
);
server.listen(Number(env.PORT ?? 8080), () => {
  log(`listening on ${publicUrl} (channel: ${channel})`);
  log(`TV mode: ${publicUrl}/tv/${tvKey(webSecret)}`);
  // Telegram: (re)register the webhook on every boot, so a deploy is all it takes.
  if (telegram && telegramSecret) {
    telegram
      .setWebhook(`${publicUrl}/webhooks/telegram`, telegramSecret)
      .then(() => log(`telegram webhook → ${publicUrl}/webhooks/telegram`))
      .catch((err) => log(`telegram setWebhook ERROR ${err instanceof Error ? err.message : err}`));
    telegram
      .username()
      .then((u) => {
        botUsername = u;
        log(`telegram bot: @${u} (QR codes and deep links use https://t.me/${u})`);
      })
      .catch((err) => log(`telegram getMe ERROR ${err instanceof Error ? err.message : err}`));
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
