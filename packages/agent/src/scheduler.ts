import { CONCHITAS } from "./conchitas.js";
import { type Activity, type Person, type Store, inQuietHours, isPaused, prettyTime, shipDate, shipTime } from "@crucero/db";
import { buildMorningBrief, type MorningMessage } from "./morning.js";
import type { Outbox } from "./tools.js";

export type TemplateKind = "morning_knock" | "activity_reminder" | "new_activity";

/** Outbox that can also send a WhatsApp template (needed outside the 24-hour window). */
export interface TemplateOutbox extends Outbox {
  sendTemplate?(to: Person, kind: TemplateKind, variables: Record<string, string>): Promise<void>;
  /** Quick-reply buttons (max 3) under a short body; only valid inside an open 24h window. */
  sendInteractive?(to: Person, body: string, buttons: { id: string; title: string }[]): Promise<void>;
  /** False for passengers this channel cannot message (e.g. WhatsApp-boarded ones on Telegram); skips paid work. */
  canReach?(to: Person): boolean;
}

/** Payload parked behind the morning template knock. */
export interface MorningPayloadData {
  full_message: string;
  offered_activity_ids: string[];
}

/** Button id prefix for one-tap sign-ups offered in the morning message. */
export const SIGNUP_BUTTON_PREFIX = "signup:";

/**
 * Send the full morning show: the message, then (when the channel supports it) one-tap
 * sign-up buttons for the activities it offered.
 */
export async function deliverMorningFull(store: Store, outbox: TemplateOutbox, person: Person, payload: MorningPayloadData): Promise<void> {
  await outbox.send(person, payload.full_message, { from: person });
  if (outbox.sendInteractive && payload.offered_activity_ids.length) {
    const acts = (await Promise.all(payload.offered_activity_ids.slice(0, 3).map((id) => store.getActivity(id)))).filter((a): a is Activity => !!a && a.status === "published");
    if (acts.length) {
      await outbox.sendInteractive(
        person,
        person.language === "es" ? "¿Te apunto a alguna?" : "Want me to sign you up?",
        acts.map((a) => ({ id: `${SIGNUP_BUTTON_PREFIX}${a.id}`, title: `${a.emoji} ${a.title}` })),
      );
    }
  }
}

export interface SchedulerDeps {
  store: Store;
  outbox: TemplateOutbox;
  /** Writes the morning message for a brief; the model-backed `writeMorningMessage` in production. */
  writeMorning: (person: Person, date: string, now: Date) => Promise<MorningMessage>;
  /** When true, the morning goes out as a template knock and the full show waits for a tap. */
  useTemplates: boolean;
  /** A passenger's own web page for a path (e.g. "/a/a04"), linked from the post-activity conchitas question. */
  pageLink?: (person: Person, path: string) => string;
  log?: (line: string) => void;
}

export interface TickReport {
  mornings: string[];
  reminders: string[];
  sponsorNudges: string[];
  /** Post-activity conchitas questions, "<activity>:<person>". */
  attendanceAsks: string[];
  errors: string[];
}

const WINKS_ES = [
  "El Capitán ya está en posición.",
  "Puntualidad naval, por favor.",
  "El Departamento de Entretenimiento no logró nada así.",
  "Se recomienda llegar con actitud.",
  "La luna lo aprueba.",
];
const WINKS_EN = [
  "The Capitán is already in position.",
  "Naval punctuality, please.",
  "The Entertainment Department could never.",
  "Arrive with attitude.",
  "The moon approves.",
];

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function reminderText(a: Activity, host: Person | undefined, person: Person, minutes: number): string {
  const lang = person.language;
  const time = prettyTime(a.startsAt, lang);
  const hostName = host?.name.split(" ")[0] ?? "";
  const base =
    lang === "es"
      ? `⏰ En ${minutes} min: ${a.emoji} ${a.title}${hostName ? ` con ${hostName}` : ""} · ${time} · ${a.location}.${a.bring ? ` Lleva: ${a.bring}.` : ""}`
      : `⏰ In ${minutes} min: ${a.emoji} ${a.title}${hostName ? ` with ${hostName}` : ""} · ${time} · ${a.location}.${a.bring ? ` Bring: ${a.bring}.` : ""}`;
  if (person.humor === "off") return base;
  const winks = lang === "es" ? WINKS_ES : WINKS_EN;
  return `${base} ${winks[hash(a.id + person.id) % winks.length]}`;
}

export function sponsorNudgeText(a: Activity, sponsor: Person, going: number): string {
  const time = prettyTime(a.startsAt, sponsor.language);
  return sponsor.language === "es"
    ? `🫡 Capitán a ${sponsor.name.split(" ")[0]}: en una hora es tu ${a.emoji} ${a.title} (${time}, ${a.location}). ${going} pasajero${going === 1 ? "" : "s"} cuenta${going === 1 ? "" : "n"} contigo. ¿Todo listo?`
    : `🫡 Capitán to ${sponsor.name.split(" ")[0]}: your ${a.emoji} ${a.title} is in one hour (${time}, ${a.location}). ${going} passenger${going === 1 ? "" : "s"} ${going === 1 ? "is" : "are"} counting on you. All set?`;
}

/** After an activity: the host is asked who came, each guest whether it happened (conchitas 🐚). */
export function attendanceAskText(a: Activity, to: Person, host: Person | undefined, asHost: boolean, link?: string): string {
  const es = to.language === "es";
  const what = `${a.emoji} ${a.title}`;
  const text = asHost
    ? es
      ? `🐚 ¿Quién vino a ${what}? Respóndeme con los nombres (o márcalos en tu camarote) y cada uno gana ${CONCHITAS.guest} conchitas.`
      : `🐚 Who came to ${what}? Reply with their names (or tick them in your cabin) and each one earns ${CONCHITAS.guest} sand dollars.`
    : es
      ? `🐚 ¿Se hizo ${what}? Respóndeme «sí» (o toca ✓ en tu camarote) y ${host?.name.split(" ")[0] ?? "el anfitrión"} gana ${CONCHITAS.host} conchitas.`
      : `🐚 Did ${what} happen? Reply "yes" (or tap ✓ in your cabin) and ${host?.name.split(" ")[0] ?? "the host"} earns ${CONCHITAS.host} sand dollars.`;
  return link ? `${text}\n${link}` : text;
}

/** Earliest ship-local time a person's morning may go out on a date. */
export function morningWindowStart(person: Person, date: string): string {
  const soft = date.endsWith("-01-01");
  return soft && person.wakeTime < "10:00" ? "10:00" : person.wakeTime;
}

/**
 * One scheduler pass. Idempotent: safe to run every minute, safe to re-run after a crash.
 * Pure with respect to its deps, so tests drive it with a fake clock and a fake outbox.
 */
export async function tick(deps: SchedulerDeps, now: Date): Promise<TickReport> {
  const { store, outbox, log = () => {} } = deps;
  const report: TickReport = { mornings: [], reminders: [], sponsorNudges: [], attendanceAsks: [], errors: [] };
  if (await isPaused(store)) return report; // admin pause switch: nothing proactive goes out
  const today = shipDate(now);
  const nowHM = shipTime(now);
  const people = await store.listPeople();
  const byId = new Map(people.map((p) => [p.id, p]));

  // 1. Morning program: from wake time until 3 hours later, once per person per day.
  for (const person of people) {
    const start = morningWindowStart(person, today);
    const [h, m] = start.split(":").map(Number);
    const endMinutes = h * 60 + m + 180;
    const nowMinutes = Number(nowHM.slice(0, 2)) * 60 + Number(nowHM.slice(3, 5));
    if (nowHM < start || nowMinutes > endMinutes) continue;
    const key = `${person.id}:${today}`;
    if (await store.wasDelivered("morning", key)) continue;
    if (person.muted) continue;
    if (outbox.canReach && !outbox.canReach(person)) continue; // don't pay for a morning show nobody can receive
    if (person.role === "kid" && !person.phoneE164) continue; // kids without a phone get theirs via the guardian's message
    try {
      const msg = await deps.writeMorning(person, today, now);
      const brief = await buildMorningBrief(store, person, today, now);
      if (deps.useTemplates && outbox.sendTemplate) {
        await outbox.sendTemplate(person, "morning_knock", {
          "1": person.name.split(" ")[0],
          "2": msg.knock_headline,
          "3": String(brief.mine.length),
        });
        await store.markDelivered("morning", key, { full_message: msg.full_message, offered_activity_ids: msg.offered_activity_ids });
      } else {
        await deliverMorningFull(store, outbox, person, { full_message: msg.full_message, offered_activity_ids: msg.offered_activity_ids });
        await store.markDelivered("morning", key, { full_message: msg.full_message, offered_activity_ids: msg.offered_activity_ids });
        await store.markDelivered("morning_full", key);
      }
      report.mornings.push(person.id);
      log(`morning → ${person.name}`);
    } catch (err) {
      report.errors.push(`morning ${person.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Reminders: T-30 for going/maybe, once, outside quiet hours. Kids' reminders also go to the guardian.
  const soon = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const upcoming = await store.listActivities({ from: now.toISOString(), to: soon });
  for (const a of upcoming) {
    const host = byId.get(a.sponsorId);
    for (const s of await store.listSignups(a.id)) {
      if (s.status === "out" || s.remindedAt) continue;
      const person = byId.get(s.personId);
      if (!person || inQuietHours(now, person.quietHours)) continue;
      const minutes = Math.max(1, Math.round((new Date(a.startsAt).getTime() - now.getTime()) / 60000));
      try {
        const text = reminderText(a, host, person, minutes);
        if (person.phoneE164 && !person.muted) await outbox.send(person, text, { from: person });
        const guardian = person.guardianId ? byId.get(person.guardianId) : undefined;
        if (guardian && !guardian.muted && !inQuietHours(now, guardian.quietHours)) {
          await outbox.send(guardian, `${guardian.language === "es" ? "Para" : "For"} ${person.name.split(" ")[0]}: ${reminderText(a, host, guardian, minutes)}`, { from: person });
        }
        await store.markReminded(a.id, person.id, now.toISOString());
        report.reminders.push(`${a.id}:${person.id}`);
      } catch (err) {
        report.errors.push(`reminder ${a.id}:${person.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. Sponsor nudge: T-60, once per activity.
  const hour = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const inAnHour = (await store.listActivities({ from: new Date(now.getTime() + 45 * 60 * 1000).toISOString(), to: hour }));
  for (const a of inAnHour) {
    if (await store.wasDelivered("sponsor_nudge", a.id)) continue;
    const sponsor = byId.get(a.sponsorId);
    if (!sponsor || !sponsor.phoneE164 || sponsor.muted) continue;
    const going = (await store.listSignups(a.id)).filter((s) => s.status === "going" && s.personId !== sponsor.id).length;
    try {
      await outbox.send(sponsor, sponsorNudgeText(a, sponsor, going), { from: sponsor });
      await store.markDelivered("sponsor_nudge", a.id);
      report.sponsorNudges.push(a.id);
    } catch (err) {
      report.errors.push(`nudge ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Conchitas: from 15 minutes after an activity ends (up to 12 hours), ask the host who came and each guest
  // whether it happened. Once per person per activity; quiet hours wait; people who already answered are skipped.
  const after = now.getTime() - 15 * 60 * 1000;
  const until = now.getTime() - 12 * 3600 * 1000;
  const ended = (await store.listActivities({ from: new Date(until - 24 * 3600 * 1000).toISOString(), to: now.toISOString() })).filter(
    (a) => Date.parse(a.endsAt) <= after && Date.parse(a.endsAt) > until,
  );
  for (const a of ended) {
    const host = byId.get(a.sponsorId);
    const rows = await store.listAttendance(a.id);
    const guests = (await store.listSignups(a.id)).filter((s) => s.status !== "out" && s.personId !== a.sponsorId);
    if (!guests.length) continue;
    const asks: { person: Person; asHost: boolean }[] = [];
    if (host && !rows.some((r) => r.hostConfirmedAt)) asks.push({ person: host, asHost: true });
    for (const g of guests) {
      const p = byId.get(g.personId);
      if (p && !rows.some((r) => r.personId === p.id && r.guestConfirmedAt)) asks.push({ person: p, asHost: false });
    }
    for (const { person, asHost } of asks) {
      const key = `${a.id}:${person.id}`;
      if (!person.phoneE164 || person.muted || inQuietHours(now, person.quietHours)) continue;
      if (outbox.canReach && !outbox.canReach(person)) continue;
      if (await store.wasDelivered("attendance_ask", key)) continue;
      try {
        await outbox.send(person, attendanceAskText(a, person, host, asHost, deps.pageLink?.(person, `/a/${a.id}`)), { from: person });
        await store.markDelivered("attendance_ask", key);
        report.attendanceAsks.push(key);
      } catch (err) {
        report.errors.push(`attendance ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return report;
}
