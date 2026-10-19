import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageParam, BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Person, Store } from "@crucero/db";
import { buildPassengerContext } from "./context.js";
import { PERSONA } from "./persona.js";
import { buildTools, type Outbox, type ToolCallRecord } from "./tools.js";

export interface DirectorOptions {
  client?: Anthropic;
  model?: string;
  /** Effort for chat turns. 'low' keeps replies fast and cheap; raise for the morning show. */
  effort?: "low" | "medium" | "high";
  outbox: Outbox;
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

/**
 * Capitán Lunático's brain. One instance per process; `respond` is per passenger turn.
 * The persona is a cached prefix; the passenger context and the conversation follow it.
 */
export class Director {
  readonly client: Anthropic;
  readonly model: string;
  readonly effort: "low" | "medium" | "high";
  private readonly outbox: Outbox;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    opts: DirectorOptions,
  ) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.DIRECTOR_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "low";
    this.outbox = opts.outbox;
    this.now = opts.now ?? (() => new Date());
  }

  /** The system prompt as the API will see it: persona (cached) + volatile passenger context. */
  async systemFor(passenger: Person, text: string, now = this.now()): Promise<BetaTextBlockParam[]> {
    const context = await buildPassengerContext(this.store, { person: passenger, now, text });
    return [
      { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
      { type: "text", text: context },
    ];
  }

  async respond(passenger: Person, text: string, history: BetaMessageParam[] = [], opts: { channel?: "cli" | "whatsapp" | "telegram" | "web" | "voice" } = {}): Promise<Turn> {
    const now = this.now();
    const toolCalls: ToolCallRecord[] = [];
    const tools = buildTools({
      store: this.store,
      passenger,
      now,
      outbox: this.outbox,
      onToolCall: (rec) => toolCalls.push(rec),
    });
    await this.store.logMessage({ personId: passenger.id, channel: opts.channel ?? "cli", direction: "in", body: text });

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 4096,
      system: await this.systemFor(passenger, text, now),
      output_config: { effort: this.effort },
      betas: [SERVER_FALLBACK_BETA],
      fallbacks: "default",
      tools,
      messages: [...history, { role: "user", content: text }],
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
