# Crucero Luna 2026 — Cruise Director Agent: Build Plan

**Goal.** Turn a December apartment stay in Acapulco into a "cruise": a shared daily
program of family-sponsored activities, personal sign-ups and reminders, and a funny,
charismatic Cruise Director agent that hypes everyone up each morning and keeps the days full.

**Timeline anchors (today is 2026-10-17).**

| Milestone | Target |
|---|---|
| WhatsApp go / no-go gate (Meta setup working, or flip to Telegram) | Oct 31 |
| Share with La Familia Luna, start collecting sponsored activities | ~Nov 14–17 |
| Calendar "filling up" phase (sponsor + sign up) | Nov 17 – Dec 25 |
| Feature freeze (Christmas week is not debugging week) | Dec 19 |
| **The cruise: Acapulco, Dec 26 – Jan 2** (8 days, 7 nights) | Dec 26 – Jan 2 |

**Director:** *Capitán Lunático*, at the service of La Familia Luna (~20 passengers).
**Language:** Spanish first; the Capitán switches to English for anyone who writes in English.

---

## 1. Recommendation in one paragraph

Build **WhatsApp as the primary channel** (everyone already has it, zero install, works for
abuelos and kids alike), a **web app with a "TV channel" mode** for the shared daily program
on the apartment TV, and add the **voice + video "call the director"** experience as the
third layer once the first two work. Design it so WhatsApp alone is a complete product: if
the avatar is flaky on day 3 of the trip, nobody's vacation breaks. Calendar integration is a
per-person subscribable calendar feed, not OAuth into everyone's Google/Apple accounts.

Why not voice/video first: it is the most expensive, most latency-sensitive and most fragile
piece, and it is the one piece nobody *needs* to sign up for "Sunrise yoga with Sofia". It is,
however, the piece that makes this feel like a cruise-room TV, so it stays in scope as Phase 3.

---

## 2. Experience design

### 2.1 The three surfaces

| Surface | What it's for | Who uses it |
|---|---|---|
| **WhatsApp** (1:1 chat with the Director + one family group) | Morning hype message, reminders, "sign me up", "sponsor an activity", flyers as images, voice notes both ways | Everyone, every day |
| **Web app / PWA** (`crucero.luna` or similar) | Full calendar view, sponsor form with flyer generator, personal "my cruise" page, **TV mode** (kiosk screen for the apartment TV) | Organizers; the TV in the living room |
| **Video call with the Director** (in the web app, "Call the Bridge" button) | Live talking avatar: "what's happening today?", "put me down for bingo", bedtime jokes for the kids | Fun / wow factor, a few times a day |

### 2.2 Core loops

1. **Sponsor an activity** (pre-trip and during). Via WhatsApp ("I want to host sunrise yoga
   Tuesday at 7") or the web form. The Director interviews for missing details (time, place,
   capacity, what to bring), confirms, generates a flyer, and announces it to the group.
2. **Sign up.** From the morning message (tap a button), from the TV QR code, from the web app,
   or by telling the Director. Sign-ups drive reminders and the personal calendar feed.
3. **Morning program (07:30 local, configurable).** Personalized per person: today's
   headline, *their* activities, one joke, and if their day is empty, 2–3 suggestions with
   one-tap sign-up. The group gets one "Daily Program" message + flyer image.
4. **Reminders.** 30 min before each activity you signed up for (sponsors get a 60-min "your
   guests are counting on you" nudge). Quiet hours respected. Kids' reminders can route to a
   parent.
5. **Evening recap (optional).** Photos of the day, tomorrow's teaser, "sponsor slots still
   open tomorrow".

### 2.3 The personality

**Capitán Lunático**, Cruise Director of the Crucero Luna, serving La Familia Luna (the
name is the first running gag: he is lunatic about the Luna family). Bilingual Spanish/English, mirrors whoever is talking. Running gags:
the apartment is "the ship" (balcony = Lido Deck, kitchen = Galley, the elevator = "the
tender"), fake ship announcements ("*ding-dong* Attention passengers…"), ranks awarded for
participation ("Sofia has been promoted to Yoga Admiral"). Rules: never mean, never jokes
*about* a family member's body/age/relationship, jokes are shorter in reminders than in the
morning message, always useful first (time, place, who's hosting), then funny.

Draft system prompt: `docs/persona.md`.

### 2.4 Built-in set pieces for Dec 26 – Jan 2

| Day | Set piece the Capitán pushes if nobody sponsors it |
|---|---|
| Dec 26 | Embarkation Day: muster drill (apartment tour as a safety briefing), welcome cocktail on the Lido Deck |
| Dec 28 | Día de los Inocentes: the Capitán's one licensed prank day (fake program, reversed names), revealed by noon |
| Dec 31 | Gala Night: costume dinner, awards ceremony from participation data, countdown on the Bridge (TV mode) |
| Jan 1 | Recovery brunch at a humane hour; the morning message arrives late and whispers |
| Jan 2 | Disembarkation: group photo, "cruise memories" recap video/collage, luggage-tag jokes |

---

## 3. Architecture

```
                 ┌──────────────────────────────────────────────┐
  WhatsApp ───▶  │  Channel adapters (WhatsApp Cloud API webhook,│
  Web/PWA  ───▶  │  web chat, voice pipeline)                    │
  Voice call ─▶  │                                              │
                 └───────────────┬──────────────────────────────┘
                                 ▼
                 ┌──────────────────────────────────────────────┐
                 │  Cruise Director agent (Claude + tools)       │
                 │  persona prompt • per-person memory • tools:  │
                 │  calendar CRUD, sign-ups, reminders, flyers,  │
                 │  send message, who's-free, weather            │
                 └───────────────┬──────────────────────────────┘
                                 ▼
   ┌──────────────┐   ┌─────────────────┐   ┌──────────────────────┐
   │ Postgres     │   │ Scheduler/worker │   │ Media: flyer gen,    │
   │ (Supabase)   │   │ (morning msgs,   │   │ TTS voice notes,     │
   │ + storage    │   │ reminders, ICS)  │   │ avatar video         │
   └──────────────┘   └─────────────────┘   └──────────────────────┘
```

### 3.1 Stack (opinionated)

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** end to end | One language for web, webhooks, agent, and the realtime voice SDKs, which are all JS-first |
| Web app | Next.js (App Router) as PWA; TV mode is just a route with big type and auto-refresh | Fast to build, easy to cast to a TV via Chromecast/AirPlay tab mirroring |
| DB / auth / storage / realtime | **Supabase** (Postgres, magic-link auth, storage for flyers, realtime for the TV screen) | Zero-ops, free tier is enough for one family |
| Agent brain | **Claude Opus 5.5** (`claude-opus-5-5`) through the Anthropic TypeScript SDK **Tool Runner** (`client.beta.messages.toolRunner` + `betaZodTool`) | Best personality + reliable tool use; the runner drives the tool loop so we only write tool functions. Adaptive thinking, effort `low`–`medium` for chat turns (fast, cheap, still funny) |
| Cheap helpers | **Claude Haiku 5.5** for message classification, voice-note transcript cleanup, flyer copy variants | ~40× cheaper for mechanical steps |
| Messaging | **WhatsApp Business Cloud API** (Meta), with **Telegram Bot API as a fallback** if Meta verification stalls | WhatsApp is where the family lives; Telegram is a 10-minute setup if we need a plan B |
| Scheduler | A worker process with `pg_cron`/`cron` jobs (or Supabase cron) firing: 07:30 morning run, 5-minute reminder sweep, nightly ICS rebuild | Simple, inspectable, one timezone (America/Mexico_City) |
| Flyers | Claude writes the concept + copy → image model generates the art (e.g. Google Imagen, OpenAI gpt-image, or Flux via fal.ai; pick by Spanish-friendliness and price) → **text is overlaid by us** with `satori`/`sharp` from a few templates | Image models still garble text; overlaying title/time/host guarantees a readable flyer every time |
| Calendar | Per-person **ICS feed URL** (`/cal/<token>.ics`) that people subscribe to in Apple/Google Calendar once; optional "Add to calendar" links per activity | No OAuth onboarding for 15+ relatives; updates propagate automatically |
| Voice (Phase 2) | WhatsApp voice notes: STT (Deepgram or Whisper) → agent → TTS (ElevenLabs, Spanish-capable voice) → voice note back | "Talk to the Director" with no new app, cheap, forgiving of latency |
| Voice + video (Phase 3) | Realtime pipeline on **LiveKit Agents** or **Pipecat**: STT → Claude (same tools, same persona) → TTS → **streaming avatar** (e.g. Tavus, Simli, HeyGen Interactive Avatar) rendered in a `<video>` in the web app | Open-source orchestration, swappable vendors, same brain as WhatsApp so the Director is one character everywhere |
| Hosting | Vercel (web) + Fly.io or Railway (worker + voice agent) | Cheap, always-on worker for the scheduler |
| Observability | Simple message log table + a `/admin` page; Anthropic usage dashboard; one Slack/WhatsApp "ops" alert to you on errors | Enough to run a family app |

Safety nets on Claude calls: include server-side `fallbacks: "default"` (beta
`server-side-fallback-2026-07-01`) so a rare refusal falls through to another model instead
of a silent morning; check `stop_reason` before reading content; use prompt caching with the
persona + tool list first and the per-person context after the cache breakpoint.

### 3.2 Data model (first cut)

```
person        id, name, nickname, phone_e164, language (es|en), role (adult|kid), guardian_id,
              quiet_hours, wake_time, ics_token, joined_at, preferences(jsonb)
activity      id, title, emoji, description, sponsor_id, starts_at, ends_at, location
              (free text: "Lido Deck (balcony)", "Playa Condesa"), capacity, bring,
              recurrence (none|daily|days[]), status (draft|published|cancelled),
              flyer_url, created_via (whatsapp|web|voice)
signup        activity_id, person_id, status (going|maybe|out), reminded_at, created_at
message_log   id, person_id, channel, direction, body, media_url, tool_calls(jsonb), ts
reminder_job  id, activity_id, person_id, fire_at, kind (t-30|sponsor-t-60|morning), sent_at
memory        person_id, key, value   (e.g. "hates early mornings", "vegetarian", running gag)
```

### 3.3 Agent tools (the whole API the Director sees)

`get_program(date)`, `get_my_day(person, date)`, `create_activity(...)`,
`update_activity(...)`, `cancel_activity(id, reason)`, `signup(person, activity, status)`,
`who_is_going(activity)`, `suggest_for_empty_slots(person, date)`,
`generate_flyer(activity, vibe)`, `send_message(person|group, text, media?)`,
`schedule_reminder(...)`, `remember(person, key, value)`, `get_weather(date)`.
Strict JSON schemas (`strict: true`) so sign-ups never land on the wrong activity.

### 3.4 WhatsApp without the pain: how templates actually work for us

The fear is "every message needs Meta approval". That is not how the platform works, and the
design below needs **three templates in total**, not one per message.

**The rule.** Whenever a person sends the Capitán anything (text, a button tap, a voice note),
a **24-hour window** opens in which the Capitán may send them unlimited **free-form**
messages: jokes, flyers, interactive buttons, voice notes, whatever. Only a message the
Capitán sends *first*, with no user message in the previous 24 h, must be a pre-approved
**template**. Templates have variables (`{{1}}`, `{{2}}`), so one template covers every day.

**The design.** The only business-initiated message in the whole product is the morning
knock, and it is a short template whose job is to get a tap:

```
🚢 ¡Buenos días, {{1}}! Hoy en el Crucero Luna: {{2}}.
Tienes {{3}} actividad(es) en tu agenda. ¿Vemos el programa?
[Ver mi día]  [Sorpréndeme]  [Hoy no, Capitán]
```

Any tap counts as a user message and opens the window, so the *real* morning message, with
the full personality, flyer and sign-up buttons, goes out free-form a second later. Someone
who replied to the Capitán yesterday afternoon never even sees the template path; they get the
full message directly. Reminders almost always fall inside an open window (the person signed
up, so they talked to the Capitán); a second template `activity_reminder` covers the rare case
where they did not, and a third, `new_activity`, announces a freshly sponsored event to people
who have been quiet for a day. Template bodies must be compact (no line breaks inside
variables, not mostly variables), which is why the template is a knock and not the show.

**Provider decision (Oct 18): Meta Cloud API direct, no reseller.** Twilio's WhatsApp onboarding proved
painful, so the Capitán talks to Meta's API himself. Meta's free test number (up to 5 verified phones) runs
the pilot immediately; the real number is added in the same console when it verifies. The Twilio adapter
stays in the repo as an alternative behind the same interface.

**"We are not a business."** You do not need Meta **business verification** for this. An
unverified Meta Business portfolio can run the Cloud API with a messaging limit of a few
hundred business-initiated conversations per day, far above one family. What you do need:
a Meta Business portfolio (anyone can create one, you register as yourself), a developer app,
a payment method on file for per-message template fees (replies inside the window are free),
and a **phone number that has never been on WhatsApp** (cheap SIM or virtual number). Utility
templates like the three above usually clear review within minutes to a day; the slow part,
if any, is Meta's account checks, which is why the gate is Oct 31. Twilio's WhatsApp sandbox
is a fine way to develop before the number is live; production still runs on the same Meta
rules.

**Other realities.**
- The Cloud API cannot join a normal WhatsApp group. The Capitán talks 1:1 and the family
  group stays human. If you want the daily flyer in the group, forward it yourself (30
  seconds) or let the Capitán's web program page be the shared view.
- Do **not** use unofficial WhatsApp Web automation libraries to get group posting. They work
  until Meta bans the number, which it tends to do at the worst possible moment.
- **Consent:** everyone opts in by sending the first message ("Hola Capitán") and can say
  "stop" / "menos chistes" / "solo recordatorios" any time; the agent has a tool for that.

**Plan B: Telegram (decided at the Oct 31 gate).** A Telegram bot needs no approval, no
templates, no business account, can live *inside* the family group, supports buttons, voice
notes and round "video notes" (a very cruise-TV way to deliver the morning hype), and is
free. The cost is asking every relative to install one more app for the trip. Everything
above WhatsApp in the architecture is channel-agnostic, so flipping is about a day of
adapter work, not a rewrite.

### 3.5 The Capitán's phone number

**What the number actually has to do.** Nothing geographic. WhatsApp runs over the internet,
so a +1 number messages a Mexican WhatsApp user exactly like a +52 one, and Meta bills
template messages by the *recipient's* country, not the sender's. The number only has to
(a) receive a one-time code by SMS or voice call at registration and at any later
re-verification Meta asks for, (b) never have been on WhatsApp, and (c) stay under your
control through Jan 2. Pick for reliability of receiving codes, nothing else.

| Option | Cost | Verdict |
|---|---|---|
| **Twilio US local number, SMS-capable** (register it with Meta Cloud API directly, or via Twilio's WhatsApp sender sign-up which runs the OTP step for you) | ~$1.15/month | **Recommended.** Twilio numbers are the virtual numbers with the best track record on WhatsApp verification. Receiving the OTP needs no 10DLC registration (that is for *sending* SMS). Read the code in the Twilio console message log. |
| **Prepaid eSIM as a second line on your own phone** (Tello, Ultra Mobile PayGo, US Mobile) | ~$3–10/month | **Solid alternative.** A real mobile number is what Meta rates best for SMS codes. Never open WhatsApp with it, and keep the plan paid through Jan 2 in case of re-verification. |
| Twilio toll-free number | ~$2.15/month | Works, usually via voice OTP; no advantage over local. |
| Google Voice, TextNow, free "virtual number" apps | free | **Avoid.** Meta rates VoIP numbers "not recommended" for SMS codes and these fail verification often. |
| A Mexican (+52) number via Twilio | regulatory bundle | **Skip.** Requires identity plus Mexican address proof per Twilio's Mexico rules, and Mexican mobile numbers are barred from automated messaging. Zero benefit for WhatsApp delivery. |

**Display name.** Meta reviews the WhatsApp display name against the business portfolio name.
Name the portfolio "Crucero Luna" and use "Crucero Luna" (or "Capitán Lunático · Crucero
Luna") as the display name; everyone saves the contact as Capitán Lunático on their own phone
anyway. A rejected display name caps the number at 250 business-initiated messages per day,
which would still be fine for 20 people, but avoid the hassle.

**Before you own any number.** The Meta developer app ships with a **free test number** that
can message up to 5 pre-verified recipients. Phase 1 development runs on that; the real
number only has to be live by the Oct 31 gate.

**Cooldowns.** If a code fails, wait 10+ minutes before retrying; repeated failures or a
number recently deleted from WhatsApp can trigger a cooldown of up to 24 hours.

---

## 4. Phased plan

### Phase 0 — Decisions & accounts (this week, Oct 17–24)
- [x] Director's name (Capitán Lunático) and trip dates (Dec 26 – Jan 2). Still open:
      language default, apartment "deck map".
- [x] Phone number bought (Twilio US local; reusable as the Meta number once any Twilio WhatsApp sender registration on it is removed).
- [ ] Meta for Developers app + Business portfolio "Crucero Luna"; test number working with 5 pilot phones; System User permanent token; real number added; the three templates submitted (`morning_knock` with 3 quick-reply buttons, `activity_reminder`, `new_activity`).
- [x] **Oct 31 gate:** decided early (Oct 19): the real number sits in a Twilio-created WABA whose inbound never
      reached the app, so the primary channel is **Telegram**; WhatsApp is parked in the code.
- [ ] Create Supabase project, Anthropic API key with a monthly spend cap, image-gen key,
      ElevenLabs key. Vercel + Fly.io accounts.
- [x] Repo scaffolding (pnpm monorepo: `packages/db`, `packages/agent`, `apps/cli`, `evals`; `apps/web` and `apps/worker` come with Phase 1).

### Phase 1 — The cruise exists (Oct 24 – Nov 7)
Deliverable: you and two testers can sponsor, sign up, get the morning message, see TV mode.
- [x] Postgres schema (`packages/db/sql/001_init.sql`), `Store` contract, dev `MemoryStore`, sample week seeded, `PgStore` tested on PGlite.
- [x] Agent core: persona prompt, 14 tools, Tool Runner loop, per-person memory, message log, local CLI harness (`pnpm chat`).
- [x] WhatsApp webhook (inbound text, buttons, media, voice-note acknowledgement) + outbound (text, media, interactive buttons, templates) through **Meta Cloud API direct**, with Twilio as the alternative adapter; onboarding of unknown numbers; per-passenger conversation history; webhook retry de-duplication. [ ] Live test on the Meta test number once the keys land.
- [x] Web app on the same server: program view, activity page, sponsor form, "my cruise", private links from the Capitán instead of magic-link email (owner's call, Oct 20).
- [x] TV mode route: today's program, "now / next" with countdown, QR codes to sign up, rotating
  flyers, auto-refresh by polling every 30 s (no Supabase realtime needed).
- [x] Scheduler: morning run per person (template knock + parked full message), T-30 reminder sweep with guardian routing, T-60 sponsor nudges, ICS feed per person (`/cal/<token>.ics`). [x] Deploy (Fly.io, one-button workflow). [ ] Supabase (code ready; owner creates the project).
- [x] Flyer generator v1 (Flux via fal.ai + overlaid text and sign-up QR; 5 vibes with designed fallbacks).
- [x] Eval set: 40 realistic WhatsApp messages (Spanglish, typos, kids, "cancel yoga", "who's
  going to bingo") with expected tool calls (`pnpm eval`); run it on every persona/prompt change.
- [x] Morning-program generator (deterministic brief + structured output: template knock line,
  full message, button ids), wired into the scheduler.

### Phase 2 — Delightful & robust (Nov 7 – Nov 17)
- WhatsApp voice notes in both directions (STT → agent → TTS voice note).
- Suggestions engine for empty days (prefers activities with few sign-ups, respects memory).
- Sponsor nudges ("Thursday afternoon is empty, who wants to host?"), capacity + waitlists.
- Admin page for you: pause the Director, edit any activity, resend a morning message, cost meter.
- Onboarding flow: first message → name confirmation → language → quiet hours → "subscribe to
  your calendar" link → first joke.
- Pilot with 3–5 family members for a week; fix what confuses them.
- **Nov 14–17: launch to the whole family** with a "sponsor an activity" campaign.

### Phase 3 — The bridge (Nov 17 – Dec, in parallel with the calendar filling up)
- Realtime voice agent (LiveKit Agents or Pipecat) sharing the same tools and persona.
- Streaming avatar in the web app ("Call the Bridge"), works on a phone and on the TV.
- Pre-recorded fallbacks: a daily 30-second "good morning" video the avatar vendor renders
  overnight, shown in TV mode even if live calls are down.
- Latency budget: < 1.5 s to first word; cache persona prefix; effort `low` on voice turns.
- Hard kill switch: if the live call fails twice, the button becomes "Send the Director a
  voice note on WhatsApp" instead of a broken call.

### Phase 4 — At sea (the trip)
- On-call runbook (you): daily cost check, pause/resume, manual program override.
- Photo collection: people send photos to the Director, nightly recap collage.
- End-of-cruise awards ceremony generated from participation data (most activities hosted,
  most early mornings, etc.).

---

## 5. Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| Meta verification/template approval late | Start Phase 0 now; Telegram fallback is a day of work; web + ICS still function |
| Avatar is laggy or expensive | Phase 3 is additive; voice notes in Phase 2 already give "voice"; pre-rendered daily video as fallback |
| Jokes misfire with family members | Persona rules + a "humor level" per person + eval set with cringe-check; "menos chistes" command |
| Relatives don't onboard | Onboarding is one WhatsApp message; you can pre-register everyone by phone number; TV + QR codes capture the rest |
| Runaway cost | API spend caps, Haiku for mechanical steps, caching, per-person daily message limits |
| Timezone/DST bugs in reminders | Store UTC, schedule in `America/Mexico_City`, test the morning run with a fake clock |
| Kids / privacy | Guardian routing for under-13s, no photos leave the family bucket, numbers never shared with vendors beyond WhatsApp itself |

---

## 6. Rough running cost for the trip (order of magnitude, verify current prices)

| Item | Estimate |
|---|---|
| Claude (≈20 people × ~15 turns/day × 2 weeks, Opus 5.5 with caching + Haiku helpers) | $20–60 total |
| WhatsApp conversations (utility/marketing templates per person per day) | $10–40 total |
| Flyer image generation (≈100 flyers) | $5–15 |
| TTS voice notes | $5–20 |
| Avatar + realtime voice minutes (Phase 3) | $0.1–0.5 per minute; budget ~$50–150 for the trip |
| Hosting (Vercel hobby, Fly.io small VM, Supabase free/pro) | $0–30/month |

---

## 7. Open decisions for you

1. Who owns the Meta Business portfolio and the Twilio account (you, presumably), and the Anthropic/API billing.
2. Avatar vendor appetite: "wow factor at any cost" vs. "nice if it works" (affects how much of Phase 3 to commit to).
3. Whether the human family WhatsApp group stays human-only (recommended) or you forward the Capitán's daily flyer there.
4. If Meta is not working by Oct 31: Telegram for everyone, or WhatsApp-only-for-you plus Telegram for the rest? (The plan assumes one channel for all.)

## 8. Immediate next steps (what I'd do first if you say go)

1. Scaffold the monorepo (TypeScript, Next.js, Supabase, worker) with the schema in §3.2.
2. Implement the agent package with the persona in `docs/persona.md`, the tools in §3.3, and a CLI harness so you can chat with the Capitán locally before any channel exists.
3. Build the eval set and the morning-message generator next, then the WhatsApp adapter once Meta approves the number.
