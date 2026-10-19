/**
 * Ship's clock helpers. Acapulco (Guerrero) and Mexico City have had no daylight saving
 * time since 2022, so the zone is a fixed UTC-6. We still format through Intl with the
 * IANA zone so a future rule change only needs the offset constant revisited.
 */
export const SHIP_TZ = "America/Mexico_City";
const OFFSET = "-06:00";

/** Build a UTC instant from a ship-local date and time: mx("2026-12-31", "20:00"). */
export function mx(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad date: ${date}`);
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`bad time: ${time}`);
  return new Date(`${date}T${time}:00${OFFSET}`).toISOString();
}

/** Ship-local calendar date ("YYYY-MM-DD") of an instant. */
export function shipDate(instant: string | Date): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHIP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Ship-local "HH:MM" of an instant. */
export function shipTime(instant: string | Date): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: SHIP_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** Human time like "7:00 am" in ship-local time, for messages. */
export function prettyTime(instant: string | Date, lang: "es" | "en" = "es"): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: SHIP_TZ,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return lang === "es" ? s.toLowerCase().replace(" ", " ") : s;
}

/** Weekday + day in ship-local time, in the passenger's language. */
export function prettyDate(date: string, lang: "es" | "en" = "es"): string {
  const d = new Date(`${date}T12:00:00${OFFSET}`);
  return new Intl.DateTimeFormat(lang === "es" ? "es-MX" : "en-US", {
    timeZone: SHIP_TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
}

/** [start, end) UTC bounds of a ship-local calendar day. */
export function dayBounds(date: string): { from: string; to: string } {
  const from = mx(date, "00:00");
  const to = new Date(new Date(from).getTime() + 24 * 3600 * 1000).toISOString();
  return { from, to };
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00${OFFSET}`);
  d.setUTCDate(d.getUTCDate() + n);
  return shipDate(d);
}

/** Is the ship-local wall clock inside quiet hours like { start: "22:00", end: "08:00" }? */
export function inQuietHours(instant: string | Date, quiet?: { start: string; end: string }): boolean {
  if (!quiet) return false;
  const t = shipTime(instant);
  return quiet.start <= quiet.end ? t >= quiet.start && t < quiet.end : t >= quiet.start || t < quiet.end;
}
