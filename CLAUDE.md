# Crucero Luna 2026 — project context for Claude sessions

Read `PLAN.md` (the plan and decisions) and `README.md` (how to run things) before changing code.
This file is the hand-off: where the project stands and what comes next.

## What this is
Capitán Lunáticus, a WhatsApp cruise-director agent for La Familia Luna's apartment "cruise" in
Acapulco, **Dec 26 2026 – Jan 2 2027**, ~20 passengers. Spanish first, English mirrored.
Family members sponsor activities, sign up for each other's, and get a hyped morning program,
reminders and sponsor nudges. The persona lives in `packages/agent/src/persona.ts` (+ `docs/persona.md`).

## Decisions already made (do not re-litigate without the owner)
- **Channel:** **Telegram for now** (`apps/server/src/telegram.ts`, owner's call on 2026-10-19 after the WhatsApp number
  turned out to sit in a Twilio-created SIVICO WABA whose inbound never reached our app). Meta Cloud API direct
  (`meta.ts`) and Twilio (`twilio.ts`) stay in the code; `TELEGRAM_BOT_TOKEN` set → Telegram wins and only its webhook is live.
  Revisit WhatsApp later with a clean number registered directly in our Meta app.
- **Brain:** `claude-opus-5-5` via the Anthropic SDK beta Tool Runner, `effort: low` for chat, `medium` for the
  morning show; `claude-haiku-5-5` for the eval judge. Server-side `fallbacks: "default"`. Persona is a cached prefix.
- **Store:** `Store` interface; `MemoryStore` (JSON file) for dev, `PgStore` (Supabase Postgres) for prod.
  Ship clock = America/Mexico_City, fixed UTC-6 (`packages/db/src/time.ts`).
- **Morning flow:** template "knock" with 3 quick-reply buttons → full message released on tap (parked in `delivery`).
  With `WHATSAPP_TEMPLATES=off` (test number, no approved templates) the full message goes out directly.
- **Humor rules** are in the persona; never joke about body/age/health/relationships/money/parenting.

## Commands
`pnpm install` · `pnpm typecheck` · `pnpm test` (136 tests, PGlite included, no API) · `pnpm chat --as sofia --at 2026-12-28T13:00 --trace`
· `pnpm morning --date 2026-12-31 [--dry]` · `pnpm eval [--judge]` (needs `ANTHROPIC_API_KEY`) · `pnpm server` · `pnpm db:migrate`.
CI (`.github/workflows/ci.yml`) runs typecheck + tests on push; the manual `live-eval` job runs `pnpm eval` with the
`ANTHROPIC_API_KEY` repository secret.

## Status (2026-10-19)
Done: plan, persona, db (+ Postgres schema), agent + 14 tools, CLI harness, morning generator, eval (40 cases, 51 since the creative pass),
ChatService (onboarding, history), scheduler (`tick`), ICS feeds, Meta + Twilio adapters, HTTP server,
Dockerfile + fly.toml, CI.
Live eval (CI `live-eval`, judge on): run 1 15/40 (judge schema crashes), run 2 32/40 after harness fixes and
the "create clear sponsorships directly" persona rule. Run 3 adds a `muted` opt-out preference (migration
`002_muted.sql`; scheduler, broadcasts and `send_message` skip muted passengers) and gives the judge tool outputs.
Run 4 (27/40) exposed a closing-gag regression. Run 5 on main (context in the user turn, tool permissions): 34/40,
all deterministic checks passing. Run 6 (persona: last line always useful; judge calibrated to the persona): **37/40**,
zero deterministic failures; the 3 left are "two gags in one reply" tone calls.
**Live on WhatsApp (2026-10-19):** deployed to Fly (`crucero-luna-2026`, region `dfw`, JSON store on the
`ship_data` volume, `SEED_SAMPLE=off`) via the one-button **Deploy to Fly** workflow, on Meta's test number;
the owner exchanged the first real messages. Known leftover: Meta's webhook **Test** button boarded a fake
passenger (+16315551181); there is no way to remove a passenger yet.
Then the real number (…0909, SIVICO WABA `2232002254037592`, named "SIVICO - Twilio, Inc") never delivered inbound
webhooks despite a published app, a subscribed WABA and correct routing (CI `meta-doctor` job shows all of this), so
the owner switched to **Telegram**: bot adapter, `tg:<chat id>` addresses, inline buttons, migration `003_telegram_channel.sql`.
**Full-experience pilot build (2026-10-20, owner's choices):** web app + TV mode on the same Fly server (`web.ts`,
`tv.ts`), private links handed out by the Capitán (`my_cabin_link`, HMAC of id + ICS token), flyers with Flux via
fal.ai under our overlaid text (`flyer.ts`, satori + resvg, gradient fallback), Supabase Postgres + Storage
(`media.ts`, disk fallback at `/media`). QR codes use `t.me/<bot>?start=signup_<id>` deep links.

**Admin + app redesign (2026-10-20):** `ADMIN_PASSWORD` said in the chat → `person.admin` (caught in ChatService, never
reaches the model); 5 admin tools (manifest, remove passenger, kid/guardian, grant admin, pause switch via
`ship_setting`); web Admin tab; web app restyled as a cruise app (hero, bottom tabs, day chips, timeline, sign-up bar).

**Call the Bridge (2026-10-20, owner's choices: photoreal avatar, ElevenLabs Agents, phone + TV mic):** `voice.ts`
(custom LLM endpoint `/v1/chat/completions`, Anam sessions with `elevenLabsAgentSettings`, agent + avatar setup,
phone→TV mic relay over `ws`), `bridge.ts` (phone call page, TV overlay; Anam JS SDK 4.27.1 from jsdelivr). Not yet
tried against the real vendors: needs `ELEVENLABS_API_KEY` + `ANAM_API_KEY` on Fly and the Admin-tab setup.
Live eval on this build (persona: check the host before cancelling, reply in the passenger's language): **39/40**,
the one left a two-gag tone call.

**Creative pass (2026-10-20, owner's choices):** the ship is the **Moonshine of the Seas** (anteriormente *Fondo de Cristal
Victoria*), the captain is **Capitán Lunáticus** (Greek), and the mascot **la Primera Oficial Manpaty** (she/her; cheeky secretary) is the old yellow
ceramic celosía entrance screen with a brass frame, drawn as SVG in `apps/server/src/manpaty.ts`. Names live in
`packages/agent/src/brand.ts`. New passengers get a Manpaty welcome photo (`welcomePhotoUrl`).
The eval now has 51 cases: the original 40 plus admin (remove asks first, pause, kid/guardian, no admin talk
with non-admins), voice calls (spoken, short, no emoji/links), the shared TV seat (asks who is speaking), the
ship/captain names, Manpaty (she/her) and new-passenger onboarding. Harness: `as: "tv"|"new"`, `channel: "voice"`,
`setup.admin`, `setup.add_passengers`, `reply_speakable`, `reply_max_chars`, `before` (earlier turns, history carried).
Voice parity (2026-10-21): 56 cases; multi-turn voice cases (follow-up "apúntame a ese", sign-up + message in one
request) and voice sponsor/message/remember. Voice turns share the Telegram history; a turn the caller talks over is
dropped from history unless it already acted; live eval 49/56 (voice 8/9, the miss a four-sentence reply, now
counted in the voice rules; next run 47/56: flyer-request could not find a later activity → the context now has a
"Rest of the voyage" index of ids, dates and titles; the eval's forbidden-phrase check matches whole words); slow turns speak a buffer phrase ("Déjame revisar... ").
Natural turns: the agent's `conversation_config.turn` (check-in after 8 s of silence, hang up after 45 s, eagerness
normal). ElevenLabs re-engages by calling our LLM with no new user words; `completions()` answers those with
`stillThere()` ("¿Sigues ahí, Sofía?" → "Aquí sigo…" → goodbye) without Claude or history. Needs "Volver a configurar".

## Next steps, in order
1. **Owner:** Supabase project → `DATABASE_URL` (session pooler) + `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`;
   fal.ai → `FAL_KEY`; deploy; check `fly logs` (`store: postgres`, `media: supabase storage`, `flyers: flux…`,
   `TV mode: …`). Then a first real flyer, the TV on a screen, and the web link from the bot.
2. **Pilot** with 3–5 family members on the full experience; read `fly logs`; re-run the live eval after persona
   changes. Set `ADMIN_PASSWORD`, then remove the Meta test passenger (+16315551181) from the Admin tab.
3. Phase 2/3 per PLAN.md: voice notes (STT/TTS), realtime voice + avatar ("Call the Bridge"), onboarding polish,
   admin page, awards ceremony.

## Open decisions for the owner
- Avatar appetite for Phase 3 ("wow factor" vs "nice if it works").
- Whether the human family WhatsApp group stays human-only (recommended) or the daily flyer gets forwarded there.
- Meta Graph API version to pin (`META_GRAPH_VERSION`, default v22.0; check the API Setup page's sample curl).

## Conventions
TypeScript ESM everywhere, pnpm workspaces, vitest. Tools return strings (errors as `ERROR: …`), never throw.
Every tool call is reported via `onToolCall` for traces and evals. Keep the persona prefix free of per-request data.
Commit messages: imperative, no model identifiers. Never commit `.env`.
