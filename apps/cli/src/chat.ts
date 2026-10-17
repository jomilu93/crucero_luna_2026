/**
 * Chat with Capitán Lunático from the terminal, as any passenger, at any ship time.
 *
 *   pnpm chat                                  # as the first passenger, now
 *   pnpm chat --as sofia --at 2026-12-28T13:00  # as Sofía, on Inocentes at 7:00 am ship time
 *
 * `--at` is a UTC instant; ship time is UTC-6. Type /who to switch passenger, /tools to toggle
 * the tool trace, /reset to clear the conversation, /quit to leave.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Director } from "@crucero/agent";
import { consoleOutbox, describePerson, openStore, parseArgs } from "./shared.js";

const args = parseArgs(process.argv.slice(2));
const fixedNow = typeof args.at === "string" ? new Date(args.at.length === 16 ? `${args.at}:00Z` : args.at) : undefined;
if (fixedNow && Number.isNaN(fixedNow.getTime())) throw new Error(`bad --at: ${args.at}`);
const now = fixedNow ? () => fixedNow : () => new Date();

const store = openStore({ now });
const people = await store.listPeople();
let passenger = (typeof args.as === "string" ? (await store.getPerson(args.as)) ?? (await store.findPersonByName(args.as)) : undefined) ?? people[0];
if (!passenger) throw new Error("No passengers on the manifest.");

const director = new Director(store, { outbox: consoleOutbox, now });
let history: BetaMessageParam[] = [];
let trace = Boolean(args.trace);

console.log(`🚢 Crucero Luna 2026 · Capitán Lunático (${director.model}, effort ${director.effort})`);
console.log(`   Passenger: ${describePerson(passenger)} · ship time ${now().toISOString()}`);
console.log(`   Commands: /who <name|id> · /tools · /reset · /program · /quit\n`);

const rl = createInterface({ input: stdin, output: stdout });
rl.on("close", () => process.exit(0));
for (;;) {
  const line = (await rl.question(`${passenger.name.split(" ")[0]} › `)).trim();
  if (!line) continue;
  if (line === "/quit" || line === "/exit") break;
  if (line === "/tools") {
    trace = !trace;
    console.log(`   tool trace ${trace ? "on" : "off"}`);
    continue;
  }
  if (line === "/reset") {
    history = [];
    console.log("   conversation cleared");
    continue;
  }
  if (line.startsWith("/who")) {
    const q = line.slice(4).trim();
    const p = q ? (await store.getPerson(q)) ?? (await store.findPersonByName(q)) : undefined;
    if (!p) {
      console.log(`   passengers: ${people.map((x) => x.id).join(", ")}`);
      continue;
    }
    passenger = p;
    history = [];
    console.log(`   now chatting as ${describePerson(passenger)}`);
    continue;
  }
  if (line.startsWith("/program")) {
    const sys = await director.systemFor(passenger, "", now());
    console.log(sys[1].text);
    continue;
  }
  try {
    const turn = await director.respond(passenger, line, history);
    history = turn.history;
    if (trace) for (const t of turn.toolCalls) console.log(`   🔧 ${t.name} ${JSON.stringify(t.input)}\n      ↳ ${t.output.slice(0, 200)}`);
    console.log(`\n🧭 ${turn.text}\n`);
    if (trace) console.log(`   usage: in ${turn.usage.input_tokens} (cache read ${turn.usage.cache_read_input_tokens ?? 0}) · out ${turn.usage.output_tokens} · stop ${turn.stopReason}`);
  } catch (err) {
    console.error(`   ⚠️  ${err instanceof Error ? err.message : err}`);
  }
}
rl.close();
