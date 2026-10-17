/**
 * Generate the morning program for every passenger (or one) on a ship date.
 *
 *   pnpm morning --date 2026-12-28
 *   pnpm morning --date 2027-01-01 --as carmen
 *   pnpm morning --date 2026-12-27 --dry    # briefs only, no model call
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildMorningBrief, writeMorningMessage } from "@crucero/agent";
import { mx, prettyTime } from "@crucero/db";
import { openStore, parseArgs } from "./shared.js";

const args = parseArgs(process.argv.slice(2));
const date = typeof args.date === "string" ? args.date : "2026-12-27";
const store = openStore({ now: () => new Date(mx(date, "07:00")) });
const people = await store.listPeople();
const targets = typeof args.as === "string" ? people.filter((p) => p.id === args.as) : people;
const client = args.dry ? undefined : new Anthropic();

for (const person of targets) {
  const brief = await buildMorningBrief(store, person, date, new Date(mx(date, person.wakeTime)));
  console.log(`\n━━━ ${person.name} · ${date} · wake ${person.wakeTime}${brief.softMode ? " · SOFT MODE" : ""} ━━━`);
  console.log(`   mine: ${brief.mine.map((a) => `${a.emoji} ${a.title} ${prettyTime(a.startsAt)}`).join(" | ") || "(empty day)"}`);
  if (brief.suggestions.length) console.log(`   offer: ${brief.suggestions.map((a) => `[${a.id}] ${a.title}`).join(" | ")}`);
  if (!client) continue;
  const msg = await writeMorningMessage(client, store, brief);
  console.log(`\n   📋 template knock: "${msg.knock_headline}"`);
  console.log(`   💬 full message:\n${msg.full_message.split("\n").map((l) => `      ${l}`).join("\n")}`);
  if (msg.offered_activity_ids.length) console.log(`   🔘 buttons: ${msg.offered_activity_ids.join(", ")}`);
}
