import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder, type TemplateOutbox } from "@crucero/agent";
import { MemoryStore, mx, seedSample, type Person } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "./http.js";
import { MetaWhatsAppOutbox } from "./meta.js";
import { RoutingOutbox } from "./routing.js";
import { cabinToken, chatLinkCode, verifyChatLink } from "./web.js";

const SECRET = "routing-secret";
const NOW = new Date(mx("2026-10-29", "10:00"));

const recorder = (name: string, log: string[]): TemplateOutbox => ({
  send: async (to, text) => void log.push(`${name}→${to === "everyone" ? "everyone" : to.id}: ${text}`),
  sendTemplate: async (to, kind) => void log.push(`${name}→${to.id}: [${kind}]`),
});

describe("WhatsApp and Telegram side by side", () => {
  it("sends each passenger's messages on their own channel, and announcements to everyone on theirs", async () => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    await store.updatePerson("sofia", { phoneE164: "tg:11" });
    await store.updatePerson("ricardo", { muted: true });
    const web = await store.createPerson({ name: "Web Only", contactPhone: "+525599990000", language: "es", role: "adult" });
    const log: string[] = [];
    const out = new RoutingOutbox({ telegram: recorder("tg", log), whatsapp: recorder("wa", log) }, () => store.listPeople());
    await out.send((await store.getPerson("sofia"))!, "hola");
    await out.send((await store.getPerson("diego"))!, "hi");
    await out.send(web, "nadie");
    await out.sendTemplate((await store.getPerson("carmen"))!, "morning_knock", {});
    expect(log).toEqual(["tg→sofia: hola", "wa→diego: hi", "wa→carmen: [morning_knock]"]);
    expect(out.canReach(web)).toBe(false);
    log.length = 0;
    await out.send("everyone", "📣 Bingo a las 8");
    expect(log.every((l) => !l.includes("everyone"))).toBe(true); // fanned out per passenger, never "everyone" to one channel
    expect(log).toContain("tg→sofia: 📣 Bingo a las 8");
    expect(log.some((l) => l.startsWith("wa→ricardo"))).toBe(false); // muted
    expect(log.some((l) => l.includes(web.id))).toBe(false);
  });

  it("falls back to the notice template when WhatsApp's 24-hour window is closed", async () => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    const calls: any[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.type === "text") return new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const meta = new MetaWhatsAppOutbox({ accessToken: "T", phoneNumberId: "P", templates: { notice: "aviso_capitan" }, fetch: fakeFetch }, () => store.listPeople());
    const carmen = (await store.getPerson("carmen"))!;
    await meta.send(carmen, "⏰ 30 min: Bingo\nen el Gran Salón");
    expect(calls.map((c) => c.type)).toEqual(["text", "template"]);
    expect(calls[1].template).toMatchObject({ name: "aviso_capitan", components: [{ type: "body", parameters: [{ type: "text", text: "⏰ 30 min: Bingo · en el Gran Salón" }] }] });
    expect(meta.canReach({ ...carmen, phoneE164: "tg:5" } as Person)).toBe(false);

    const strict = new MetaWhatsAppOutbox({ accessToken: "T", phoneNumberId: "P", fetch: fakeFetch }, () => store.listPeople());
    await expect(strict.send(carmen, "hola")).rejects.toThrow(/Meta 400/);
  });
});

describe("connecting WhatsApp from the website", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  const store = new MemoryStore({ now: () => NOW });
  seedSample(store);
  const heard: string[] = [];
  const responder: Responder = { respond: async (_p, text, history) => (heard.push(text), { text: "¡Hola!", history }) };
  const chat = new ChatService(store, responder, { send: async () => {} }, { now: () => NOW, verifyChatLink: (code) => verifyChatLink(SECRET, code) });
  const web = { store, outbox: { send: async () => {} }, publicUrl: "http://ship.test", secret: SECRET, botUsername: () => "CapitanBot", whatsappNumber: "+5215512340000", boardingCode: "Luna2026", now: () => NOW };

  beforeAll(async () => {
    const router = createRouter({ store, chat, publicUrl: "http://ship.test", web, webhooks: [] });
    server = createServer((req, res) => void router(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("offers WhatsApp first, with a prefilled message carrying the connect code", async () => {
    const lupe = await store.createPerson({ name: "Tía Lupe", contactPhone: "+525512345678", language: "es", role: "adult" });
    const page = await (await fetch(`${base}/c/${cabinToken(SECRET, lupe)}?welcome=1`)).text();
    const hello = encodeURIComponent(`Hola Capitán 👋 (código link_${chatLinkCode(SECRET, lupe)})`);
    expect(page).toContain(`https://wa.me/5215512340000?text=${hello}`);
    expect(page.indexOf("wa.me")).toBeLessThan(page.indexOf("t.me/CapitanBot?start=link_"));
    expect(page).not.toContain("Próximamente");
    const home = await (await fetch(`${base}/?home`)).text();
    expect(home).toContain("Por WhatsApp (o Telegram).");
    expect(home).not.toContain("pronto en WhatsApp");
  });

  it("attaches the WhatsApp chat from the code in the message, even from another number", async () => {
    const lupe = (await store.listPeople()).find((p) => p.name === "Tía Lupe")!;
    const { person } = await chat.handle({ phoneE164: "+15550001111", text: `Hola Capitán 👋 (código link_${chatLinkCode(SECRET, lupe)})`, channel: "whatsapp" });
    expect(person.id).toBe(lupe.id);
    expect((await store.getPerson(lupe.id))!.phoneE164).toBe("+15550001111");
    expect(heard.at(-1)).toMatch(/acaba de conectar este chat/);
  });

  it("recognises a web passenger writing from WhatsApp's +52 1 form of their number", async () => {
    const beto = await store.createPerson({ name: "Primo Beto", contactPhone: "+525522223333", language: "es", role: "adult" });
    const { person } = await chat.handle({ phoneE164: "+5215522223333", text: "hola", channel: "whatsapp" });
    expect(person.id).toBe(beto.id);
    expect((await store.getPerson(beto.id))!.phoneE164).toBe("+5215522223333");
  });
});
