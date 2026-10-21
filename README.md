# Crucero Luna 2026 🚢

**Capitán Lunáticus** is the Cruise Director agent for La Familia Luna's "cruise" in Acapulco,
Dec 26 2026 – Jan 2 2027 (which is, technically, an apartment; the Capitán disagrees).
Family members sponsor activities, sign up for each other's, and get a hyped-up morning program
and reminders from a charismatic, slightly unhinged ship's officer.

The full build plan is in [`PLAN.md`](PLAN.md); the persona is in [`docs/persona.md`](docs/persona.md).

## What exists today

| Path | What it is |
|---|---|
| `packages/db` | Domain types, the `Store` contract, an in-memory/JSON `MemoryStore` for dev, ship-clock helpers (fixed UTC-6), a sample roster + program, and the Postgres schema (`sql/001_init.sql`) for Supabase |
| `packages/agent` | The Capitán: cached persona prefix, per-turn `<ship_context>`, 15 tools (program, sign-ups, sponsoring, messages, memory, preferences, flyers, web link, weather) with permissions and quiet hours enforced in code, the `Director` class on the Anthropic Tool Runner, and the morning-program generator with structured output |
| `apps/cli` | `pnpm chat`: talk to the Capitán as any passenger at any ship time. `pnpm morning`: generate everyone's morning program for a date |
| `apps/server` | The ship's one process: the chat webhook (**Telegram** now; Meta Cloud API and Twilio parked), the **web app** (`/c/<cabin token>`), **TV mode** (`/tv/<key>`), the **flyer** renderer (Claude brief + Flux art + overlaid text), media at `/media` or Supabase Storage, calendar feeds (`/cal/<token>.ics`), and the minute scheduler (morning program, T-30 reminders with guardian routing, T-60 sponsor nudges) |
| `evals` | 40 realistic WhatsApp-style messages (Spanish, English, Spanglish, typos, kids, edge cases) with expected tool behavior, plus an optional tone judge |

Also in `packages/db`: `PgStore`, the production store on Postgres, tested against a real in-process Postgres (PGlite).
In `packages/agent`: `ChatService` (boards new numbers from their WhatsApp profile name, keeps per-passenger history,
handles the morning template buttons without the model) and `tick`, the idempotent scheduler pass.

Not built yet (see PLAN.md phases): voice notes, realtime voice + avatar, admin page, awards.

### The web app, TV mode and flyers

- **Web app.** Every passenger has a private page at `/c/<id>.<signature>`; the Capitán hands it out
  (`my_cabin_link`, also mentioned during onboarding). It shows "Mi crucero" (upcoming plan, settings, calendar
  link), the program by day, activity pages with Voy / Tal vez / No voy, a sponsor form with an optional
  flyer, and host-only cancel. Every write runs the Capitán's own tools, so the rules match the chat. Rotating
  a passenger's ICS token revokes their link. Signatures use `WEB_SECRET` (or a secret derived from the
  bot token when unset).
- **TV mode.** Open the URL printed at boot (`fly logs` → `TV mode: https://…/tv/<key>`) on the apartment
  TV in full screen. It refreshes itself: clock, now / next with a countdown and a sign-up QR, today's
  program (before the cruise: the next day with activities and a countdown to sailing), rotating flyers,
  and a QR to open the Capitán's chat.
- **Flyers.** "Hazme un flyer" in the chat or the web form: Claude writes the headline, tagline and art
  direction; Flux via fal.ai paints the background (`FAL_KEY`, optional `FAL_MODEL`, default
  `fal-ai/flux/dev`); the server overlays title, date, place, host and a QR that opens the chat and signs
  the scanner up (`t.me/<bot>?start=signup_<id>`). Without `FAL_KEY`, or if the image call fails, a designed
  gradient per vibe is used. PNGs go to Supabase Storage (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
  public bucket `media`, created automatically) or, before that exists, to the data volume at `/media`.

### Production database (Supabase)

1. Create a project at supabase.com (region near Dallas, e.g. us-east-1 or us-west-1).
2. **Database URL:** the green **Connect** button in the top bar of the project page (not under API Keys) →
   Connection String → Method: **Session pooler** (IPv4; the direct host is IPv6-only and GitHub's runners can't
   reach it). Forgot the database password? Database → Settings → Reset database password. Copy the `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   string, with your database password filled in, into the `DATABASE_URL` repository secret.
3. **Storage:** the project URL (`https://<ref>.supabase.co`, shown under Connect and Project Settings → Data API)
   goes into `SUPABASE_URL`; Project Settings → API Keys → a **secret key** (`sb_secret_…`, or the legacy
   `service_role` key) goes into `SUPABASE_SERVICE_ROLE_KEY` (server-only; never the publishable key, never in a browser).
4. Run **Deploy to Fly**: it applies `packages/db/sql/*.sql` with `pnpm db:migrate`, then the server logs
   `store: postgres` and `media: supabase storage`. The JSON pilot data is not copied over; the ship starts
   with an empty roster and everyone boards by messaging the bot.

## Quick start

```bash
pnpm install
cp .env.example .env            # add ANTHROPIC_API_KEY
pnpm test                       # 59 unit tests incl. a real Postgres (PGlite), no API calls
pnpm typecheck

pnpm chat --as sofia --at 2026-12-28T13:00     # 7:00 am ship time on Día de los Inocentes
pnpm chat --as diego --trace                   # English-speaking passenger, show tool calls
pnpm morning --date 2026-12-29 --dry           # briefs only, no model
pnpm morning --date 2026-12-31                 # the Capitán writes everyone's Gala Night morning
pnpm eval                                      # behavioral eval; add --judge for a tone pass
pnpm server                                    # webhook + calendar feeds + scheduler (console outbox until TWILIO_* is set)
```

### Running the ship on Telegram (current channel)

WhatsApp is parked (see Troubleshooting below); Telegram needs no phone number, business verification or templates.

1. In Telegram, message **@BotFather** → `/newbot`, pick a name ("Capitán Lunáticus") and a username ending in `bot`.
   Copy the token. Optional: `/setuserpic`, `/setdescription`, and `/setjoingroups` → Disable (the bot only talks in
   private chats anyway).
2. Add the token as the `TELEGRAM_BOT_TOKEN` repository secret and run **Deploy to Fly**. On boot the server calls
   `setWebhook` for `PUBLIC_URL/webhooks/telegram` with a secret derived from the token; `fly logs` shows
   `telegram webhook → …`. Locally: put the token in `.env`, expose port 8080 with a tunnel and set `PUBLIC_URL`.
3. Share `https://t.me/<bot username>`. A passenger taps **Start**, is boarded from their Telegram name, and the
   Capitán asks what to call them. Passengers are stored as `tg:<chat id>`; buttons are inline keyboards.

With `TELEGRAM_BOT_TOKEN` set, Telegram wins over `META_*`/`TWILIO_*` and only `/webhooks/telegram` is live.

### Running the ship on Meta's Cloud API (parked)

Meta's free **test number** lets up to five verified phones talk to the Capitán before any real number exists.

1. At developers.facebook.com create an app (type Business), add the **WhatsApp** product, and pick or create
   the Business portfolio ("Crucero Luna"). The **API Setup** page shows a test number, its **Phone Number ID**,
   and a temporary 24-hour **access token**. Add your pilot testers under "To" as recipients (each confirms a code).
2. Put `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_APP_SECRET` (App settings → Basic) and a
   `META_VERIFY_TOKEN` of your choosing in `.env`. Keep `WHATSAPP_TEMPLATES=off` until you have approved templates.
3. `pnpm server`, expose port 8080 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`) and set
   `PUBLIC_URL` to it. In the app's WhatsApp → **Configuration** page set the callback URL to
   `<PUBLIC_URL>/webhooks/meta` with your verify token, then subscribe to the **messages** field.
4. Testers send "Hola Capitán". Unknown numbers are boarded from their WhatsApp profile name.

For production: create a **System User** in Business settings with the WhatsApp permissions, generate a permanent
token and replace `META_ACCESS_TOKEN`; add the real number under Phone numbers (it must never have been on
WhatsApp; the SMS/voice code arrives on it); submit the three templates (`morning_knock` with three quick-reply
buttons, `activity_reminder`, `new_activity`) under Message templates and put their names in `META_TEMPLATE_*`,
then set `WHATSAPP_TEMPLATES=on`.

Troubleshooting (all seen on the first setup; every webhook call is logged, so start with `fly logs`):
- *Meta's webhook **Test** works but real messages never show up*: the WhatsApp Business Account is not subscribed
  to the app. `curl -X POST "https://graph.facebook.com/v22.0/<WABA_ID>/subscribed_apps" -H "Authorization: Bearer <token>"`.
- *`meta delivery FAILED … 131042 Business eligibility payment issue`*: the WABA that owns the sending number (the
  test number has its own WABA; its ID is on API Setup) has no payment method. Add or share a card with that WABA.
- *`131030 Recipient phone number not in allowed list`*: add the tester under API Setup → "To". The Test button's
  fake sender (+16315551181) always fails this way.
- *Replies stop after a day*: the temporary token expired; use a System User token.

Inbound voice notes are acknowledged but not transcribed yet (Phase 2).

### Running the ship against the Twilio sandbox (alternative)

1. Fill `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN` and
   `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` in `.env`; keep `WHATSAPP_TEMPLATES=off` (the sandbox
   has no approved templates, so the morning goes out as a plain message).
2. `pnpm server`, then expose port 8080 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`)
   and set `PUBLIC_URL` to the tunnel URL. Signature validation uses that URL, so they must match.
3. In the Twilio console sandbox settings, set "When a message comes in" to `<PUBLIC_URL>/webhooks/twilio`.
4. Each tester sends the sandbox join code once, then "Hola Capitán". Unknown numbers are boarded
   automatically using their WhatsApp profile name; the Capitán confirms name and language.

With `DATABASE_URL` set the server uses Postgres (run `pnpm db:migrate` once); otherwise it uses the JSON dev store.

### Admin access

Set an `ADMIN_PASSWORD` repository secret (copied to Fly by **Deploy to Fly**). A passenger who sends exactly
that password in the chat (case-insensitive, or `/admin <password>`) becomes an admin. The server catches it
before the model, so it is never in the chat history; delete the message afterwards anyway. Admins can ask the
Capitán for the full manifest, to remove a passenger (e.g. a test number), to mark kids and their guardians,
to grant admin, or to pause the ship. Their web page gets an **Admin** tab with the same controls plus the TV
mode link. Paused = no morning programs, reminders or nudges, and non-admins get a short off-duty reply.
Migration `004_admin.sql` adds the flag and the `ship_setting` table.

### Call the Bridge (live video calls with the Capitán)

A photoreal Capitán on a video call, on any phone (web page → **Puente**) and on the TV.
**Anam** renders the avatar, an **ElevenLabs agent** listens and speaks, and our server is the brain:
ElevenLabs calls `POST /v1/chat/completions` (OpenAI-compatible SSE, Bearer secret derived from `WEB_SECRET`)
and the same Capitán answers with the same tools, memory and chat history (`ChatService.converse`, channel `voice`;
the context adds spoken-reply rules). Each call carries a signed passenger session in `elevenlabs_extra_body`.
On the TV: a 🎙 button uses a mic at the TV (as the shared seat "Puente (TV)", which asks who is speaking), and
**Hablar en la tele** on a phone relays that phone's mic over a WebSocket (`/voice/relay/<call>`) to the TV, which
feeds it to the avatar (hold to talk). Calls hang up after 10 minutes; the pause switch blocks new calls.

Setup: add `ELEVENLABS_API_KEY` and `ANAM_API_KEY` (repository secrets → Deploy to Fly), then in the **Admin** tab →
Capitán en vivo: **Pintar un retrato** (Flux, needs `FAL_KEY`) → **Usar este** (creates his Anam avatar) →
**Configurar agente de voz** (creates the ElevenLabs agent pointing at this server) → paste a Spanish voice id from
the ElevenLabs voice library → **Probar llamada**. `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID`, `ANAM_AVATAR_ID`
override what the Admin tab stores. On the TV, tap once to wake the Bridge (browsers need a tap before sound).
If calls drop, Admin → Capitán en vivo → **Diagnosticar** shows the live agent config (custom LLM URL, overrides,
voice), how the last ElevenLabs conversations ended, and recent call events (close reasons reported by the call
pages, custom LLM hits); the same events are in `fly logs` as `voice …` lines. The caller is identified by a
signed session sent as the ElevenLabs `user_id` (with a `{{cl_session}}` prompt variable as backup), which needs
no override permission on the agent.
Conversation feel: the caller can talk over the Capitán (ElevenLabs stops him and cancels our turn), slow answers
start with a short buffer phrase, and after 8 s of silence he asks "¿Sigues ahí?" (gentler the second time; the call
ends politely after 45 s). These turn settings are applied by **Configurar agente de voz**, so click it again after
deploying.

### Secrets

Never commit `.env` (it is gitignored). Locally, keys live in `.env`. In GitHub, add them as **repository
secrets** (Settings → Secrets and variables → Actions); the `CI` workflow's manual "live-eval" job runs
`pnpm eval` with `ANTHROPIC_API_KEY` from there and uploads `evals/results/` as an artifact, so the pass
rate can be checked without anyone copying keys around. On Fly, secrets go in with `fly secrets set`.

### Deploying

**One button:** add a `FLY_API_TOKEN` repository secret (Fly dashboard → Tokens, or `fly tokens create org`),
plus the channel secret (`TELEGRAM_BOT_TOKEN`), then Actions → **Deploy to Fly** → Run workflow. It tests,
creates the app and a 1 GB `ship_data` volume on first run, copies whichever of `ANTHROPIC_API_KEY`,
`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FAL_KEY`, `WEB_SECRET`, `ADMIN_PASSWORD`, `ELEVENLABS_API_KEY`, `ANAM_API_KEY`,
`PRIVACY_CONTACT` and `META_*` are set in GitHub to Fly, runs migrations if there is a database, deploys,
and smoke-tests `/health`. Without `DATABASE_URL` the JSON store lives on the
volume (`/data/crucero.json`) and starts empty (`SEED_SAMPLE=off`): testers board by messaging the ship.

By hand: `Dockerfile` + `fly.toml` run the server as one always-on machine: `fly launch --no-deploy --copy-config`,
`fly volumes create ship_data --size 1`,
`fly secrets set ANTHROPIC_API_KEY=… DATABASE_URL=… META_ACCESS_TOKEN=… META_PHONE_NUMBER_ID=… META_APP_SECRET=… META_VERIFY_TOKEN=…`,
then `fly deploy`. Point the Meta webhook at `https://<app>.fly.dev/webhooks/meta` (or Twilio's at `/webhooks/twilio`).

`--at` is a UTC instant; the ship runs on America/Mexico_City, which is UTC-6 with no DST.
Set `CRUCERO_DATA_FILE=.data/crucero.json` in `.env` to persist sign-ups between runs
(the sample roster is seeded on first use).

In the chat: `/who <name>` switches passenger, `/tools` toggles the tool trace, `/program` prints
what the Capitán currently sees about you and today, `/reset` clears the conversation.

## How the agent is wired

- **Model:** `claude-opus-5-5` for the Capitán (adaptive thinking, `effort: low` on chat turns,
  `medium` for the morning show), `claude-haiku-5-5` for the eval judge and future mechanical steps.
- **Prompt caching:** the persona is the first system block with `cache_control`; the volatile
  passenger context (name, ship time, today's program, memory) comes after it.
- **Refusal safety net:** `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta,
  and a friendly deterministic reply if the whole chain declines.
- **Tools** are Zod-typed (`betaZodTool`), bound to a `Store` and an `Outbox` (console today,
  WhatsApp later). Every tool returns a string; errors come back as `ERROR: …` so the Capitán
  can explain rather than crash. Each call is reported to `onToolCall` for the trace and the evals.
- **Morning program** is two steps: a deterministic brief (your activities, light-day
  suggestions, special-day headline) and a structured-output call that returns the WhatsApp
  template "knock" line, the full message, and the activity ids for one-tap buttons.
- **Templates and the 24-hour window.** With `WHATSAPP_TEMPLATES=on`, the scheduler sends the short
  `morning_knock` template and parks the full message in the `delivery` table; the first button tap or
  message from that passenger releases it (no model call for taps). `hoy_no` suppresses it for the day.
  Reminders and nudges go as free-form text, which is fine inside an open window. On Meta, the full
  morning message is followed by up to three one-tap sign-up buttons; a tap becomes a request to the
  Capitán so the confirmation keeps his voice.
- **Scheduler** runs every minute and is idempotent: one morning per person per ship day (from wake
  time until three hours later, 10:00 at the earliest on Jan 1), one reminder per sign-up, one nudge
  per activity, quiet hours respected, kids' reminders mirrored to their guardian.

## Layout

```
PLAN.md · docs/persona.md
packages/db/src       types · store · memory-store · time · seed (+ tests)
packages/db/sql       001_init.sql
packages/agent/src    persona · context · tools · director · morning (+ tests)
packages/agent/src    inbound (ChatService) · scheduler (tick) · ics (+ tests)
apps/cli/src          chat.ts · morning.ts · shared.ts
apps/server/src       main.ts · http.ts · meta.ts · twilio.ts (+ tests)
evals                 cases.json · run.ts
```
