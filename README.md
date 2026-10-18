# Crucero Luna 2026 🚢

**Capitán Lunático** is the Cruise Director agent for La Familia Luna's "cruise" in Acapulco,
Dec 26 2026 – Jan 2 2027 (which is, technically, an apartment; the Capitán disagrees).
Family members sponsor activities, sign up for each other's, and get a hyped-up morning program
and reminders from a charismatic, slightly unhinged ship's officer.

The full build plan is in [`PLAN.md`](PLAN.md); the persona is in [`docs/persona.md`](docs/persona.md).

## What exists today

| Path | What it is |
|---|---|
| `packages/db` | Domain types, the `Store` contract, an in-memory/JSON `MemoryStore` for dev, ship-clock helpers (fixed UTC-6), a sample roster + program, and the Postgres schema (`sql/001_init.sql`) for Supabase |
| `packages/agent` | The Capitán: cached persona prefix, per-passenger context, 14 tools (program, sign-ups, sponsoring, reminders, memory, preferences, flyers, weather), the `Director` class on the Anthropic Tool Runner, and the morning-program generator with structured output |
| `apps/cli` | `pnpm chat`: talk to the Capitán as any passenger at any ship time. `pnpm morning`: generate everyone's morning program for a date |
| `apps/server` | The ship's one process: Twilio WhatsApp webhook (signature-validated, acks fast, replies via REST), per-passenger calendar feeds (`/cal/<token>.ics`), and the minute scheduler (morning program, T-30 reminders with guardian routing, T-60 sponsor nudges) |
| `evals` | 40 realistic WhatsApp-style messages (Spanish, English, Spanglish, typos, kids, edge cases) with expected tool behavior, plus an optional tone judge |

Also in `packages/db`: `PgStore`, the production store on Postgres, tested against a real in-process Postgres (PGlite).
In `packages/agent`: `ChatService` (boards new numbers from their WhatsApp profile name, keeps per-passenger history,
handles the morning template buttons without the model) and `tick`, the idempotent scheduler pass.

Not built yet (see PLAN.md phases): web app + TV mode, flyer image pipeline, voice/video, deployment config.

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

### Running the ship against the Twilio sandbox

1. Fill `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN` and
   `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` in `.env`; keep `WHATSAPP_TEMPLATES=off` (the sandbox
   has no approved templates, so the morning goes out as a plain message).
2. `pnpm server`, then expose port 8080 with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8080`)
   and set `PUBLIC_URL` to the tunnel URL. Signature validation uses that URL, so they must match.
3. In the Twilio console sandbox settings, set "When a message comes in" to `<PUBLIC_URL>/webhooks/twilio`.
4. Each tester sends the sandbox join code once, then "Hola Capitán". Unknown numbers are boarded
   automatically using their WhatsApp profile name; the Capitán confirms name and language.

With `DATABASE_URL` set the server uses Postgres (run `pnpm db:migrate` once); otherwise it uses the JSON dev store.

### Deploying

`Dockerfile` + `fly.toml` run the server as one always-on machine: `fly launch --no-deploy --copy-config`,
`fly secrets set ANTHROPIC_API_KEY=… DATABASE_URL=… TWILIO_ACCOUNT_SID=… TWILIO_API_KEY_SID=… TWILIO_API_KEY_SECRET=… TWILIO_AUTH_TOKEN=… TWILIO_WHATSAPP_FROM=…`,
then `fly deploy`. Point the Twilio webhook at `https://<app>.fly.dev/webhooks/twilio`.

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
  Reminders and nudges go as free-form text, which is fine inside an open window.
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
apps/server/src       main.ts · http.ts · twilio.ts (+ tests)
evals                 cases.json · run.ts
```
