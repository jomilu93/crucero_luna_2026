import { MemoryStore, isPaused, seedSample } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { ChatService, isAdminPassword, type Responder } from "./inbound.js";
import { tick, type TemplateOutbox } from "./scheduler.js";
import { buildTools } from "./tools.js";

const at = new Date("2026-12-27T15:00:00Z");

function setup() {
  const store = new MemoryStore({ now: () => at });
  seedSample(store);
  const sent: { to: string; text: string }[] = [];
  const outbox: TemplateOutbox = { send: async (to, text) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }), sendTemplate: async () => {} };
  const heard: string[] = [];
  const responder: Responder = { respond: async (_p, text, history) => (heard.push(text), { text: "capitán", history: [...history, { role: "user", content: text }] }) };
  const svc = new ChatService(store, responder, outbox, { now: () => at, adminPassword: "Ancla Dorada" });
  return { store, svc, sent, heard, outbox };
}

const tools = async (store: MemoryStore, id: string) =>
  Object.fromEntries(buildTools({ store, passenger: (await store.getPerson(id))!, now: at, outbox: { send: async () => {} } }).map((t) => [t.name, t])) as Record<string, { run: (i: any) => Promise<string> }>;

describe("admin password", () => {
  it("matches case-insensitively, with or without /admin, and never an empty password", () => {
    expect(isAdminPassword("  ancla dorada ", "Ancla Dorada")).toBe(true);
    expect(isAdminPassword("/admin Ancla Dorada", "Ancla Dorada")).toBe(true);
    expect(isAdminPassword("/admin@CapitanBot ancla dorada", "Ancla Dorada")).toBe(true);
    expect(isAdminPassword("ancla", "Ancla Dorada")).toBe(false);
    expect(isAdminPassword("", "")).toBe(false);
    expect(isAdminPassword("anything", undefined)).toBe(false);
  });

  it("grants admin without the password reaching the model or the history", async () => {
    const { svc, store, heard, sent } = setup();
    const r = await svc.handle({ phoneE164: "+15550000005", text: "ancla dorada", channel: "telegram" });
    expect(r.person.admin).toBe(true);
    expect((await store.getPerson("valeria"))!.admin).toBe(true);
    expect(heard).toEqual([]);
    expect(await store.getConversation("valeria")).toBeUndefined();
    expect((await store.listMessages("valeria")).map((m) => m.body)).toEqual(["[admin password]"]);
    expect(sent.at(-1)!.text).toMatch(/Acceso de administrador/);
  });

  it("only admins get admin tools", async () => {
    const { store } = setup();
    expect(Object.keys(await tools(store, "valeria"))).not.toContain("admin_manifest");
    await store.updatePerson("valeria", { admin: true });
    expect(Object.keys(await tools(store, "valeria"))).toEqual(expect.arrayContaining(["admin_manifest", "admin_remove_passenger", "admin_set_role", "admin_set_admin", "admin_pause"]));
  });
});

describe("admin tools", () => {
  it("removes a fake passenger with their sign-ups, but not a live host or oneself", async () => {
    const { store, svc } = setup();
    await store.updatePerson("valeria", { admin: true });
    const fake = (await svc.handle({ phoneE164: "+16315551181", text: "test", profileName: "Test Number" })).person;
    await store.setSignup("a04", fake.id, "going");
    const t = await tools(store, "valeria");
    expect(await t.admin_manifest.run({})).toMatch(/Test Number \(id .*whatsapp \+16315551181/);
    expect(await t.admin_remove_passenger.run({ person: fake.id })).toMatch(/^Removed Test Number/);
    expect(await store.findPersonByPhone("+16315551181")).toBeUndefined();
    expect((await store.listSignups("a04")).some((s) => s.personId === fake.id)).toBe(false);
    expect(await t.admin_remove_passenger.run({ person: "ricardo" })).toMatch(/^ERROR: still hosts "Bingo Lunático"/);
    expect(await t.admin_remove_passenger.run({ person: "valeria" })).toMatch(/^NOT ALLOWED/);
  });

  it("marks a kid with an adult guardian and back", async () => {
    const { store } = setup();
    await store.updatePerson("diego", { admin: true });
    const t = await tools(store, "diego");
    expect(await t.admin_set_role.run({ person: "valeria", role: "kid" })).toMatch(/^ERROR: a kid needs a guardian/);
    expect(await t.admin_set_role.run({ person: "valeria", role: "kid", guardian: "mateo" })).toMatch(/guardian must be an adult/);
    expect(await t.admin_set_role.run({ person: "valeria", role: "kid", guardian: "Sofía Luna" })).toBe("Valeria Luna is now a kid; guardian: Sofía Luna.");
    expect(await store.getPerson("valeria")).toMatchObject({ role: "kid", guardianId: "sofia" });
    await t.admin_set_role.run({ person: "valeria", role: "adult" });
    expect((await store.getPerson("valeria"))!.guardianId).toBeUndefined();
  });

  it("pauses the ship: passengers get an off-duty reply, admins the Capitán, the scheduler sends nothing", async () => {
    const { store, svc, heard, sent, outbox } = setup();
    await store.updatePerson("diego", { admin: true });
    await (await tools(store, "diego")).admin_pause.run({ paused: true });
    expect(await isPaused(store)).toBe(true);
    const r = await svc.handle({ phoneE164: "+15550000001", text: "¿qué hay hoy?" });
    expect(r.reply).toMatch(/fuera de servicio/);
    expect(heard).toEqual([]);
    await svc.handle({ phoneE164: "+15550000002", text: "status?" });
    expect(heard).toEqual(["status?"]);
    const before = sent.length;
    const writeMorning = async () => Promise.reject(new Error("must not write a morning show while paused"));
    const report = await tick({ store, outbox, writeMorning, useTemplates: false }, new Date("2026-12-27T13:00:00Z"));
    expect(report.errors).toEqual([]);
    expect(report.mornings).toEqual([]);
    expect(sent.length).toBe(before);
  });
});
