import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  type Activity,
  type Person,
  type Store,
  addDays,
  dayBounds,
  mx,
  shipDate,
} from "@crucero/db";
import { z } from "zod";
import { describeActivity } from "./context.js";

/** Where outbound messages go: WhatsApp adapter, web push, or the CLI console. */
export interface Outbox {
  send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string; from: Person }): Promise<void>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
}

export interface ToolContext {
  store: Store;
  passenger: Person;
  now: Date;
  outbox: Outbox;
  /** Observability + evals: every executed tool call is reported here. */
  onToolCall?: (rec: ToolCallRecord) => void;
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Ship-local calendar date, YYYY-MM-DD");
const TIME = z.string().regex(/^\d{2}:\d{2}$/).describe("Ship-local 24h time, HH:MM");

function json(v: unknown): string {
  return JSON.stringify(v);
}

async function resolvePerson(ctx: ToolContext, name: string | undefined): Promise<Person> {
  if (!name || /^(me|yo|mí|mi)$/i.test(name)) return ctx.passenger;
  const p = await ctx.store.findPersonByName(name);
  if (!p) throw new Error(`No passenger named "${name}" on the manifest. Ask who they mean or use list_passengers.`);
  return p;
}

async function programFor(ctx: ToolContext, date: string, includeCancelled = false): Promise<Activity[]> {
  const { from, to } = dayBounds(date);
  return ctx.store.listActivities({ from, to, status: includeCancelled ? ["published", "cancelled", "draft"] : undefined });
}

async function activitiesFor(ctx: ToolContext, person: Person, date: string): Promise<Activity[]> {
  const mine = (await ctx.store.listSignupsForPerson(person.id)).filter((s) => s.status !== "out");
  const ids = new Set(mine.map((s) => s.activityId));
  const all = await programFor(ctx, date);
  return all.filter((a) => ids.has(a.id) || a.sponsorId === person.id);
}

/**
 * Suggestion heuristic for empty days: published activities today the passenger is not in,
 * preferring ones with the fewest sign-ups (they need love) and respecting known memory
 * (e.g. "nothing before 9"). Pure and testable.
 */
export async function suggestActivities(ctx: ToolContext, person: Person, date: string, limit = 3): Promise<Activity[]> {
  const all = await programFor(ctx, date);
  const mine = new Set((await ctx.store.listSignupsForPerson(person.id)).map((s) => s.activityId));
  const memory = await ctx.store.getMemory(person.id);
  const notEarly = memory.some((m) => /madrugad|early_morning|before (9|nine)|antes de las 9/i.test(`${m.key} ${m.value}`));
  const nowIso = ctx.now.toISOString();
  const candidates = all.filter((a) => !mine.has(a.id) && a.sponsorId !== person.id && a.startsAt > nowIso);
  const scored = await Promise.all(
    candidates.map(async (a) => {
      const going = (await ctx.store.listSignups(a.id)).filter((s) => s.status === "going").length;
      const full = a.capacity !== undefined && going >= a.capacity;
      const hour = Number(new Date(a.startsAt).toLocaleString("en-US", { timeZone: "America/Mexico_City", hour: "2-digit", hour12: false }));
      let score = going; // fewer sign-ups first
      if (full) score += 1000;
      if (notEarly && hour < 9) score += 100;
      if (person.role === "kid" && hour >= 21) score += 100;
      return { a, score };
    }),
  );
  return scored
    .sort((x, y) => x.score - y.score || x.a.startsAt.localeCompare(y.a.startsAt))
    .slice(0, limit)
    .map((x) => x.a);
}

export function buildTools(ctx: ToolContext) {
  const { store, passenger } = ctx;
  const lang = passenger.language;
  const wrap = <I, R>(name: string, fn: (input: I) => Promise<R>) => async (input: I): Promise<string> => {
    try {
      const out = await fn(input);
      const text = typeof out === "string" ? out : json(out);
      ctx.onToolCall?.({ name, input, output: text });
      return text;
    } catch (err) {
      const text = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      ctx.onToolCall?.({ name, input, output: text });
      return text;
    }
  };

  const get_program = betaZodTool({
    name: "get_program",
    description: "The ship's full program for a ship-local date: every published activity with id, time, place, host, sign-up count and capacity. Use it before answering any question about what is happening.",
    inputSchema: z.object({ date: DATE, include_cancelled: z.boolean().optional() }),
    run: wrap("get_program", async ({ date, include_cancelled }) => {
      const acts = await programFor(ctx, date, include_cancelled);
      if (!acts.length) return `No activities on ${date}. The deck chairs are lonely; suggest someone sponsors something.`;
      return (await Promise.all(acts.map((a) => describeActivity(store, a, lang)))).join("\n");
    }),
  });

  const get_my_day = betaZodTool({
    name: "get_my_day",
    description: "Activities a passenger is signed up for or hosting on a date. Defaults to the current passenger; pass person_name to look up someone else (e.g. a parent asking about their kid).",
    inputSchema: z.object({ date: DATE, person_name: z.string().optional() }),
    run: wrap("get_my_day", async ({ date, person_name }) => {
      const person = await resolvePerson(ctx, person_name);
      const acts = await activitiesFor(ctx, person, date);
      if (!acts.length) return `${person.name} has nothing on ${date}. Empty deck chair: offer suggestions (suggest_for_empty_slots).`;
      return (await Promise.all(acts.map((a) => describeActivity(store, a, lang)))).join("\n");
    }),
  });

  const list_passengers = betaZodTool({
    name: "list_passengers",
    description: "The passenger manifest: names, ids, language, role, and guardians for kids.",
    inputSchema: z.object({}),
    run: wrap("list_passengers", async () => {
      const people = await store.listPeople();
      return people
        .map((p) => `${p.name} (id ${p.id}, ${p.language}, ${p.role}${p.guardianId ? `, guardian ${p.guardianId}` : ""}${p.nickname ? `, aka ${p.nickname}` : ""})`)
        .join("\n");
    }),
  });

  const create_activity = betaZodTool({
    name: "create_activity",
    description: "Create (sponsor) a new activity on the program. The sponsor defaults to the current passenger. Call it right away when what, day, start time and place are all clear (default end_time to ~90 minutes after start); otherwise only after the passenger confirmed the one-line summary.",
    inputSchema: z.object({
      title: z.string().min(3).max(80),
      emoji: z.string().min(1).max(4).describe("One emoji that fits the activity"),
      date: DATE,
      start_time: TIME,
      end_time: TIME,
      location: z.string().min(2).max(80).describe("Ship-speak place, e.g. 'Lido Deck (balcón)' or 'Playa Condesa'"),
      description: z.string().max(400).optional(),
      capacity: z.number().int().positive().optional(),
      bring: z.string().max(120).optional(),
      sponsor_name: z.string().optional().describe("Only if someone other than the current passenger hosts it"),
    }),
    run: wrap("create_activity", async (i) => {
      const sponsor = await resolvePerson(ctx, i.sponsor_name);
      let endsAt = mx(i.date, i.end_time);
      const startsAt = mx(i.date, i.start_time);
      if (endsAt <= startsAt) endsAt = mx(addDays(i.date, 1), i.end_time); // crosses midnight (the countdown)
      const a = await store.createActivity({
        title: i.title,
        emoji: i.emoji,
        description: i.description,
        sponsorId: sponsor.id,
        startsAt,
        endsAt,
        location: i.location,
        capacity: i.capacity,
        bring: i.bring,
        createdVia: "cli",
      });
      await store.setSignup(a.id, sponsor.id, "going");
      return `Created: ${await describeActivity(store, a, lang)}`;
    }),
  });

  const update_activity = betaZodTool({
    name: "update_activity",
    description: "Change details of an existing activity (time, place, capacity, what to bring, title). Only the sponsor, or someone relaying the sponsor's wish, should change it.",
    inputSchema: z.object({
      activity_id: z.string(),
      title: z.string().min(3).max(80).optional(),
      date: DATE.optional(),
      start_time: TIME.optional(),
      end_time: TIME.optional(),
      location: z.string().max(80).optional(),
      description: z.string().max(400).optional(),
      capacity: z.number().int().positive().optional(),
      bring: z.string().max(120).optional(),
    }),
    run: wrap("update_activity", async (i) => {
      const a = await store.getActivity(i.activity_id);
      if (!a) throw new Error(`No activity ${i.activity_id}`);
      const date = i.date ?? shipDate(a.startsAt);
      const patch: Partial<Activity> = {};
      if (i.title) patch.title = i.title;
      if (i.location) patch.location = i.location;
      if (i.description) patch.description = i.description;
      if (i.capacity) patch.capacity = i.capacity;
      if (i.bring) patch.bring = i.bring;
      if (i.date || i.start_time) patch.startsAt = mx(date, i.start_time ?? a.startsAt.slice(11, 16));
      if (i.date || i.end_time) patch.endsAt = mx(date, i.end_time ?? a.endsAt.slice(11, 16));
      if (i.start_time && !i.end_time) {
        // keep the original duration
        const dur = new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime();
        patch.endsAt = new Date(new Date(patch.startsAt!).getTime() + dur).toISOString();
      }
      const updated = await store.updateActivity(a.id, patch);
      return `Updated: ${await describeActivity(store, updated, lang)}`;
    }),
  });

  const cancel_activity = betaZodTool({
    name: "cancel_activity",
    description: "Cancel an activity. Requires a reason. Only for the sponsor (or relaying the sponsor). Does not notify anyone by itself; follow with send_message if people had signed up.",
    inputSchema: z.object({ activity_id: z.string(), reason: z.string().min(2).max(200) }),
    run: wrap("cancel_activity", async ({ activity_id, reason }) => {
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      const updated = await store.updateActivity(a.id, { status: "cancelled", cancelledReason: reason });
      const affected = (await store.listSignups(a.id)).filter((s) => s.status !== "out" && s.personId !== a.sponsorId);
      const names = (await Promise.all(affected.map(async (s) => (await store.getPerson(s.personId))?.name))).filter(Boolean);
      return `Cancelled: ${await describeActivity(store, updated, lang)}. Signed-up passengers to notify: ${names.join(", ") || "none"}.`;
    }),
  });

  const signup = betaZodTool({
    name: "signup",
    description: "Sign a passenger up for an activity (status 'going'), mark them 'maybe', or take them off ('out'). Defaults to the current passenger; pass person_name to act for a kid or someone who asked.",
    inputSchema: z.object({
      activity_id: z.string(),
      status: z.enum(["going", "maybe", "out"]),
      person_name: z.string().optional(),
    }),
    run: wrap("signup", async ({ activity_id, status, person_name }) => {
      const person = await resolvePerson(ctx, person_name);
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      if (a.status === "cancelled") throw new Error(`"${a.title}" is cancelled.`);
      if (status === "going" && a.capacity !== undefined) {
        const going = (await store.listSignups(a.id)).filter((s) => s.status === "going" && s.personId !== person.id).length;
        if (going >= a.capacity) {
          await store.setSignup(a.id, person.id, "maybe");
          return `FULL: "${a.title}" is at capacity (${going}/${a.capacity}). ${person.name} is on the waitlist as 'maybe'. Tell them honestly and offer alternatives.`;
        }
      }
      await store.setSignup(a.id, person.id, status);
      const count = (await store.listSignups(a.id)).filter((s) => s.status === "going").length;
      return `${person.name} is now '${status}' for ${await describeActivity(store, a, lang)}. Going now: ${count}.`;
    }),
  });

  const who_is_going = betaZodTool({
    name: "who_is_going",
    description: "Who signed up for an activity, split into going / maybe.",
    inputSchema: z.object({ activity_id: z.string() }),
    run: wrap("who_is_going", async ({ activity_id }) => {
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      const s = await store.listSignups(a.id);
      const names = async (st: string) =>
        (await Promise.all(s.filter((x) => x.status === st).map(async (x) => (await store.getPerson(x.personId))?.name ?? x.personId))).join(", ") || "nobody yet";
      return `${a.emoji} ${a.title}: going: ${await names("going")}; maybe: ${await names("maybe")}.`;
    }),
  });

  const suggest_for_empty_slots = betaZodTool({
    name: "suggest_for_empty_slots",
    description: "Up to 3 activities on a date that the passenger is not in yet, favoring under-subscribed ones and respecting what you remember about them. Use when their day looks empty.",
    inputSchema: z.object({ date: DATE, person_name: z.string().optional() }),
    run: wrap("suggest_for_empty_slots", async ({ date, person_name }) => {
      const person = await resolvePerson(ctx, person_name);
      const picks = await suggestActivities(ctx, person, date);
      if (!picks.length) return `Nothing left to suggest on ${date}. Nudge them to sponsor something.`;
      return (await Promise.all(picks.map((a) => describeActivity(store, a, lang)))).join("\n");
    }),
  });

  const generate_flyer = betaZodTool({
    name: "generate_flyer",
    description: "Request an AI-generated flyer for an activity in a given vibe. Returns the creative brief that will be rendered; the image pipeline attaches the flyer to the activity when ready.",
    inputSchema: z.object({
      activity_id: z.string(),
      vibe: z.enum(["fiesta", "zen", "retro-cruise", "kids", "gala"]),
      tagline: z.string().max(80).describe("A short funny tagline in the passenger's language"),
    }),
    run: wrap("generate_flyer", async ({ activity_id, vibe, tagline }) => {
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      await store.updateActivity(a.id, { flyerUrl: `pending:${vibe}:${tagline}` });
      return `Flyer queued (vibe: ${vibe}, tagline: "${tagline}") for "${a.title}". It is not rendered yet; tell the passenger it is in the print shop, do not claim it is attached.`;
    }),
  });

  const send_message = betaZodTool({
    name: "send_message",
    description: "Send a WhatsApp message from the Capitán to another passenger or to everyone (announcements, cancellation notices, sponsor nudges). Never use it for the reply to the current passenger; just answer them. Respect quiet hours.",
    inputSchema: z.object({
      to: z.string().describe("A passenger's name, or 'everyone'"),
      text: z.string().min(1).max(1200),
    }),
    run: wrap("send_message", async ({ to, text }) => {
      if (to.toLowerCase() === "everyone" || to.toLowerCase() === "todos") {
        await ctx.outbox.send("everyone", text, { from: passenger });
        return `Sent to everyone.`;
      }
      const p = await resolvePerson(ctx, to);
      if (p.muted) return `NOT SENT: ${p.name} asked the Capitán not to message them proactively. Suggest telling them in person.`;
      await ctx.outbox.send(p, text, { from: passenger });
      return `Sent to ${p.name}.`;
    }),
  });

  const remember = betaZodTool({
    name: "remember",
    description: "Store a personal detail about the current passenger for future kindness (diet, fears, sleep habits, favorite things, running gags). Short key, short value.",
    inputSchema: z.object({ key: z.string().min(2).max(40), value: z.string().min(1).max(200) }),
    run: wrap("remember", async ({ key, value }) => {
      await store.remember(passenger.id, key, value);
      return `Noted (${key}).`;
    }),
  });

  const set_preferences = betaZodTool({
    name: "set_preferences",
    description: "Update the current passenger's settings: humor level ('full', 'light', 'off' = only logistics), language, quiet hours, morning message time, and muted (true = they asked for no proactive messages at all: no morning program, reminders or announcements; false = resume).",
    inputSchema: z.object({
      humor: z.enum(["full", "light", "off"]).optional(),
      language: z.enum(["es", "en"]).optional(),
      quiet_start: TIME.optional(),
      quiet_end: TIME.optional(),
      wake_time: TIME.optional(),
      muted: z.boolean().optional(),
    }),
    run: wrap("set_preferences", async (i) => {
      const patch: Partial<Person> = {};
      if (i.humor) patch.humor = i.humor;
      if (i.language) patch.language = i.language;
      if (i.wake_time) patch.wakeTime = i.wake_time;
      if (i.muted !== undefined) patch.muted = i.muted;
      if (i.quiet_start && i.quiet_end) patch.quietHours = { start: i.quiet_start, end: i.quiet_end };
      await store.updatePerson(passenger.id, patch);
      return `Preferences updated: ${json(patch)}.`;
    }),
  });

  const get_weather = betaZodTool({
    name: "get_weather",
    description: "Weather outlook for Acapulco on a date. Until a live provider is wired, returns late-December climatology, clearly labeled.",
    inputSchema: z.object({ date: DATE }),
    run: wrap("get_weather", async ({ date }) => {
      return `Climatology for Acapulco on ${date} (not a live forecast): sunny, high ~31°C / low ~23°C, water ~28°C, rain very unlikely, sunset ~6:10 pm. Treat it as "arranged by the cruise line", but do not promise exact numbers.`;
    }),
  });

  return [
    get_program,
    get_my_day,
    list_passengers,
    create_activity,
    update_activity,
    cancel_activity,
    signup,
    who_is_going,
    suggest_for_empty_slots,
    generate_flyer,
    send_message,
    remember,
    set_preferences,
    get_weather,
  ];
}
