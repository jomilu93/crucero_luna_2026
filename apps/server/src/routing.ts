/**
 * Several chat channels at once: WhatsApp is the main one and Telegram keeps working for whoever connected it.
 * Each passenger's chat address picks the channel (`tg:<id>` → Telegram, `+<E.164>` → WhatsApp), and "everyone"
 * fans out to every reachable, unmuted passenger on their own channel.
 */
import type { TemplateKind, TemplateOutbox } from "@crucero/agent";
import type { Person } from "@crucero/db";

export class RoutingOutbox implements TemplateOutbox {
  constructor(
    private readonly channels: { telegram?: TemplateOutbox; whatsapp?: TemplateOutbox },
    private readonly listPeople: () => Promise<Person[]>,
  ) {}

  /** The channel that can reach this passenger, if any (the TV seat and web-only passengers have none). */
  channelFor(p: Person): TemplateOutbox | undefined {
    if (p.phoneE164?.startsWith("tg:")) return this.channels.telegram;
    if (p.phoneE164?.startsWith("+")) return this.channels.whatsapp;
    return undefined;
  }

  canReach(to: Person): boolean {
    const ch = this.channelFor(to);
    return !!ch && (ch.canReach?.(to) ?? true);
  }

  async send(to: Person | "everyone", text: string, opts?: { mediaUrl?: string; from: Person }): Promise<void> {
    if (to !== "everyone") {
      await this.channelFor(to)?.send(to, text, opts);
      return;
    }
    for (const p of await this.listPeople()) {
      if (p.muted || !this.canReach(p)) continue;
      await this.channelFor(p)!.send(p, text, opts);
    }
  }

  async sendTemplate(to: Person, kind: TemplateKind, variables: Record<string, string>): Promise<void> {
    const ch = this.channelFor(to);
    if (ch?.sendTemplate) await ch.sendTemplate(to, kind, variables);
  }

  async sendInteractive(to: Person, body: string, buttons: { id: string; title: string }[]): Promise<void> {
    const ch = this.channelFor(to);
    if (ch?.sendInteractive) await ch.sendInteractive(to, body, buttons);
    else await ch?.send(to, body);
  }
}
