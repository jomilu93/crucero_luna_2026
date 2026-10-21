/**
 * Behavioral eval for Capitán Lunáticus: tool calls, language, and a few content checks.
 *
 *   pnpm eval                       # all cases
 *   pnpm eval --only signup-by-name # one case
 *   pnpm eval --judge               # also ask Haiku to grade tone against the persona rules
 *
 * Results land in evals/results/<timestamp>.json. Requires ANTHROPIC_API_KEY.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { Director, PERSONA, TV_ADDRESS, type Outbox, type ToolCallRecord } from "@crucero/agent";
import { MemoryStore, seedSample } from "@crucero/db";

const here = dirname(fileURLToPath(import.meta.url));

interface ToolExpectation { name: string; args?: Record<string, unknown> }
interface Case {
  id: string;
  /** A seed passenger id; "tv" = the shared TV seat on the Bridge; "new" = a passenger who just boarded. */
  as: string;
  at: string;
  say: string;
  /** "voice" simulates a live video call (spoken replies). */
  channel?: "voice";
  /** Earlier turns of the same conversation, said first with history carried over; checks apply to `say`. */
  before?: string[];
  setup?: {
    fill_activity?: string;
    /** The passenger said the admin password. */
    admin?: boolean;
    /** Extra passengers on the manifest, e.g. a test number to remove. */
    add_passengers?: { name: string; phone: string }[];
  };
  expect_tools?: ToolExpectation[];
  expect_tools_any?: string[];
  forbid_tools?: string[];
  reply_lang?: "es" | "en";
  reply_should_ask?: boolean;
  reply_must_mention_any?: string[];
  reply_must_not_mention_any?: string[];
  reply_max_chars?: number;
  /** Spoken replies: no emoji, no links. */
  reply_speakable?: boolean;
}

const { cases } = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")) as { cases: Case[] };
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const judge = argv.includes("--judge");
const client = new Anthropic();

const ES_HINTS = /\b(el|la|los|las|hoy|mañana|qué|está|para|con|buenos|días|apunt|camastro|pasajer)\b|[¿¡áéíóúñ]/i;
const EN_HINTS = /\b(the|you|your|today|tomorrow|what|is|are|sign|deck|passenger|morning)\b/i;
function detectLang(text: string): "es" | "en" | "mixed" {
  const es = (text.match(new RegExp(ES_HINTS.source, "gi")) ?? []).length;
  const en = (text.match(new RegExp(EN_HINTS.source, "gi")) ?? []).length;
  if (es > en * 1.5) return "es";
  if (en > es * 1.5) return "en";
  return "mixed";
}

const subset = (expected: Record<string, unknown>, actual: unknown): boolean => {
  if (typeof actual !== "object" || actual === null) return false;
  return Object.entries(expected).every(([k, v]) => {
    const a = (actual as Record<string, unknown>)[k];
    return typeof v === "string" && typeof a === "string" ? a.toLowerCase().includes(v.toLowerCase()) : JSON.stringify(a) === JSON.stringify(v);
  });
};

const Verdict = z.object({ in_character: z.boolean(), useful_first: z.boolean(), humor_rules_ok: z.boolean(), notes: z.string().describe("One or two short sentences") });

async function runCase(c: Case) {
  const now = new Date(c.at);
  const store = new MemoryStore({ now: () => now });
  seedSample(store);
  if (c.setup?.fill_activity) {
    const a = (await store.getActivity(c.setup.fill_activity))!;
    const people = await store.listPeople();
    const fillers = people.filter((p) => p.id !== c.as).slice(0, a.capacity ?? 8);
    for (const p of fillers) await store.setSignup(a.id, p.id, "going");
    // The seed has fewer passengers than most capacities, so shrink the cap to make it truly full.
    const going = (await store.listSignups(a.id)).filter((s) => s.status === "going").length;
    await store.updateActivity(a.id, { capacity: going });
  }
  for (const p of c.setup?.add_passengers ?? []) await store.createPerson({ name: p.name, phoneE164: p.phone, language: "es", role: "adult" });
  if (c.as === "tv") await store.createPerson({ name: "Puente (TV)", phoneE164: TV_ADDRESS, language: "es", role: "adult", muted: true });
  if (c.as === "new") await store.createPerson({ name: "Lupita", phoneE164: "tg:4242", language: "es", role: "adult" });
  const sent: { to: string; text: string }[] = [];
  const outbox: Outbox = { send: async (to, text) => void sent.push({ to: to === "everyone" ? "everyone" : to.name, text }) };
  const director = new Director(store, { outbox, now: () => now });
  let passenger = c.as === "tv" ? (await store.findPersonByPhone(TV_ADDRESS))! : c.as === "new" ? (await store.findPersonByPhone("tg:4242"))! : (await store.getPerson(c.as))!;
  if (c.setup?.admin) passenger = await store.updatePerson(passenger.id, { admin: true });
  let history: Awaited<ReturnType<typeof director.respond>>["history"] = [];
  const earlier: string[] = [];
  for (const b of c.before ?? []) {
    const t = await director.respond(passenger, b, history, { channel: c.channel });
    history = t.history;
    earlier.push(`Passenger: ${b}\nCapitán: ${t.text}`);
  }
  const turn = await director.respond(passenger, c.say, history, { channel: c.channel });
  const calls: ToolCallRecord[] = turn.toolCalls;
  const failures: string[] = [];

  for (const e of c.expect_tools ?? []) {
    const hit = calls.find((k) => k.name === e.name && (!e.args || subset(e.args, k.input)));
    if (!hit) failures.push(`expected ${e.name}${e.args ? " " + JSON.stringify(e.args) : ""}; got ${calls.map((k) => `${k.name} ${JSON.stringify(k.input)}`).join(" | ") || "no tools"}`);
  }
  if (c.expect_tools_any && !calls.some((k) => c.expect_tools_any!.includes(k.name))) failures.push(`expected one of ${c.expect_tools_any.join("/")}; got ${calls.map((k) => k.name).join(",") || "none"}`);
  for (const f of c.forbid_tools ?? []) if (calls.some((k) => k.name === f)) failures.push(`forbidden tool called: ${f}`);
  if (c.reply_lang) {
    const got = detectLang(turn.text);
    if (got !== c.reply_lang && got !== "mixed") failures.push(`reply language ${got}, wanted ${c.reply_lang}`);
  }
  if (c.reply_should_ask && !/\?/.test(turn.text)) failures.push("expected a clarifying question");
  if (c.reply_must_mention_any && !c.reply_must_mention_any.some((m) => turn.text.toLowerCase().includes(m))) failures.push(`reply should mention one of ${c.reply_must_mention_any.join("/")}`);
  if (c.reply_must_not_mention_any) for (const m of c.reply_must_not_mention_any) if (turn.text.toLowerCase().includes(m.toLowerCase())) failures.push(`reply leaked "${m}"`);
  if (turn.text.length > 900) failures.push(`reply too long (${turn.text.length} chars) for WhatsApp`);
  if (c.reply_max_chars && turn.text.length > c.reply_max_chars) failures.push(`reply too long (${turn.text.length} > ${c.reply_max_chars} chars)`);
  if (c.reply_speakable) {
    if (/\p{Extended_Pictographic}/u.test(turn.text)) failures.push("spoken reply has emoji");
    if (/https?:\/\//.test(turn.text)) failures.push("spoken reply reads out a link");
    if (/\[[A-Za-z0-9-]{3,12}\]|^\s*[-•*] /m.test(turn.text)) failures.push("spoken reply has ids or a list");
  }

  let verdict: z.infer<typeof Verdict> | undefined;
  if (judge) {
    // The judge sees what the Capitán saw (persona + passenger context with today's program),
    // so facts taken from the context are not mistaken for invented ones.
    const context = `${PERSONA}\n\n${await director.contextFor(passenger, c.say, now, c.channel)}`;
    try {
      const res = await client.messages.parse({
        model: process.env.HELPER_MODEL ?? "claude-haiku-5-5",
        max_tokens: 1024,
        system:
          "You grade one reply from a cruise-director chatbot against its persona rules. Below, between the markers, is the chatbot's full system prompt: its persona and the per-passenger context it was given (today's program and sign-ups are already in it, so details taken from there are not invented). Judge by the persona's own definitions: a warm, plain reply with no gag is in character at any humor level (the persona says many replies need none); *Ding-dong* and ship-speak place names are voice, not gags, so '*Ding-dong.* <answer>' answers in its first line; one line of sponsor enthusiasm before a needed question is fine. Phrases the persona itself prescribes are not gags: 'the event of the season' for any sponsored activity, the stock empty-schedule line 'Tu camastro se ve solitario' (an empty deck chair, not a comment on anyone's love life), and Greek greetings. When the passenger asks who someone or something is (Manpaty, the ship, the captain), describing them is the answer, not a gag. On a live voice call (the context says so) plain spoken sentences are in character even without ship-speak, and so is a reported tool failure stated plainly. Ship-speak, Greek words and Spanish cues are optional flavor: a short, warm, plain reply that does the job is in character without them. Only tools whose names start with admin_ are admin-only; list_passengers (who is aboard) is for every passenger, even though the persona calls admin_manifest 'the full manifest'. Fail humor rules only for a forbidden topic, more than one gag, or a gag as the last line. Keep notes to one or two short sentences.\n\n<chatbot_system_prompt>\n" +
          context +
          "\n</chatbot_system_prompt>",
        output_config: { format: zodOutputFormat(Verdict) },
        messages: [{ role: "user", content: `${earlier.length ? `Earlier in this conversation:\n${earlier.join("\n")}\n\n` : ""}Passenger said: ${c.say}\n\n<reply>\n${turn.text}\n</reply>\n\n(Grader metadata, not part of the reply. Tools the chatbot called this turn and what they returned, which is also ground truth:\n${calls.map((k) => `- ${k.name} ${JSON.stringify(k.input)} → ${k.output.slice(0, 600)}`).join("\n") || "none"})` }],
      });
      verdict = res.parsed_output ?? undefined;
      if (verdict && !(verdict.in_character && verdict.useful_first && verdict.humor_rules_ok)) failures.push(`judge: ${verdict.notes}`);
    } catch (err) {
      // A judge hiccup must not discard the deterministic checks above.
      failures.push(`judge errored: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    }
  }

  return { id: c.id, say: c.say, reply: turn.text, tools: calls.map((k) => ({ name: k.name, input: k.input })), sent, failures, verdict, usage: turn.usage };
}

const selected = only ? cases.filter((c) => c.id === only) : cases;
const results = [];
for (const c of selected) {
  process.stdout.write(`• ${c.id} … `);
  try {
    const r = await runCase(c);
    results.push(r);
    console.log(r.failures.length ? `❌ ${r.failures.join("; ")}` : "✅");
  } catch (err) {
    results.push({ id: c.id, failures: [`threw: ${err instanceof Error ? err.message : String(err)}`] });
    console.log(`💥 ${err instanceof Error ? err.message : err}`);
  }
}
const passed = results.filter((r) => !r.failures.length).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(join(here, "results"), { recursive: true });
const out = join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ passed, total: results.length, results }, null, 2));
console.log(`results → ${out}`);
process.exitCode = passed === results.length ? 0 : 1;
