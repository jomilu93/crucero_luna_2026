import type Anthropic from "@anthropic-ai/sdk";
import { MemoryStore, seedSample, type Person } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { Director } from "./director.js";
import { PERSONA } from "./persona.js";

/** Captures what the Director sends to the tool runner; answers "ok" without calling the API. */
function fakeClient() {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        toolRunner: (params: any) => {
          const { tools: _tools, ...rest } = params; // tool handlers are functions and cannot be cloned
          requests.push(structuredClone(rest));
          return {
            params,
            runUntilDone: async () => {
              params.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "ok" }] });
              return { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: {} };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

describe("Director requests", () => {
  it("keeps the system prompt constant and earlier turns byte-identical across a pause", async () => {
    let now = new Date("2026-12-27T15:00:00Z");
    const store = new MemoryStore({ now: () => now });
    seedSample(store);
    const { client, requests } = fakeClient();
    const director = new Director(store, { client, outbox: { send: async () => {} }, now: () => now });
    const sofia = (await store.getPerson("sofia")) as Person;

    const first = await director.respond(sofia, "hola capitán");
    now = new Date("2026-12-27T19:30:00Z"); // hours later: ship time and context differ
    await director.respond(sofia, "¿qué hay hoy?", first.history);

    const [a, b] = requests;
    expect(a.system).toEqual([{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }]);
    expect(b.system).toEqual(a.system);
    // The second request starts with exactly what the first request sent and received.
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    expect(b.messages[0].content[0].text).toMatch(/^<ship_context>\n[\s\S]*09:00[\s\S]*<\/ship_context>$/);
    expect(b.messages.at(-1).content[0].text).toMatch(/13:30/);
    expect(b.messages.at(-1).content[1]).toEqual({ type: "text", text: "¿qué hay hoy?" });
    expect(b.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(b.betas).toContain("thinking-binding-controls-2026-08-01");
  });
});
