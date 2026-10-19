# Crucero Luna 2026 — project context for Claude sessions

Read `PLAN.md` (the plan and decisions) and `README.md` (how to run things) before changing code.
This file is the hand-off: where the project stands and what comes next.

## What this is
Capitán Lunático, a WhatsApp cruise-director agent for La Familia Luna's apartment "cruise" in
Acapulco, **Dec 26 2026 – Jan 2 2027**, ~20 passengers. Spanish first, English mirrored.
Family members sponsor activities, sign up for each other's, and get a hyped morning program,
reminders and sponsor nudges. The persona lives in `packages/agent/src/persona.ts` (+ `docs/persona.md`).

## Decisions already made (do not re-litigate without the owner)
- **Channel:** Meta WhatsApp Cloud API direct (`apps/server/src/meta.ts`). Twilio adapter kept as alternative.
  Telegram is plan B if Meta blocks us by the Oct 31 gate.
- **Brain:** `claude-opus-5-5` via the Anthropic SDK beta Tool Runner, `effort: low` for chat, `medium` for the
  morning show; `claude-haiku-5-5` for the eval judge. Server-side `fallbacks: "default"`. Persona is a cached prefix.
- **Store:** `Store` interface; `MemoryStore` (JSON file) for dev, `PgStore` (Supabase Postgres) for prod.
  Ship clock = America/Mexico_City, fixed UTC-6 (`packages/db/src/time.ts`).
- **Morning flow:** template "knock" with 3 quick-reply buttons → full message released on tap (parked in `delivery`).
  With `WHATSAPP_TEMPLATES=off` (test number, no approved templates) the full message goes out directly.
- **Humor rules** are in the persona; never joke about body/age/health/relationships/money/parenting.

## Commands
`pnpm install` · `pnpm typecheck` · `pnpm test` (72 tests, PGlite included, no API) · `pnpm chat --as sofia --at 2026-12-28T13:00 --trace`
· `pnpm morning --date 2026-12-31 [--dry]` · `pnpm eval [--judge]` (needs `ANTHROPIC_API_KEY`) · `pnpm server` · `pnpm db:migrate`.
CI (`.github/workflows/ci.yml`) runs typecheck + tests on push; the manual `live-eval` job runs `pnpm eval` with the
`ANTHROPIC_API_KEY` repository secret.

## Status (2026-10-19)
Done: plan, persona, db (+ Postgres schema), agent + 14 tools, CLI harness, morning generator, 40-case eval,
ChatService (onboarding, history), scheduler (`tick`), ICS feeds, Meta + Twilio adapters, HTTP server,
Dockerfile + fly.toml, CI.
Live eval (CI `live-eval`, judge on): run 1 15/40 (judge schema crashes), run 2 32/40 after harness fixes and
the "create clear sponsorships directly" persona rule. Run 3 adds a `muted` opt-out preference (migration
`002_muted.sql`; scheduler, broadcasts and `send_message` skip muted passengers) and gives the judge tool outputs.
Run 4 (27/40) exposed a closing-gag regression, fixed in the persona but not yet re-evaluated.
**Live on WhatsApp (2026-10-19):** deployed to Fly (`crucero-luna-2026`, region `dfw`, JSON store on the
`ship_data` volume, `SEED_SAMPLE=off`) via the one-button **Deploy to Fly** workflow, on Meta's test number;
the owner exchanged the first real messages. Known leftover: Meta's webhook **Test** button boarded a fake
passenger (+16315551181); there is no way to remove a passenger yet.

## Next steps, in order
1. **Pilot with up to 5 testers** on the test number: read `fly logs`, fix what real conversations expose; re-run the
   live eval after persona changes. Admin basics: remove a passenger, mark kids/guardians.
2. **Supabase** (`DATABASE_URL` secret; the deploy workflow migrates) before the real cruise; then the real number +
   approved templates (`WHATSAPP_TEMPLATES=on`).
3. **Flyer renderer**: Claude writes concept + copy, an image model paints the art, we overlay title/time/host with
   `satori`/`sharp` (3 templates: Fiesta, Zen, Retro Cruise). Store in Supabase storage; `generate_flyer` tool currently
   only queues (`flyerUrl = pending:…`).
4. **Web app + TV mode** (Next.js): program view, sponsor form, "my cruise", magic-link login, kiosk route for the
   apartment TV (now/next, QR sign-up, Supabase realtime).
5. Phase 2/3 per PLAN.md: voice notes (STT/TTS), realtime voice + avatar ("Call the Bridge"), onboarding polish,
   admin page, awards ceremony.

## Open decisions for the owner
- Avatar appetite for Phase 3 ("wow factor" vs "nice if it works").
- Whether the human family WhatsApp group stays human-only (recommended) or the daily flyer gets forwarded there.
- Meta Graph API version to pin (`META_GRAPH_VERSION`, default v22.0; check the API Setup page's sample curl).

## Conventions
TypeScript ESM everywhere, pnpm workspaces, vitest. Tools return strings (errors as `ERROR: …`), never throw.
Every tool call is reported via `onToolCall` for traces and evals. Keep the persona prefix free of per-request data.
Commit messages: imperative, no model identifiers. Never commit `.env`.
