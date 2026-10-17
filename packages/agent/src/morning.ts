import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { type Activity, type Person, type Store, dayBounds, prettyDate, prettyTime, shipDate } from "@crucero/db";
import { z } from "zod";
import { describeActivity, headlineFor } from "./context.js";
import { PERSONA } from "./persona.js";
import { suggestActivities } from "./tools.js";

/** Deterministic facts for one passenger's morning. No model involved; fully testable. */
export interface MorningBrief {
  person: Person;
  date: string;
  headline?: string;
  mine: Activity[];
  suggestions: Activity[];
  /** True on Jan 1: the Capitán whispers and the message goes out late. */
  softMode: boolean;
}

export async function buildMorningBrief(store: Store, person: Person, date: string, now = new Date()): Promise<MorningBrief> {
  const { from, to } = dayBounds(date);
  const all = await store.listActivities({ from, to });
  const ids = new Set((await store.listSignupsForPerson(person.id)).filter((s) => s.status !== "out").map((s) => s.activityId));
  const mine = all.filter((a) => ids.has(a.id) || a.sponsorId === person.id);
  const suggestions = mine.length <= 1
    ? await suggestActivities({ store, passenger: person, now, outbox: { send: async () => {} } }, person, date, 3)
    : [];
  return { person, date, headline: headlineFor(date), mine, suggestions, softMode: date.endsWith("-01-01") };
}

export const MorningMessage = z.object({
  /** For the WhatsApp template variable: one compact line, no line breaks, <= 60 chars. */
  knock_headline: z.string().max(60),
  /** The full free-form morning message sent once the 24h window is open. */
  full_message: z.string().min(20).max(1200),
  /** Ids the message offered for one-tap sign-up, in order. */
  offered_activity_ids: z.array(z.string()).max(3),
});
export type MorningMessage = z.infer<typeof MorningMessage>;

/**
 * Ask the Capitán to write one passenger's morning program from the brief.
 * Uses structured output so the template variable and the button payloads are machine-safe.
 */
export async function writeMorningMessage(
  client: Anthropic,
  store: Store,
  brief: MorningBrief,
  opts: { model?: string } = {},
): Promise<MorningMessage> {
  const lang = brief.person.language;
  const mine = await Promise.all(brief.mine.map((a) => describeActivity(store, a, lang)));
  const sugg = await Promise.all(brief.suggestions.map((a) => describeActivity(store, a, lang)));
  const memory = await store.getMemory(brief.person.id);
  const first = brief.person.name.split(" ")[0];

  const facts = [
    `Passenger: ${brief.person.name} (call them ${first}) · language: ${lang} · humor: ${brief.person.humor} · role: ${brief.person.role}`,
    `Date: ${prettyDate(brief.date, lang)} (${brief.date})${brief.headline ? ` · headline: ${brief.headline}` : ""}`,
    brief.softMode ? "SOFT MODE: it is Jan 1. Whisper. No ding-dong. Short." : "",
    `Their activities today (${brief.mine.length}):`,
    ...(mine.length ? mine.map((m) => `  ${m}`) : ["  (none)"]),
    brief.suggestions.length ? `Offer these (their day is light), in this order, each on its own line with its id in brackets so a button can be attached:` : "",
    ...sugg.map((s) => `  ${s}`),
    memory.length ? `You remember: ${memory.map((m) => `${m.key}: ${m.value}`).join("; ")}` : "",
    `Write the morning program message in ${lang === "es" ? "Spanish" : "English"}. Use the morning-program shape. Times like "${prettyTime(brief.mine[0]?.startsAt ?? new Date(), lang)}".`,
    `knock_headline is for a WhatsApp template variable: one line, no emoji at the start, <= 60 characters, summarizing the day.`,
  ].filter(Boolean).join("\n");

  const res = await client.messages.parse({
    model: opts.model ?? process.env.DIRECTOR_MODEL ?? "claude-opus-5-5",
    max_tokens: 2048,
    system: [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: zodOutputFormat(MorningMessage) },
    messages: [{ role: "user", content: facts }],
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    // Deterministic fallback so nobody's morning is silent.
    const lines = brief.mine.map((a) => `• ${a.emoji} ${a.title} · ${prettyTime(a.startsAt, lang)} · ${a.location}`);
    return {
      knock_headline: brief.headline?.slice(0, 60) ?? `Programa del ${shipDate(brief.date)}`,
      full_message: [`🚢 Buenos días, ${first}.`, ...lines, brief.suggestions.length ? "Tu camastro se ve solitario; elige una:" : "", ...brief.suggestions.map((a) => `[${a.id}] ${a.emoji} ${a.title} · ${prettyTime(a.startsAt, lang)}`)].filter(Boolean).join("\n"),
      offered_activity_ids: brief.suggestions.map((a) => a.id),
    };
  }
  return res.parsed_output;
}
