import type { MemoryStore } from "./memory-store.js";
import { mx } from "./time.js";
import type { Activity, Person } from "./types.js";

export const CRUISE_START = "2026-12-26";
export const CRUISE_END = "2027-01-02";

/**
 * A sample roster and program for development. Names are placeholders;
 * the real roster is created through onboarding.
 */
export function seedSample(store: MemoryStore): { people: Person[]; activities: Activity[] } {
  const t = "2026-11-15T15:00:00.000Z";
  const mk = (id: string, name: string, extra: Partial<Person> = {}): Person => ({
    id,
    name,
    language: "es",
    role: "adult",
    humor: "full",
    wakeTime: "07:30",
    icsToken: `tok_${id}`,
    joinedAt: t,
    ...extra,
  });
  const people: Person[] = [
    mk("sofia", "Sofía Luna", { phoneE164: "+15550000001", wakeTime: "06:30" }),
    mk("diego", "Diego Luna", { phoneE164: "+15550000002", language: "en" }),
    mk("carmen", "Abuela Carmen", { phoneE164: "+525550000003", humor: "light", quietHours: { start: "21:00", end: "08:30" } }),
    mk("mateo", "Mateo Luna", { role: "kid", guardianId: "diego" }),
    mk("valeria", "Valeria Luna", { phoneE164: "+15550000005" }),
    mk("ricardo", "Tío Ricardo", { phoneE164: "+525550000006" }),
  ];

  let n = 0;
  const act = (
    date: string,
    start: string,
    end: string,
    title: string,
    emoji: string,
    sponsorId: string,
    location: string,
    extra: Partial<Activity> = {},
  ): Activity => ({
    id: `a${String(++n).padStart(2, "0")}`,
    title,
    emoji,
    sponsorId,
    startsAt: mx(date, start),
    endsAt: mx(date, end),
    location,
    status: "published",
    createdVia: "web",
    createdAt: t,
    ...extra,
  });

  const activities: Activity[] = [
    act("2026-12-26", "17:00", "17:30", "Simulacro de abordaje (tour del barco)", "🛟", "diego", "Lobby → Lido Deck (balcón)", {
      description: "Safety briefing a la Capitán: dónde está el agua, dónde está el café, dónde NO se cuelga la toalla.",
    }),
    act("2026-12-26", "19:00", "21:00", "Cóctel de bienvenida", "🍹", "valeria", "Lido Deck (balcón)", { bring: "Tu mejor historia del año" }),
    act("2026-12-27", "07:00", "07:45", "Sunrise yoga con Sofía", "🧘", "sofia", "Lido Deck (balcón)", { bring: "Toalla o tapete", capacity: 8 }),
    act("2026-12-27", "20:00", "21:30", "Bingo Lunático", "🎱", "ricardo", "Comedor (Gran Salón)", { bring: "Monedas de 10 pesos", capacity: 20 }),
    act("2026-12-28", "07:00", "07:45", "Sunrise yoga con Sofía", "🧘", "sofia", "Lido Deck (balcón)", { bring: "Toalla o tapete", capacity: 8 }),
    act("2026-12-29", "07:00", "07:45", "Sunrise yoga con Sofía", "🧘", "sofia", "Lido Deck (balcón)", { bring: "Toalla o tapete", capacity: 8 }),
    act("2026-12-29", "16:00", "18:00", "Voleibol de playa", "🏐", "diego", "Playa Condesa", { bring: "Bloqueador y sed de victoria", capacity: 12 }),
    act("2026-12-30", "10:00", "13:00", "Excursión: La Quebrada (clavadistas)", "🤿", "ricardo", "Shore leave · La Quebrada", { capacity: 10 }),
    act("2026-12-30", "21:00", "23:00", "Karaoke de camarote", "🎤", "valeria", "Gran Salón", { bring: "Cero vergüenza" }),
    act("2026-12-31", "07:00", "07:45", "Sunrise yoga con Sofía", "🧘", "sofia", "Lido Deck (balcón)", { bring: "Toalla o tapete", capacity: 8 }),
    act("2026-12-31", "20:00", "23:30", "Cena de gala con disfraces", "🎭", "carmen", "Gran Salón", { bring: "Disfraz. Sí, tú también." }),
    act("2026-12-31", "23:30", "00:30", "Cuenta regresiva en el Puente", "🎆", "diego", "El Puente (sala / TV)", { bring: "12 uvas" }),
    act("2027-01-01", "12:00", "14:00", "Brunch de recuperación", "🥞", "valeria", "Galley (cocina) → Lido Deck", { description: "Hora humana. El Capitán hablará bajito." }),
    act("2027-01-02", "10:00", "10:30", "Foto grupal de desembarque", "📸", "sofia", "Lido Deck (balcón)"),
  ];
  // Jan 1 countdown ends after midnight: fix endsAt to the next day.
  const countdown = activities.find((a) => a.title.startsWith("Cuenta regresiva"))!;
  countdown.endsAt = mx("2027-01-01", "00:30");

  const signups = [
    { activityId: "a03", personId: "diego", status: "going" as const, createdAt: t },
    { activityId: "a03", personId: "valeria", status: "going" as const, createdAt: t },
    { activityId: "a04", personId: "carmen", status: "going" as const, createdAt: t },
    { activityId: "a04", personId: "mateo", status: "going" as const, createdAt: t },
    { activityId: "a11", personId: "sofia", status: "going" as const, createdAt: t },
    { activityId: "a11", personId: "diego", status: "going" as const, createdAt: t },
    { activityId: "a11", personId: "valeria", status: "maybe" as const, createdAt: t },
  ];
  const memory = [
    { personId: "carmen", key: "early_mornings", value: "No es madrugadora; nada antes de las 9.", updatedAt: t },
    { personId: "diego", key: "competitive", value: "Hyper-competitive at anything with a score.", updatedAt: t },
    { personId: "valeria", key: "diet", value: "Vegetariana.", updatedAt: t },
  ];

  store.load({ people, activities, signups, memory, messages: [] });
  return { people, activities };
}
