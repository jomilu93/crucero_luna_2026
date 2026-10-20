import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MemoryStore, mx, seedSample, type Person } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { buildPersonalCalendar } from "./ics.js";
import { ChatService, MORNING_BUTTONS, trimHistory, type Responder } from "./inbound.js";
import { morningWindowStart, reminderText, tick, type TemplateOutbox } from "./scheduler.js";

type Sent = { to: string; text: string };
type SentTemplate = { to: string; kind: string; vars: Record<string, string> };

function fakeOutbox() {
  const sent: Sent[] = [];
  const templates: SentTemplate[] = [];
  const outbox: TemplateOutbox = {
    send: async (to, text) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }),
    sendTemplate: async (to, kind, vars) => void templates.push({ to: to.id, kind, vars }),
  };
  return { outbox, sent, templates };
}

const echoResponder: Responder = {
  respond: async (p, text, history) => ({
    text: `echo(${p.name.split(" ")[0]}): ${text}`,
    history: [...history, { role: "user", content: text }, { role: "assistant", content: [{ type: "text", text: `echo: ${text}` }] }],
  }),
};

describe("trimHistory", () => {
  it("never starts on a tool_result turn", () => {
    const h: BetaMessageParam[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "b" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(trimHistory(h, 4).map((m) => (typeof m.content === "string" ? m.content : m.content[0].type))).toEqual(["b", "text"]);
    expect(trimHistory(h, 10)).toHaveLength(6);
  });
});

describe("ChatService", () => {
  const at = new Date("2026-12-27T15:00:00Z");
  function setup() {
    const store = new MemoryStore({ now: () => at });
    seedSample(store);
    const { outbox, sent } = fakeOutbox();
    const svc = new ChatService(store, echoResponder, outbox, { now: () => at });
    return { store, svc, sent };
  }

  it("has Manpaty greet a new passenger with a photo before the Capitán's first reply, once", async () => {
    const store = new MemoryStore({ now: () => at });
    seedSample(store);
    const sent: { to: string; text: string; mediaUrl?: string }[] = [];
    const outbox: TemplateOutbox = { send: async (to, text, opts) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text, mediaUrl: opts?.mediaUrl }), sendTemplate: async () => {} };
    const svc = new ChatService(store, echoResponder, outbox, { now: () => at, welcomePhotoUrl: "https://ship.test/manpaty.png" });
    const r = await svc.handle({ phoneE164: "tg:42", text: "hola", profileName: "Lupita", channel: "telegram" });
    expect(sent[0]).toMatchObject({ to: r.person.id, mediaUrl: "https://ship.test/manpaty.png", text: expect.stringMatching(/Manpaty, Primer Oficial del Moon of the Seas/) });
    expect(sent[1]).toMatchObject({ text: "echo(Lupita): hola" });
    await svc.handle({ phoneE164: "tg:42", text: "otra vez" });
    expect(sent.filter((m) => m.mediaUrl)).toHaveLength(1);
  });

  it("boards an unknown number using the WhatsApp profile name", async () => {
    const { svc, store, sent } = setup();
    const r = await svc.handle({ phoneE164: "+15559990000", text: "hola", profileName: "Lupita" });
    expect(r.person.name).toBe("Lupita");
    expect(r.person.language).toBe("es");
    expect((await store.findPersonByPhone("+15559990000"))?.id).toBe(r.person.id);
    expect(sent).toEqual([{ to: r.person.id, text: "echo(Lupita): hola" }]);
  });

  it("continues a conversation and persists trimmed history", async () => {
    const { svc, store } = setup();
    await svc.handle({ phoneE164: "+15550000001", text: "uno" });
    await svc.handle({ phoneE164: "+15550000001", text: "dos" });
    const conv = await store.getConversation("sofia");
    expect(conv?.history).toHaveLength(4);
    expect((conv!.history[2] as BetaMessageParam).content).toBe("dos");
  });

  it("restarts a stale conversation", async () => {
    const store = new MemoryStore({ now: () => at });
    seedSample(store);
    await store.saveConversation("sofia", [{ role: "user", content: "old" }, { role: "assistant", content: "old reply" }]);
    const later = new Date(at.getTime() + 13 * 3600 * 1000);
    const { outbox } = fakeOutbox();
    const svc = new ChatService(store, echoResponder, outbox, { now: () => later });
    await svc.handle({ phoneE164: "+15550000001", text: "nuevo" });
    expect((await store.getConversation("sofia"))?.history).toHaveLength(2);
  });

  it("releases the pending morning show on a button tap without calling the model", async () => {
    const { svc, store, sent } = setup();
    await store.markDelivered("morning", `sofia:2026-12-27`, { full_message: "🚢 Buenos días Sofía…", offered_activity_ids: ["a04"] });
    const r = await svc.handle({ phoneE164: "+15550000001", text: "Ver mi día", buttonPayload: MORNING_BUTTONS.show });
    expect(r.releasedMorning).toBe(true);
    expect(r.reply).toBeUndefined();
    expect(sent).toEqual([{ to: "sofia", text: "🚢 Buenos días Sofía…" }]);
    expect(await store.wasDelivered("morning_full", "sofia:2026-12-27")).toBe(true);
    // A second tap does nothing.
    const again = await svc.handle({ phoneE164: "+15550000001", text: "Ver mi día", buttonPayload: MORNING_BUTTONS.show });
    expect(again.releasedMorning).toBe(false);
  });

  it("releases the morning show before answering a real message, and 'hoy no' suppresses it", async () => {
    const { svc, store, sent } = setup();
    await store.markDelivered("morning", `diego:2026-12-27`, { full_message: "Good morning Diego…", offered_activity_ids: [] });
    const r = await svc.handle({ phoneE164: "+15550000002", text: "sign me up for bingo" });
    expect(r.releasedMorning).toBe(true);
    expect(sent.map((s) => s.text)).toEqual(["Good morning Diego…", "echo(Diego): sign me up for bingo"]);

    await store.markDelivered("morning", `valeria:2026-12-27`, { full_message: "…", offered_activity_ids: [] });
    await svc.handle({ phoneE164: "+15550000005", text: "Hoy no", buttonPayload: MORNING_BUTTONS.skip });
    expect(sent.filter((s) => s.to === "valeria")).toEqual([]);
    expect(await store.wasDelivered("morning_full", "valeria:2026-12-27")).toBe(true);
  });
});

describe("scheduler tick", () => {
  function setup(now: Date, useTemplates = false) {
    const store = new MemoryStore({ now: () => now });
    seedSample(store);
    const { outbox, sent, templates } = fakeOutbox();
    const writeMorning = async (p: Person, date: string) => ({
      knock_headline: `Headline ${date}`,
      full_message: `Full morning for ${p.name}`,
      offered_activity_ids: [],
    });
    return { store, outbox, sent, templates, deps: { store, outbox, writeMorning, useTemplates } };
  }

  it("sends each person's morning once, within their wake window", async () => {
    // 07:30 ship time on Dec 27: Sofía (06:30) and the 07:30 crowd are due.
    const now = new Date(mx("2026-12-27", "07:30"));
    const { deps, sent, store } = setup(now);
    const r1 = await tick(deps, now);
    expect(r1.mornings.sort()).toEqual(["carmen", "diego", "ricardo", "sofia", "valeria"]); // Mateo has no phone
    expect(sent.find((s) => s.to === "sofia")?.text).toBe("Full morning for Sofía Luna");
    expect(await store.wasDelivered("morning_full", "sofia:2026-12-27")).toBe(true);
    const r2 = await tick(deps, new Date(now.getTime() + 60_000));
    expect(r2.mornings).toEqual([]);
    expect(sent.filter((s) => s.text.startsWith("Full morning"))).toHaveLength(5);
  });

  it("is not due before wake time and gives up 3 hours after", async () => {
    const early = new Date(mx("2026-12-27", "06:00"));
    const { deps } = setup(early);
    expect((await tick(deps, early)).mornings).toEqual([]);
    const late = new Date(mx("2026-12-27", "11:00"));
    const s2 = setup(late);
    expect((await tick(s2.deps, late)).mornings).toEqual([]);
  });

  it("uses the template knock and parks the full message when templates are on", async () => {
    const now = new Date(mx("2026-12-27", "07:30"));
    const { deps, sent, templates, store } = setup(now, true);
    await tick(deps, now);
    expect(sent.filter((s) => s.text.startsWith("Full morning"))).toHaveLength(0);
    expect(templates.find((t) => t.to === "diego")).toEqual({ to: "diego", kind: "morning_knock", vars: { "1": "Diego", "2": "Headline 2026-12-27", "3": "1" } });
    const d = await store.getDelivery("morning", "diego:2026-12-27");
    expect((d?.payload as { full_message: string }).full_message).toBe("Full morning for Diego Luna");
    expect(await store.wasDelivered("morning_full", "diego:2026-12-27")).toBe(false);
  });

  it("whispers late on Jan 1", () => {
    const sofia = { wakeTime: "06:30" } as Person;
    expect(morningWindowStart(sofia, "2027-01-01")).toBe("10:00");
    expect(morningWindowStart(sofia, "2026-12-31")).toBe("06:30");
    expect(morningWindowStart({ wakeTime: "11:00" } as Person, "2027-01-01")).toBe("11:00");
  });

  it("sends T-30 reminders once, routes kids to guardians, skips quiet hours", async () => {
    // Bingo (a04) at 20:00 Dec 27; Carmen + Mateo are going. Carmen's quiet hours start at 21:00 so she gets it.
    const now = new Date(mx("2026-12-27", "19:35"));
    const { deps, sent, store } = setup(now);
    const r = await tick(deps, now);
    expect(r.reminders.sort()).toEqual(["a04:carmen", "a04:mateo"]);
    const carmen = sent.find((s) => s.to === "carmen")!;
    expect(carmen.text).toMatch(/^⏰ En 25 min: 🎱 Bingo Lunático con Tío · 8:00 pm · Comedor \(Gran Salón\)\. Lleva: Monedas de 10 pesos\./);
    expect(carmen.text.split("pesos.")[1].trim().length).toBeGreaterThan(5); // light humor → one wink appended
    // Mateo has no phone: his reminder goes to Diego (guardian) only.
    expect(sent.filter((s) => s.to === "mateo")).toHaveLength(0);
    expect(sent.find((s) => s.to === "diego")?.text).toMatch(/^For Mateo: ⏰ In 25 min: 🎱 Bingo Lunático with Tío/);
    expect((await store.listSignups("a04")).every((s) => s.remindedAt)).toBe(true);
    expect((await tick(deps, new Date(now.getTime() + 60_000))).reminders).toEqual([]);
  });

  it("honors humor 'off' and quiet hours on reminders", async () => {
    const now = new Date(mx("2026-12-27", "19:35"));
    const { deps, sent, store } = setup(now);
    await store.updatePerson("carmen", { humor: "off" });
    await store.updatePerson("diego", { quietHours: { start: "19:00", end: "22:00" } });
    await tick(deps, now);
    const carmen = sent.find((s) => s.to === "carmen")!;
    expect(carmen.text).toMatch(/pesos\.$/); // humor off → no wink
    expect(sent.find((s) => s.to === "diego")).toBeUndefined();
  });

  it("nudges the sponsor an hour before, once", async () => {
    const now = new Date(mx("2026-12-27", "19:05"));
    const { deps, sent } = setup(now);
    const r = await tick(deps, now);
    expect(r.sponsorNudges).toEqual(["a04"]);
    expect(sent.find((s) => s.to === "ricardo")?.text).toMatch(/^🫡 Capitán a Tío: en una hora es tu 🎱 Bingo Lunático \(8:00 pm, Comedor \(Gran Salón\)\)\. 2 pasajeros cuentan contigo\./);
    expect((await tick(deps, new Date(now.getTime() + 60_000))).sponsorNudges).toEqual([]);
  });

  it("skips the morning show for passengers the channel cannot reach", async () => {
    const now = new Date(mx("2026-12-27", "07:30"));
    const { deps } = setup(now);
    const r = await tick({ ...deps, outbox: { ...deps.outbox, canReach: (p: Person) => p.id === "sofia" } }, now);
    expect(r.mornings).toEqual(["sofia"]);
  });

  it("sends nothing proactive to muted passengers", async () => {
    const morning = new Date(mx("2026-12-27", "07:30"));
    const a = setup(morning);
    await a.store.updatePerson("sofia", { muted: true });
    expect((await tick(a.deps, morning)).mornings).not.toContain("sofia");
    const nudge = new Date(mx("2026-12-27", "19:05"));
    const b = setup(nudge);
    await b.store.updatePerson("ricardo", { muted: true });
    expect((await tick(b.deps, nudge)).sponsorNudges).toEqual([]);
    expect(b.sent.find((s) => s.to === "ricardo")).toBeUndefined();
  });

  it("reminder text is deterministic per activity+person", () => {
    const a = { id: "a04", emoji: "🎱", title: "Bingo", startsAt: mx("2026-12-27", "20:00"), location: "Salón" } as never;
    const p = { id: "carmen", language: "es", humor: "full" } as Person;
    expect(reminderText(a, undefined, p, 30)).toBe(reminderText(a, undefined, p, 30));
  });
});

describe("personal calendar (ICS)", () => {
  it("includes hosted and signed-up activities with alarms", async () => {
    const store = new MemoryStore();
    seedSample(store);
    const sofia = (await store.getPerson("sofia"))!;
    const ics = await buildPersonalCalendar(store, sofia);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    const events = ics.split("BEGIN:VEVENT").length - 1;
    expect(events).toBe(6); // 4 yoga + gala (going) + group photo (host)
    expect(ics).toContain("UID:a11@crucero-luna-2026");
    expect(ics).toContain("DTSTART:20261231T130000Z"); // 7:00 am yoga NYE in UTC
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).toContain("Tú eres el anfitrión");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
  it("marks maybes tentative and cancelled events cancelled", async () => {
    const store = new MemoryStore();
    seedSample(store);
    await store.updateActivity("a11", { status: "cancelled", cancelledReason: "x" });
    const valeria = (await store.getPerson("valeria"))!; // maybe for a11
    const ics = await buildPersonalCalendar(store, valeria);
    expect(ics).toContain("STATUS:CANCELLED");
    const diegoIcs = await buildPersonalCalendar(store, (await store.getPerson("valeria"))!);
    expect(diegoIcs).toContain("(tal vez)");
  });
});
