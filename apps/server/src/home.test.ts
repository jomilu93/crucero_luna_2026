import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder } from "@crucero/agent";
import { MemoryStore, mx, seedSample } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "./http.js";
import { parseTelegramUpdate } from "./telegram.js";
import { tvData } from "./tv.js";
import { cabinToken, chatLinkCode, tvKey, verifyChatLink } from "./web.js";

const SECRET = "test-web-secret";
const NOW = new Date(mx("2026-10-25", "10:00")); // two months before sailing

describe("the website as the front door", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  const store = new MemoryStore({ now: () => NOW });
  seedSample(store);
  const outbox = { send: async () => {} };
  const heard: string[] = [];
  const responder: Responder = {
    respond: async (_p, text, history) => (heard.push(text), { text: "¡Bienvenido!", history: [...history, { role: "user", content: text }] }),
  };
  const chat = new ChatService(store, responder, outbox, { now: () => NOW, verifyChatLink: (code) => verifyChatLink(SECRET, code) });

  beforeAll(async () => {
    const web = { store, outbox, publicUrl: "http://ship.test", secret: SECRET, botUsername: () => "CapitanBot", boardingCode: "Luna2026", adminPassword: "Capitana Popeye", now: () => NOW };
    const router = createRouter({ store, chat, publicUrl: "http://ship.test", web, webhooks: [] });
    server = createServer((req, res) => void router(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const join = (form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}/join`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Fly-Client-IP": form.name ?? "x", ...headers },
      body: new URLSearchParams({ lang: "es", country: "52", ...form }).toString(),
    });
  const cookieOf = (res: Response) => res.headers.get("set-cookie")?.match(/cl_cabin=([^;]*)/)?.[1];

  it("explains the ship and invites people to join, in Spanish or English", async () => {
    const es = await (await fetch(`${base}/`)).text();
    expect(es).toContain("Moonshine of the Seas");
    expect(es).toContain("anteriormente Fondo de Cristal Victoria");
    expect(es).toContain("62");
    expect(es).toContain("días para zarpar");
    expect(es).toMatch(/<form class="joinbox" method="post" action="\/join">/);
    expect(es).toContain("Código del barco");
    expect(es).not.toContain("Sofía"); // the public page names nobody
    const en = await (await fetch(`${base}/?lang=en`)).text();
    expect(en).toContain("Join the cruise");
    expect(await (await fetch(`${base}/`, { headers: { "Accept-Language": "en-US,en;q=0.9" } })).text()).toContain("What happens on board?");
  });

  it("boards a passenger with name, number and the family code, and remembers the browser", async () => {
    const wrong = await join({ name: "Tía Lupe", phone: "55 1234 5678", code: "sardina" });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toContain("Ese código no es");
    expect((await store.listPeople()).some((p) => p.name === "Tía Lupe")).toBe(false);
    expect((await join({ name: "Tía Lupe", phone: "123", code: "Luna2026" })).status).toBe(400);

    const ok = await join({ name: "Tía Lupe", phone: "55 1234 5678", code: "luna 2026" });
    expect(ok.status).toBe(303);
    const lupe = (await store.listPeople()).find((p) => p.name === "Tía Lupe")!;
    expect(lupe).toMatchObject({ contactPhone: "+525512345678", language: "es", role: "adult" });
    expect(lupe.admin).toBeFalsy();
    expect(lupe.phoneE164).toBeUndefined();
    const token = cabinToken(SECRET, lupe);
    expect(ok.headers.get("location")).toBe(`/c/${token}?welcome=1`);
    expect(cookieOf(ok)).toBe(token);
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);

    // The home page sends this browser to its cabin; ?home shows the page anyway.
    const again = await fetch(`${base}/`, { redirect: "manual", headers: { Cookie: `cl_cabin=${token}` } });
    expect(again.headers.get("location")).toBe(`/c/${token}`);
    expect((await fetch(`${base}/?home`, { headers: { Cookie: `cl_cabin=${token}` } })).status).toBe(200);
    expect((await fetch(`${base}/`, { redirect: "manual", headers: { Cookie: "cl_cabin=forged.token" } })).status).toBe(200);

    // The welcome: everything on the web, Telegram to connect, WhatsApp soon.
    const cabin = await (await fetch(`${base}/c/${token}?welcome=1`)).text();
    expect(cabin).toContain("¡Bienvenido a bordo!");
    expect(cabin).toContain(`https://t.me/CapitanBot?start=link_${chatLinkCode(SECRET, lupe)}`);
    expect(cabin).toContain("Próximamente");
  });

  it("signs the same number back in on another phone, and the admin code makes an admin", async () => {
    const before = (await store.listPeople()).length;
    const again = await join({ name: "Lupe (otro cel)", phone: "+52 1 55 1234 5678", code: "LUNA2026" });
    const lupe = (await store.listPeople()).find((p) => p.contactPhone === "+525512345678")!;
    expect(again.headers.get("location")).toBe(`/c/${cabinToken(SECRET, lupe)}?welcome=1`);
    expect((await store.listPeople()).length).toBe(before);
    expect(lupe.name).toBe("Tía Lupe");

    const boss = await join({ name: "Pepe Mike", phone: "312 555 0101", country: "1", code: "capitana popeye" });
    expect(boss.status).toBe(303);
    expect((await store.listPeople()).find((p) => p.contactPhone === "+13125550101")).toMatchObject({ name: "Pepe Mike", admin: true });
    const promoted = await join({ name: "Tía Lupe", phone: "5512345678", code: "CapitanaPopeye" });
    expect(promoted.status).toBe(303);
    expect((await store.getPerson(lupe.id))!.admin).toBe(true);
  });

  it("stops guessing the code after a few tries", async () => {
    for (let i = 0; i < 8; i++) expect((await join({ name: "Intruso", phone: "5599990000", code: `x${i}` })).status).toBe(403);
    const blocked = await join({ name: "Intruso", phone: "5599990000", code: "Luna2026" });
    expect(blocked.status).toBe(429);
  });

  it("sends QR codes to the activity, joining first when the browser is new", async () => {
    const fresh = await fetch(`${base}/a/a04`, { redirect: "manual" });
    expect(fresh.headers.get("location")).toBe("/?next=a/a04");
    const page = await (await fetch(`${base}/?next=a/a04`)).text();
    expect(page).toContain("Te invitaron a");
    expect(page).toContain('name="next" value="a/a04"');
    const joined = await join({ name: "Primo Beto", phone: "55 2222 3333", code: "Luna2026", next: "a/a04" });
    const beto = (await store.listPeople()).find((p) => p.name === "Primo Beto")!;
    expect(joined.headers.get("location")).toBe(`/c/${cabinToken(SECRET, beto)}/a/a04`);
    const back = await fetch(`${base}/a/a04`, { redirect: "manual", headers: { Cookie: `cl_cabin=${cabinToken(SECRET, beto)}` } });
    expect(back.headers.get("location")).toBe(`/c/${cabinToken(SECRET, beto)}/a/a04`);
    expect((await join({ name: "x", phone: "55 2222 3333", code: "Luna2026", next: "https://evil.example" })).headers.get("location")).not.toContain("evil");
  });

  it("lets a Telegram-first passenger add their number, and signs out", async () => {
    const sofia = (await store.getPerson("sofia"))!;
    const t = cabinToken(SECRET, sofia);
    const form = (body: Record<string, string>) =>
      fetch(`${base}/c/${t}/settings`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ language: "es", humor: "full", ...body }).toString() });
    expect(decodeURIComponent((await form({ phone: "55 1234 5678" })).headers.get("location")!)).toContain("Ese número ya es de otro pasajero");
    await form({ phone: "55 7777 8888" });
    expect((await store.getPerson("sofia"))!.contactPhone).toBe("+525577778888");
    const out = await fetch(`${base}/logout`, { method: "POST", redirect: "manual" });
    expect(out.headers.get("set-cookie")).toMatch(/cl_cabin=; Path=\/; Max-Age=0/);
  });

  it("connects Telegram from the website, merging a chat that boarded on its own", async () => {
    const lupe = (await store.listPeople()).find((p) => p.contactPhone === "+525512345678")!;
    const code = chatLinkCode(SECRET, lupe);
    expect(verifyChatLink(SECRET, code)).toBe(lupe.id);
    expect(verifyChatLink(SECRET, `${lupe.id}_AAAAAAAAAAAAAAAA`)).toBeUndefined();
    expect(code.length + "link_".length).toBeLessThanOrEqual(64); // Telegram's /start payload limit

    // She had already written to the bot once (a fresh passenger with nothing on the manifest).
    await chat.handle({ phoneE164: "tg:777", text: "hola", profileName: "Lupe", channel: "telegram" });
    const stray = (await store.findPersonByPhone("tg:777"))!;
    expect(stray.id).not.toBe(lupe.id);

    const update = parseTelegramUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 777, type: "private" }, from: { first_name: "Lupe" }, text: `/start link_${code}` } });
    expect(update?.message?.buttonPayload).toBe(`link:${code}`);
    const { person } = await chat.handle(update!.message!);
    expect(person.id).toBe(lupe.id);
    expect((await store.getPerson(lupe.id))!.phoneE164).toBe("tg:777");
    expect(await store.getPerson(stray.id)).toBeUndefined();
    expect(heard.at(-1)).toMatch(/acaba de conectar este chat desde la página web/);

    const cabin = await (await fetch(`${base}/c/${cabinToken(SECRET, lupe)}`)).text();
    expect(cabin).not.toContain("start=link_"); // connected: plain chat link
    expect(cabin).toContain('href="https://t.me/CapitanBot"');
  });

  it("finds a web passenger when they first write on WhatsApp from the same number", async () => {
    const beto = (await store.listPeople()).find((p) => p.name === "Primo Beto")!;
    const { person } = await chat.handle({ phoneE164: "+525522223333", text: "hola", channel: "whatsapp" });
    expect(person.id).toBe(beto.id);
    expect((await store.getPerson(beto.id))!.phoneE164).toBe("+525522223333");
  });

  it("points the TV's QR codes at the website", async () => {
    const tv = await tvData({ store, key: tvKey(SECRET), botUsername: () => "CapitanBot", publicUrl: "https://ship.test", now: () => new Date(mx("2026-12-27", "19:30")) });
    expect(tv.joinText).toBe("Únete al crucero: ship.test");
    expect(tv.joinQr).toMatch(/^data:image\/png;base64,/);
  });
});
