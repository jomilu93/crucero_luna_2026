import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Person, Store } from "@crucero/db";
import { buildPassengerContext } from "./context.js";
import { PERSONA } from "./persona.js";
import { buildTools, type FlyerMaker, type Outbox, type ToolCallRecord } from "./tools.js";

export interface DirectorOptions {
  client?: Anthropic;
  model?: string;
  /** Effort for chat turns. 'low' keeps replies fast and cheap; raise for the morning show. */
  effort?: "low" | "medium" | "high";
  outbox: Outbox;
  flyers?: FlyerMaker;
  cabinLink?: (person: Person) => string;
  now?: () => Date;
}

export interface Turn {
  text: string;
  history: BetaMessageParam[];
  toolCalls: ToolCallRecord[];
  stopReason: BetaMessage["stop_reason"];
  usage: BetaMessage["usage"];
}

const SERVER_FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01" as const;

/**
 * Capitán Lunático's brain. One instance per process; `respond` is per passenger turn.
 *
 * The system prompt is only the persona, identical on every request. The volatile passenger
 * context (ship time, today's program, memory) rides at the start of each user turn as a
 * <ship_context> block, so earlier turns are never rewritten: thinking blocks in the saved
 * history stay bound to an unchanged prefix, and the whole history stays cacheable.
 */
export class Director {
  readonly client: Anthropic;
  readonly model: string;
  readonly effort: "low" | "medium" | "high";
  private readonly outbox: Outbox;
  private readonly flyers?: FlyerMaker;
  private readonly cabinLink?: (person: Person) => string;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    opts: DirectorOptions,
  ) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.DIRECTOR_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "low";
    this.outbox = opts.outbox;
    this.flyers = opts.flyers;
    this.cabinLink = opts.cabinLink;
    this.now = opts.now ?? (() => new Date());
  }

  /** The per-turn context block that precedes the passenger's words in their message. */
  async contextFor(passenger: Person, text: string, now = this.now(), channel?: string): Promise<string> {
    return `<ship_context>\n${await buildPassengerContext(this.store, { person: passenger, now, text, channel })}\n</ship_context>`;
  }

  async respond(passenger: Person, text: string, history: BetaMessageParam[] = [], opts: { channel?: "cli" | "whatsapp" | "telegram" | "web" | "voice" } = {}): Promise<Turn> {
    const now = this.now();
    const toolCalls: ToolCallRecord[] = [];
    const tools = buildTools({
      store: this.store,
      passenger,
      now,
      outbox: this.outbox,
      channel: opts.channel ?? "cli",
      flyers: this.flyers,
      cabinLink: this.cabinLink,
      onToolCall: (rec) => toolCalls.push(rec),
    });
    await this.store.logMessage({ personId: passenger.id, channel: opts.channel ?? "cli", direction: "in", body: text });

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }],
      // Safety net: a trimmed or pre-existing history whose thinking blocks no longer match is
      // answered without those blocks instead of failing with a 400.
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: this.effort },
      betas: [SERVER_FALLBACK_BETA, THINKING_BINDING_BETA],
      fallbacks: "default",
      tools,
      messages: [
        ...history,
        {
          role: "user",
          content: [
            { type: "text", text: await this.contextFor(passenger, text, now, opts.channel) },
            { type: "text", text },
          ],
        },
      ],
      max_iterations: 8,
    });

    const final = await runner.runUntilDone();
    const reply =
      final.stop_reason === "refusal"
        ? "El Capitán tuvo que morderse la lengua con eso. ¿Hablamos del programa de hoy?"
        : final.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();

    await this.store.logMessage({
      personId: passenger.id,
      channel: opts.channel ?? "cli",
      direction: "out",
      body: reply,
      toolCalls: toolCalls.map((t) => ({ name: t.name, input: t.input })),
    });

    return { text: reply, history: [...runner.params.messages], toolCalls, stopReason: final.stop_reason, usage: final.usage };
  }
}
