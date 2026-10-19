import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { ChatService, type Responder } from "@crucero/agent";
import { MemoryStore, seedSample, type Person } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "./http.js";
import { TwilioWhatsAppOutbox, parseTwilioInbound, templateFallbackText, validateTwilioSignature } from "./twilio.js";

const AUTH = "test-auth-token";
let base = "";
let server: ReturnType<typeof createServer>;
const sent: { to: string; text: string }[] = [];
let store: MemoryStore;

const responder: Responder = {
  respond: async (p, text, history) => ({ text: `hola ${p.name}`, history: [...history, { role: "user", content: text }, { role: "assistant", content: "x" }] }),
};

beforeAll(async () => {
  store = new MemoryStore();
  seedSample(store);
  const outbox = { send: async (to: Person | "everyone", text: string) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }) };
  const chat = new ChatService(store, responder, outbox);
  server = createServer((req, res) => {
    void createRouter({ store, chat, publicUrl: base || "http://localhost", twilioAuthToken: AUTH })(req, res);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

function sign(url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", AUTH).update(data).digest("base64");
}

describe("twilio helpers", () => {
  it("validates signatures", () => {
    const params = { From: "whatsapp:+15550000001", Body: "hola" };
    const url = "https://crucero.example/webhooks/twilio";
    expect(validateTwilioSignature(AUTH, url, params, sign(url, params))).toBe(true);
    expect(validateTwilioSignature(AUTH, url, params, "nope")).toBe(false);
    expect(validateTwilioSignature(AUTH, url, params, undefined)).toBe(false);
  });
  it("parses WhatsApp webhooks including buttons and media", () => {
    expect(parseTwilioInbound({ From: "whatsapp:+15550000001", Body: " hola ", ProfileName: "Sofi", NumMedia: "0" })).toEqual({
      phoneE164: "+15550000001",
      text: "hola",
      profileName: "Sofi",
      buttonPayload: undefined,
      mediaUrl: undefined,
      channel: "whatsapp",
    });
    expect(parseTwilioInbound({ From: "whatsapp:+1555", Body: "Ver mi día", ButtonPayload: "ver_mi_dia" })?.buttonPayload).toBe("ver_mi_dia");
    expect(parseTwilioInbound({ From: "whatsapp:+1555", Body: "", NumMedia: "1", MediaUrl0: "https://m/1.jpg" })?.mediaUrl).toBe("https://m/1.jpg");
    expect(parseTwilioInbound({ From: "+1555", Body: "sms" })).toBeUndefined();
  });
  it("sends free-form and template messages with the right REST shape", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response("{}", { status: 201 });
    }) as typeof fetch;
    const outbox = new TwilioWhatsAppOutbox(
      { accountSid: "AC123", apiKeySid: "SK1", apiKeySecret: "s3cret", from: "whatsapp:+14155238886", templates: { morning_knock: "HX999" }, fetch: fakeFetch },
      () => store.listPeople(),
    );
    const sofia = (await store.getPerson("sofia"))!;
    await outbox.send(sofia, "¡Ahoy!", { mediaUrl: "https://f/flyer.png" });
    await outbox.sendTemplate(sofia, "morning_knock", { "1": "Sofía", "2": "Gala Night", "3": "2" });
    await outbox.sendTemplate(sofia, "activity_reminder", { "1": "30", "2": "🧘 Yoga", "3": "7:00 am", "4": "Lido Deck" });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("SK1:s3cret").toString("base64")}`);
    const b0 = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
    expect(b0).toEqual({ From: "whatsapp:+14155238886", To: "whatsapp:+15550000001", Body: "¡Ahoy!", MediaUrl: "https://f/flyer.png" });
    const b1 = Object.fromEntries(new URLSearchParams(String(calls[1].init.body)));
    expect(b1.ContentSid).toBe("HX999");
    expect(JSON.parse(b1.ContentVariables)).toEqual({ "1": "Sofía", "2": "Gala Night", "3": "2" });
    const b2 = Object.fromEntries(new URLSearchParams(String(calls[2].init.body)));
    expect(b2.Body).toBe(templateFallbackText("activity_reminder", { "1": "30", "2": "🧘 Yoga", "3": "7:00 am", "4": "Lido Deck" }));
    await outbox.send("everyone", "Aviso");
    expect(calls.length).toBe(3 + 5); // 5 passengers have phones
  });
  it("surfaces Twilio errors", async () => {
    const fakeFetch = (async () => new Response('{"code":63016}', { status: 400 })) as unknown as typeof fetch;
    const outbox = new TwilioWhatsAppOutbox({ accountSid: "AC", apiKeySid: "SK", apiKeySecret: "x", from: "whatsapp:+1", fetch: fakeFetch }, () => store.listPeople());
    await expect(outbox.send((await store.getPerson("sofia"))!, "x")).rejects.toThrow(/Twilio 400: .*63016/);
  });
});

describe("http router", () => {
  it("serves health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  it("rejects unsigned webhooks and accepts signed ones, replying asynchronously", async () => {
    const params = { From: "whatsapp:+15550000001", Body: "hola capitán", ProfileName: "Sofía" };
    const body = new URLSearchParams(params).toString();
    const url = `${base}/webhooks/twilio`;
    const bad = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    expect(bad.status).toBe(403);
    const good = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sign(url, params) }, body });
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("<Response/>");
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([{ to: "sofia", text: "hola Sofía Luna" }]);
  });
  it("serves a passenger calendar by token and 404s otherwise", async () => {
    const res = await fetch(`${base}/cal/tok_sofia.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/calendar/);
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
    expect((await fetch(`${base}/cal/nope.ics`)).status).toBe(404);
  });
});
