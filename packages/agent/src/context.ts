import {
  type Activity,
  type Person,
  type Store,
  dayBounds,
  isPaused,
  prettyDate,
  prettyTime,
  shipDate,
  shipTime,
} from "@crucero/db";

export interface PassengerContext {
  person: Person;
  now: Date;
  text: string;
}

const HEADLINES: Record<string, string> = {
  "2026-12-26": "Embarkation Day: simulacro de abordaje y cóctel de bienvenida",
  "2026-12-28": "Día de los Inocentes: el Capitán tiene licencia para UNA broma (se revela antes del mediodía)",
  "2026-12-31": "Gala Night: disfraces, premios y cuenta regresiva en el Puente",
  "2027-01-01": "Día de recuperación: el Capitán habla bajito",
  "2027-01-02": "Desembarque: foto grupal y recuerdos del crucero",
};

export function headlineFor(date: string): string | undefined {
  return HEADLINES[date];
}

export async function describeActivity(store: Store, a: Activity, lang: "es" | "en"): Promise<string> {
  const sponsor = await store.getPerson(a.sponsorId);
  const signups = await store.listSignups(a.id);
  const going = signups.filter((s) => s.status === "going").length;
  const cap = a.capacity ? `${going}/${a.capacity}` : `${going}`;
  return `[${a.id}] ${a.emoji} ${a.title} · ${shipDate(a.startsAt)} ${prettyTime(a.startsAt, lang)}–${prettyTime(a.endsAt, lang)} · ${a.location} · host: ${sponsor?.name ?? a.sponsorId} · going: ${cap}${a.bring ? ` · bring: ${a.bring}` : ""}${a.status !== "published" ? ` · ${a.status.toUpperCase()}` : ""}`;
}

/**
 * The volatile, per-request context block. It goes after the cached persona prefix.
 */
export async function buildPassengerContext(store: Store, ctx: PassengerContext): Promise<string> {
  const { person, now } = ctx;
  const today = shipDate(now);
  const { from, to } = dayBounds(today);
  const todays = await store.listActivities({ from, to });
  const mine = new Set((await store.listSignupsForPerson(person.id)).filter((s) => s.status !== "out").map((s) => s.activityId));
  const memory = await store.getMemory(person.id);
  const guardian = person.guardianId ? await store.getPerson(person.guardianId) : undefined;
  const isNew = now.getTime() - new Date(person.joinedAt).getTime() < 24 * 3600 * 1000 && memory.length === 0;

  const lines: string[] = [
    `# Current passenger`,
    `Name: ${person.name}${person.nickname ? ` (${person.nickname})` : ""} · id: ${person.id} · language: ${person.language} · role: ${person.role}${guardian ? ` (guardian: ${guardian.name}, id ${guardian.id})` : ""} · humor: ${person.humor}${person.quietHours ? ` · quiet hours: ${person.quietHours.start}–${person.quietHours.end}` : ""}${person.muted ? " · MUTED (no proactive messages)" : ""}${person.admin ? ` · ADMIN (admin tools available)${(await isPaused(store)) ? " · SHIP IS PAUSED" : ""}` : ""}`,
    `Ship time now: ${prettyDate(today, person.language)} ${shipTime(now)} (${today})`,
    headlineFor(today) ? `Today's headline: ${headlineFor(today)}` : "",
    isNew
      ? `\n# Onboarding\nThis passenger just boarded (their name came from their chat profile and may be wrong). In ONE short message: welcome them aboard, confirm what to call them, ask Spanish or English, and mention they can sponsor an activity or sign up for one, and that their personal web page (my_cabin_link) has the whole program. Use set_preferences/remember for what they answer. Do not list the whole program yet.`
      : "",
    "",
    `# Today's program (${todays.length} activities; ★ = this passenger is signed up or hosting)`,
    ...(await Promise.all(todays.map(async (a) => `${mine.has(a.id) || a.sponsorId === person.id ? "★ " : "  "}${await describeActivity(store, a, person.language)}`))),
    "",
    memory.length ? `# What you remember about ${person.name.split(" ")[0]}` : "",
    ...memory.map((m) => `- ${m.key}: ${m.value}`),
  ];
  return lines.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");
}
