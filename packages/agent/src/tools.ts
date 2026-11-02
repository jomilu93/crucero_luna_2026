import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  type Activity,
  type Channel,
  type Person,
  type Store,
  addDays,
  dayBounds,
  inQuietHours,
  isPaused,
  mx,
  shipDate,
  shipTime,
} from "@crucero/db";
import { z } from "zod";
import { CONCHITAS, chestFor, vouchedFor } from "./conchitas.js";
import { describeActivity } from "./context.js";

/** Where outbound messages go: WhatsApp adapter, web push, or the CLI console. */
export interface Outbox {
  send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string; from: Person }): Promise<void>;
}

export interface FlyerMaker {
  make(activityId: string, vibe: "fiesta" | "zen" | "retro-cruise" | "kids" | "gala", lang: "es" | "en", taglineHint?: string): Promise<{ url: string }>;
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
  /** Where the conversation happens; recorded on activities the passenger creates. */
  channel?: Channel;
  /** Renders flyers (Claude brief + image model + overlaid text). Absent → the tool only queues. */
  flyers?: FlyerMaker;
  /** Builds a passenger's private web link (the web app). Absent → no web app on this deployment. */
  cabinLink?: (person: Person) => string;
  /** Observability + evals: every executed tool call is reported here. */
  onToolCall?: (rec: ToolCallRecord) => void;
  /** Fired as a tool begins (a voice call says a filler line while the Capitán looks something up). */
  onToolStart?: (name: string) => void;
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

/** The host, the host's guardian, or an admin (who fixes anyone's mistakes). */
export function canManage(person: Person, activity: Activity, host: Person | undefined): boolean {
  return activity.sponsorId === person.id || (!!host?.guardianId && host.guardianId === person.id) || person.admin === true;
}

async function notAllowed(ctx: ToolContext, a: Activity, what: string): Promise<string> {
  const host = await ctx.store.getPerson(a.sponsorId);
  return `NOT ALLOWED: only the host (${host?.name ?? a.sponsorId}) can ${what} "${a.title}". Nothing was changed. Tell the passenger in their own language and offer to pass the request to them with send_message.`;
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
      ctx.onToolStart?.(name);
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
        createdVia: ctx.channel ?? "cli",
      });
      await store.setSignup(a.id, sponsor.id, "going");
      return `Created: ${await describeActivity(store, a, lang)}`;
    }),
  });

  const update_activity = betaZodTool({
    name: "update_activity",
    description: "Change details of an existing activity (time, place, capacity, what to bring, title, emoji). Only the host (or the host's guardian, or an admin) can; for anyone else it returns NOT ALLOWED and changes nothing.",
    inputSchema: z.object({
      activity_id: z.string(),
      title: z.string().min(3).max(80).optional(),
      emoji: z.string().min(1).max(8).optional(),
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
      if (!canManage(passenger, a, await store.getPerson(a.sponsorId))) return notAllowed(ctx, a, "change");
      const date = i.date ?? shipDate(a.startsAt);
      const patch: Partial<Activity> = {};
      if (i.title) patch.title = i.title;
      if (i.emoji) patch.emoji = i.emoji;
      if (i.location) patch.location = i.location;
      if (i.description) patch.description = i.description;
      if (i.capacity) patch.capacity = i.capacity;
      if (i.bring) patch.bring = i.bring;
      // Reuse the current times in ship time (startsAt/endsAt are stored in UTC).
      if (i.date || i.start_time) patch.startsAt = mx(date, i.start_time ?? shipTime(a.startsAt));
      if (i.date || i.end_time) patch.endsAt = mx(date, i.end_time ?? shipTime(a.endsAt));
      if (patch.endsAt && patch.endsAt <= (patch.startsAt ?? a.startsAt)) patch.endsAt = mx(addDays(date, 1), i.end_time ?? shipTime(a.endsAt)); // crosses midnight
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
    description: "Cancel an activity. Requires a reason. Only the host (or the host's guardian, or an admin) can; for anyone else it returns NOT ALLOWED. Does not notify anyone by itself; follow with send_message if people had signed up.",
    inputSchema: z.object({ activity_id: z.string(), reason: z.string().min(2).max(200) }),
    run: wrap("cancel_activity", async ({ activity_id, reason }) => {
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      if (!canManage(passenger, a, await store.getPerson(a.sponsorId))) return notAllowed(ctx, a, "cancel");
      const updated = await store.updateActivity(a.id, { status: "cancelled", cancelledReason: reason });
      const affected = (await store.listSignups(a.id)).filter((s) => s.status !== "out" && s.personId !== a.sponsorId);
      const names = (await Promise.all(affected.map(async (s) => (await store.getPerson(s.personId))?.name))).filter(Boolean);
      return `Cancelled: ${await describeActivity(store, updated, lang)}. Signed-up passengers to notify: ${names.join(", ") || "none"}.`;
    }),
  });

  const signup = betaZodTool({
    name: "signup",
    description: "Sign a passenger up for an activity (status 'going'), mark them 'maybe', or take them off ('out'). Defaults to the current passenger; pass person_name to act for a kid or someone who asked. Only the person themself or their guardian can take someone off.",
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
      // Adding someone is a friendly act; taking them off is theirs (or their guardian's) to decide.
      if (status === "out" && person.id !== passenger.id && person.guardianId !== passenger.id) {
        return `NOT ALLOWED: only ${person.name} (or their guardian) can take them off "${a.title}". Nothing was changed. Offer to pass the message along with send_message.`;
      }
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
    description: "Make a flyer for an activity in a given vibe and send it to the current passenger as an image (it takes ~15 seconds). It is also attached to the activity for the web app and the TV. Mention it in your reply; to share it with others, use send_message afterwards.",
    inputSchema: z.object({
      activity_id: z.string(),
      vibe: z.enum(["fiesta", "zen", "retro-cruise", "kids", "gala"]),
      tagline: z.string().max(80).optional().describe("Optional short funny tagline in the passenger's language; the designer writes one otherwise"),
    }),
    run: wrap("generate_flyer", async ({ activity_id, vibe, tagline }) => {
      const a = await store.getActivity(activity_id);
      if (!a) throw new Error(`No activity ${activity_id}`);
      if (a.status === "cancelled") throw new Error(`"${a.title}" is cancelled.`);
      if (!ctx.flyers) {
        await store.updateActivity(a.id, { flyerUrl: `pending:${vibe}:${tagline ?? ""}` });
        return `Flyer queued (vibe: ${vibe}) for "${a.title}". The print shop is not running here; tell the passenger it is pending, do not claim it is attached.`;
      }
      const { url } = await ctx.flyers.make(a.id, vibe, lang, tagline);
      await ctx.outbox.send(passenger, `${a.emoji} ${a.title}`, { mediaUrl: url, from: passenger });
      return `Flyer for "${a.title}" sent to ${passenger.name} as an image and attached to the activity (${url}). Do not paste the URL; say it is in their chat.`;
    }),
  });

  const send_message = betaZodTool({
    name: "send_message",
    description: "Send a chat message from the Capitán to another passenger or to everyone (announcements, cancellation notices, sponsor nudges). Never use it for the reply to the current passenger; just answer them. Passengers in their quiet hours or muted are skipped and reported back.",
    inputSchema: z.object({
      to: z.string().describe("A passenger's name, or 'everyone'"),
      text: z.string().min(1).max(1200),
    }),
    run: wrap("send_message", async ({ to, text }) => {
      if (to.toLowerCase() === "everyone" || to.toLowerCase() === "todos") {
        // One by one, so muted passengers and quiet hours are respected (the sender included is fine: they asked).
        const sent: string[] = [];
        const held: string[] = [];
        for (const p of await store.listPeople()) {
          if (p.muted || !p.phoneE164) continue;
          if (p.id !== passenger.id && inQuietHours(ctx.now, p.quietHours)) {
            held.push(`${p.name} (quiet until ${p.quietHours!.end})`);
            continue;
          }
          await ctx.outbox.send(p, text, { from: passenger });
          sent.push(p.name);
        }
        return `Sent to ${sent.length} passenger(s).${held.length ? ` Held back for quiet hours: ${held.join(", ")}. Nothing is queued; offer to resend later.` : ""}`;
      }
      const p = await resolvePerson(ctx, to);
      if (p.muted) return `NOT SENT: ${p.name} asked the Capitán not to message them proactively. Suggest telling them in person.`;
      if (inQuietHours(ctx.now, p.quietHours)) {
        return `NOT SENT: it is ${shipTime(ctx.now)} and ${p.name} is in quiet hours until ${p.quietHours!.end}. Nothing is queued; offer to send it after ${p.quietHours!.end}.`;
      }
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

  // ----- conchitas 🐚 -----
  const startedOrNot = (a: Activity) => (a.startsAt > ctx.now.toISOString() ? `"${a.title}" hasn't started yet; conchitas are confirmed once it happens.` : undefined);

  const mark_attendance = betaZodTool({
    name: "mark_attendance",
    description: `The host says who came to their activity (after it started): each guest marked as there earns ${CONCHITAS.guest} conchitas. attended=false takes someone off. Only the host (or the host's guardian, or an admin) can.`,
    inputSchema: z.object({ activity_id: z.string(), people: z.array(z.string()).min(1).max(30), attended: z.boolean().optional() }),
    run: wrap("mark_attendance", async ({ activity_id, people, attended }) => {
      const a = await store.getActivity(activity_id);
      if (!a || a.status === "cancelled") throw new Error(`No live activity ${activity_id}`);
      if (!canManage(passenger, a, await store.getPerson(a.sponsorId))) return notAllowed(ctx, a, "say who came to");
      const early = startedOrNot(a);
      if (early) return `NOT YET: ${early}`;
      const done: string[] = [];
      for (const name of people) {
        const p = (await store.getPerson(name)) ?? (await resolvePerson(ctx, name)); // a passenger id (web) or a name (chat)
        if (p.id === a.sponsorId) continue; // the host earns by being vouched for, not by marking themselves
        await store.setAttendance(a.id, p.id, { host: attended !== false });
        done.push(p.name);
      }
      const rows = await store.listAttendance(a.id);
      const marked = new Set(rows.filter((r) => r.hostConfirmedAt).map((r) => r.personId));
      const unmarked = (await store.listSignups(a.id)).filter((s) => s.status !== "out" && s.personId !== a.sponsorId && !marked.has(s.personId));
      const names = async (ids: string[]) => (await Promise.all(ids.map(async (id) => (await store.getPerson(id))?.name ?? id))).join(", ");
      return `${attended === false ? "Unmarked" : `Marked as there (+${CONCHITAS.guest} conchitas each)`}: ${done.join(", ") || "nobody"} at "${a.title}" [${a.id}]. Signed up but not marked: ${(await names(unmarked.map((s) => s.personId))) || "none"}. Host's ${CONCHITAS.host}: ${vouchedFor(a, rows) ? "earned (a guest confirmed)" : "waiting for a guest to confirm the activity happened"}.`;
    }),
  });

  const confirm_event = betaZodTool({
    name: "confirm_event",
    description: `The current passenger confirms an activity they went to really happened (that the host organized it). That earns the host ${CONCHITAS.host} conchitas; the passenger's own ${CONCHITAS.guest} come when the host marks them as there.`,
    inputSchema: z.object({ activity_id: z.string() }),
    run: wrap("confirm_event", async ({ activity_id }) => {
      const a = await store.getActivity(activity_id);
      if (!a || a.status === "cancelled") throw new Error(`No live activity ${activity_id}`);
      if (a.sponsorId === passenger.id) return `NOT ALLOWED: ${passenger.name} hosts "${a.title}"; a guest has to confirm it. Ask who came instead (mark_attendance).`;
      const early = startedOrNot(a);
      if (early) return `NOT YET: ${early}`;
      const row = await store.setAttendance(a.id, passenger.id, { guest: true });
      const host = await store.getPerson(a.sponsorId);
      return `Confirmed "${a.title}" [${a.id}] happened: ${host?.name ?? "the host"} gets ${CONCHITAS.host} conchitas. ${passenger.name}'s ${CONCHITAS.guest}: ${row.hostConfirmedAt ? "earned (the host marked them as there)" : "count once the host marks them as there"}.`;
    }),
  });

  const my_conchitas = betaZodTool({
    name: "my_conchitas",
    description: "The current passenger's conchitas 🐚: balance, what earned them, what is still waiting for a confirmation, and what they still need to confirm or mark. Prizes are exchanged in person at the cruise store.",
    inputSchema: z.object({}),
    run: wrap("my_conchitas", async () => {
      const c = await chestFor(store, passenger, ctx.now);
      const line = (l: (typeof c.lines)[number]) =>
        `- ${l.role === "host" ? "hosted" : "went to"} [${l.activity.id}] ${l.activity.title}: ${l.amount} ${l.earned ? "earned" : l.role === "host" ? "(waiting for a guest to confirm)" : "(waiting for the host to mark them)"}`;
      return [
        `${passenger.name}: ${c.balance} conchitas.`,
        ...c.lines.slice(0, 12).map(line),
        c.toConfirm.length ? `Still to confirm they happened (confirm_event): ${c.toConfirm.map((a) => `[${a.id}] ${a.title}`).join("; ")}` : "",
        c.toMark.length ? `Still to say who came (mark_attendance): ${c.toMark.map((a) => `[${a.id}] ${a.title}`).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }),
  });

  const my_cabin_link = betaZodTool({
    name: "my_cabin_link",
    description: "The current passenger's private web page link (their 'camarote'): the full program by day, one-tap sign-ups, a sponsor form with flyers, their settings and a calendar link. Share it when they ask for the web, the app, the program as a page, or a link; it is personal, so never send one passenger's link to another.",
    inputSchema: z.object({}),
    run: wrap("my_cabin_link", async () => {
      if (!ctx.cabinLink) return "The web app is not running on this deployment; describe things in chat instead.";
      return `Private link for ${passenger.name}: ${ctx.cabinLink(passenger)} (paste it as is).`;
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

  // ----- admin (only for passengers who said the admin password) -----

  const byIdOrName = async (who: string): Promise<Person> => {
    const p = (await store.getPerson(who)) ?? (await store.findPersonByName(who));
    if (!p) throw new Error(`No passenger "${who}" on the manifest. Use admin_manifest for exact ids.`);
    return p;
  };

  const admin_manifest = betaZodTool({
    name: "admin_manifest",
    description: "ADMIN. Every passenger with id, channel, role, guardian, admin/muted flags, join date and how many activities they joined or host, plus whether the ship is paused.",
    inputSchema: z.object({}),
    run: wrap("admin_manifest", async () => {
      const people = await store.listPeople();
      const names = new Map(people.map((p) => [p.id, p.name]));
      const acts = await store.listActivities();
      const rows = await Promise.all(
        people.map(async (p) => {
          const going = (await store.listSignupsForPerson(p.id)).filter((s) => s.status !== "out").length;
          const hosts = acts.filter((a) => a.sponsorId === p.id).length;
          const channel = p.phoneE164?.startsWith("tg:") ? "telegram" : p.phoneE164 ? `whatsapp ${p.phoneE164}` : "no chat";
          const flags = [p.role, p.guardianId ? `guardian ${names.get(p.guardianId) ?? p.guardianId}` : "", p.admin ? "ADMIN" : "", p.muted ? "muted" : ""].filter(Boolean).join(", ");
          return `${p.name} (id ${p.id}) · ${channel} · ${flags} · joined ${p.joinedAt.slice(0, 10)} · signed up ${going} · hosts ${hosts}`;
        }),
      );
      return `${(await isPaused(store)) ? "SHIP PAUSED" : "Ship running"} · ${people.length} passengers\n${rows.join("\n")}`;
    }),
  });

  const admin_remove_passenger = betaZodTool({
    name: "admin_remove_passenger",
    description: "ADMIN. Take a passenger off the manifest with their sign-ups, memory and chat history (e.g. a test or fake passenger). Irreversible: call it only after the admin confirmed this exact person in this conversation. Fails while they host live activities.",
    inputSchema: z.object({ person: z.string().describe("Passenger id (preferred) or exact name") }),
    run: wrap("admin_remove_passenger", async ({ person }) => {
      const p = await byIdOrName(person);
      if (p.id === passenger.id) return "NOT ALLOWED: an admin cannot remove themselves.";
      await store.removePerson(p.id);
      return `Removed ${p.name} (id ${p.id}) from the manifest. If they write again they board as a new passenger.`;
    }),
  });

  const admin_set_role = betaZodTool({
    name: "admin_set_role",
    description: "ADMIN. Mark a passenger as a kid with the adult who receives their reminders (guardian), or back to adult. Kids get no late-night suggestions and their guardian can manage their activities.",
    inputSchema: z.object({
      person: z.string().describe("Passenger id or exact name"),
      role: z.enum(["adult", "kid"]),
      guardian: z.string().optional().describe("Required for kid: the guardian's id or exact name"),
    }),
    run: wrap("admin_set_role", async ({ person, role, guardian }) => {
      const p = await byIdOrName(person);
      if (role === "adult") {
        await store.updatePerson(p.id, { role: "adult", guardianId: null });
        return `${p.name} is now an adult passenger (no guardian).`;
      }
      if (!guardian) return "ERROR: a kid needs a guardian; ask who receives their reminders.";
      const g = await byIdOrName(guardian);
      if (g.id === p.id) return "ERROR: a kid cannot be their own guardian.";
      if (g.role === "kid") return `ERROR: ${g.name} is a kid; the guardian must be an adult.`;
      await store.updatePerson(p.id, { role: "kid", guardianId: g.id });
      return `${p.name} is now a kid; guardian: ${g.name}.`;
    }),
  });

  const admin_set_admin = betaZodTool({
    name: "admin_set_admin",
    description: "ADMIN. Give or take away admin access for a passenger (the password also grants it).",
    inputSchema: z.object({ person: z.string(), admin: z.boolean() }),
    run: wrap("admin_set_admin", async ({ person, admin }) => {
      const p = await byIdOrName(person);
      await store.updatePerson(p.id, { admin });
      return admin ? `${p.name} is now an admin.` : `${p.name} is no longer an admin.`;
    }),
  });

  const admin_pause = betaZodTool({
    name: "admin_pause",
    description: "ADMIN. The pause switch. Paused: no morning programs, reminders or nudges go out, and non-admin passengers get a short 'off duty' reply instead of the Capitán. Unpause to resume.",
    inputSchema: z.object({ paused: z.boolean() }),
    run: wrap("admin_pause", async ({ paused }) => {
      await store.setSetting("paused", paused);
      return paused ? "Ship PAUSED: nothing proactive goes out and passengers get an off-duty reply." : "Ship running again: schedule and replies resume.";
    }),
  });

  const admin = passenger.admin ? [admin_manifest, admin_remove_passenger, admin_set_role, admin_set_admin, admin_pause] : [];

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
    my_cabin_link,
    get_weather,
    mark_attendance,
    confirm_event,
    my_conchitas,
    ...admin,
  ];
}
