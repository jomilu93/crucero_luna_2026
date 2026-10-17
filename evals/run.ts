/**
 * Behavioral eval for Capitán Lunático: tool calls, language, and a few content checks.
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
import { Director, PERSONA, type Outbox, type ToolCallRecord } from "@crucero/agent";
import { MemoryStore, seedSample } from "@crucero/db";

const here = dirname(fileURLToPath(import.meta.url));

interface ToolExpectation { name: string; args?: Record<string, unknown> }
interface Case {
  id: string;
  as: string;
  at: string;
  say: string;
  setup?: { fill_activity?: string };
  expect_tools?: ToolExpectation[];
  expect_tools_any?: string[];
  forbid_tools?: string[];
  reply_lang?: "es" | "en";
  reply_should_ask?: boolean;
  reply_must_mention_any?: string[];
  reply_must_not_mention_any?: string[];
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

const Verdict = z.object({ in_character: z.boolean(), useful_first: z.boolean(), humor_rules_ok: z.boolean(), notes: z.string().max(300) });

async function runCase(c: Case) {
  const now = new Date(c.at);
  const store = new MemoryStore({ now: () => now });
  seedSample(store);
  if (c.setup?.fill_activity) {
    const a = (await store.getActivity(c.setup.fill_activity))!;
    const people = await store.listPeople();
    for (const p of people.filter((p) => p.id !== c.as).slice(0, a.capacity ?? 8)) await store.setSignup(a.id, p.id, "going");
  }
  const sent: { to: string; text: string }[] = [];
  const outbox: Outbox = { send: async (to, text) => void sent.push({ to: to === "everyone" ? "everyone" : to.name, text }) };
  const director = new Director(store, { outbox, now: () => now });
  const passenger = (await store.getPerson(c.as))!;
  const turn = await director.respond(passenger, c.say);
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

  let verdict: z.infer<typeof Verdict> | undefined;
  if (judge) {
    const res = await client.messages.parse({
      model: process.env.HELPER_MODEL ?? "claude-haiku-5-5",
      max_tokens: 1024,
      system: `You grade a cruise-director chatbot reply against its persona rules. Persona rules follow.\n\n${PERSONA}`,
      output_config: { format: zodOutputFormat(Verdict) },
      messages: [{ role: "user", content: `Passenger (${passenger.name}, humor=${passenger.humor}, lang=${passenger.language}) said: ${c.say}\n\nReply:\n${turn.text}\n\nTools used: ${calls.map((k) => k.name).join(", ") || "none"}` }],
    });
    verdict = res.parsed_output ?? undefined;
    if (verdict && !(verdict.in_character && verdict.useful_first && verdict.humor_rules_ok)) failures.push(`judge: ${verdict.notes}`);
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
