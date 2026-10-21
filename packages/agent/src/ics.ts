import type { Activity, Person, Store } from "@crucero/db";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** RFC 5545 line folding at 75 octets. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 73) {
      out.push(cur);
      cur = " " + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function activityToVEvent(a: Activity, host: Person | undefined, lang: "es" | "en", status: "going" | "maybe" | "host"): string {
  const summary = `${a.emoji} ${a.title}${status === "maybe" ? (lang === "es" ? " (tal vez)" : " (maybe)") : ""}`;
  const desc = [
    host ? (lang === "es" ? `Anfitrión: ${host.name}` : `Host: ${host.name}`) : "",
    a.description ?? "",
    a.bring ? (lang === "es" ? `Lleva: ${a.bring}` : `Bring: ${a.bring}`) : "",
    status === "host" ? (lang === "es" ? "Tú eres el anfitrión. 🫡" : "You are hosting. 🫡") : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [
    "BEGIN:VEVENT",
    `UID:${a.id}@crucero-luna-2026`,
    `DTSTAMP:${stamp(a.createdAt)}`,
    `DTSTART:${stamp(a.startsAt)}`,
    `DTEND:${stamp(a.endsAt)}`,
    `SUMMARY:${esc(summary)}`,
    `LOCATION:${esc(a.location)}`,
    desc ? `DESCRIPTION:${esc(desc)}` : "",
    `STATUS:${a.status === "cancelled" ? "CANCELLED" : status === "maybe" ? "TENTATIVE" : "CONFIRMED"}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(a.title)}`,
    "END:VALARM",
    "END:VEVENT",
  ]
    .filter(Boolean)
    .map(fold)
    .join("\r\n");
}

/** A passenger's personal calendar: what they host plus what they signed up for (going + maybe). */
export async function buildPersonalCalendar(store: Store, person: Person): Promise<string> {
  const signups = await store.listSignupsForPerson(person.id);
  const byActivity = new Map(signups.filter((s) => s.status !== "out").map((s) => [s.activityId, s.status]));
  const all = await store.listActivities({ status: ["published", "cancelled"] });
  const events: string[] = [];
  for (const a of all) {
    const isHost = a.sponsorId === person.id;
    const st = byActivity.get(a.id);
    if (!isHost && !st) continue;
    if (a.status === "cancelled" && !isHost && !st) continue;
    const host = await store.getPerson(a.sponsorId);
    events.push(activityToVEvent(a, host, person.language, isHost ? "host" : (st as "going" | "maybe")));
  }
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crucero Luna 2026//Capitan Lunaticus//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(person.language === "es" ? "Crucero Luna 2026 · Mi programa" : "Crucero Luna 2026 · My program")}`,
    "X-WR-TIMEZONE:America/Mexico_City",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
