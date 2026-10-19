import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder } from "@crucero/agent";
import { MemoryStore, seedSample, shipDate, type Person } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "./http.js";
import { MetaWhatsAppOutbox, buttonTitle, parseMetaWebhook, validateMetaSignature, waIdToE164 } from "./meta.js";

const APP_SECRET = "app-secret";
const VERIFY = "crucero-verify-123";

function webhookBody(messages: unknown[], contacts: unknown[] = [{ wa_id: "15550000001", profile: { name: "Sofía" } }], phoneNumberId = "PNID") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: phoneNumberId }, contacts, messages } }] }],
  };
}

describe("meta helpers", () => {
  it("normalizes wa_ids", () => {
    expect(waIdToE164("15550000001")).toBe("+15550000001");
    expect(waIdToE164("5215512345678")).toBe("+525512345678"); // legacy Mexican mobile "1"
    expect(waIdToE164("525512345678")).toBe("+525512345678");
    expect(waIdToE164("5491112345678")).toBe("+541112345678");
  });
  it("validates X-Hub-Signature-256", () => {
    const raw = JSON.stringify({ a: 1 });
    const sig = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    expect(validateMetaSignature(APP_SECRET, raw, sig)).toBe(true);
    expect(validateMetaSignature(APP_SECRET, raw + " ", sig)).toBe(false);
    expect(validateMetaSignature(APP_SECRET, raw, "sha1=abc")).toBe(false);
    expect(validateMetaSignature(APP_SECRET, raw, undefined)).toBe(false);
  });
  it("parses text, template buttons, interactive replies, media, audio and statuses", () => {
    const parsed = parseMetaWebhook(
      webhookBody([
        { from: "15550000001", id: "wamid.1", timestamp: "1", type: "text", text: { body: " hola " } },
        { from: "15550000001", id: "wamid.2", timestamp: "1", type: "button", button: { payload: "ver_mi_dia", text: "Ver mi día" } },
        { from: "15550000001", id: "wamid.3", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "signup:a04", title: "🎱 Bingo" } } },
        { from: "15550000001", id: "wamid.4", timestamp: "1", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "mira" } },
        { from: "15550000001", id: "wamid.5", timestamp: "1", type: "audio", audio: { id: "AUD1" } },
        { from: "15550000001", id: "wamid.6", timestamp: "1", type: "sticker", sticker: { id: "S" } },
      ]),
    );
    expect(parsed.messages.map((m) => [m.messageId, m.text, m.buttonPayload, m.mediaUrl])).toEqual([
      ["wamid.1", "hola", undefined, undefined],
      ["wamid.2", "Ver mi día", "ver_mi_dia", undefined],
      ["wamid.3", "🎱 Bingo", "signup:a04", undefined],
      ["wamid.4", "mira", undefined, "meta-media://MEDIA1"],
      ["wamid.5", expect.stringMatching(/nota de voz/), undefined, "meta-media://AUD1"],
      ["wamid.6", expect.stringMatching(/tipo sticker/), undefined, undefined],
    ]);
    expect(parsed.messages[0].profileName).toBe("Sofía");
    expect(parsed.messages[0].phoneE164).toBe("+15550000001");

    const statusOnly = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.9", status: "read", recipient_id: "1555" }] } }] }],
    });
    expect(statusOnly.messages).toEqual([]);
    expect(statusOnly.statuses).toEqual([{ id: "wamid.9", status: "read", recipient: "1555" }]);
    const failed = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "wamid.8", status: "failed", recipient_id: "1555", errors: [{ code: 131047, title: "Re-engagement message" }] }] } }] }],
    });
    expect(failed.statuses[0].error).toBe("131047 Re-engagement message");
    expect(parseMetaWebhook({ object: "page" }).messages).toEqual([]);
  });
  it("truncates button titles to 20 chars", () => {
    expect(buttonTitle("🧘 Sunrise yoga con Sofía")).toHaveLength(20);
    expect(buttonTitle("Bingo")).toBe("Bingo");
  });
});

describe("MetaWhatsAppOutbox", () => {
  const store = new MemoryStore();
  seedSample(store);
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).Authorization });
    return new Response('{"messages":[{"id":"wamid.x"}]}', { status: 200 });
  }) as typeof fetch;

  it("sends text, images, interactive buttons and templates in the Graph API shape", async () => {
    const outbox = new MetaWhatsAppOutbox(
      { accessToken: "TOKEN", phoneNumberId: "PNID", templates: { morning_knock: "morning_knock" }, templateLanguage: "es_MX", fetch: fakeFetch },
      () => store.listPeople(),
    );
    const carmen = (await store.getPerson("carmen"))!; // +525550000003
    await outbox.send(carmen, "¡Ahoy!");
    await outbox.send(carmen, "Tu flyer", { mediaUrl: "https://f/flyer.png" });
    await outbox.sendInteractive(carmen, "¿Te apunto?", [{ id: "signup:a04", title: "🎱 Bingo Lunático" }]);
    await outbox.sendTemplate(carmen, "morning_knock", { "1": "Carmen", "2": "Gala Night", "3": "1" });
    await outbox.sendTemplate(carmen, "activity_reminder", { "1": "30", "2": "🎱 Bingo", "3": "8:00 pm", "4": "Gran Salón" }); // no template → text

    expect(calls[0].url).toBe("https://graph.facebook.com/v22.0/PNID/messages");
    expect(calls[0].auth).toBe("Bearer TOKEN");
    expect(calls[0].body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "525550000003", type: "text", text: { preview_url: false, body: "¡Ahoy!" } });
    expect(calls[1].body.type).toBe("image");
    expect(calls[1].body.image).toEqual({ link: "https://f/flyer.png", caption: "Tu flyer" });
    expect(calls[2].body.interactive).toEqual({
      type: "button",
      body: { text: "¿Te apunto?" },
      action: { buttons: [{ type: "reply", reply: { id: "signup:a04", title: "🎱 Bingo Lunático" } }] },
    });
    const tpl = calls[3].body.template as { name: string; language: { code: string }; components: unknown[] };
    expect(tpl.name).toBe("morning_knock");
    expect(tpl.language.code).toBe("es_MX");
    expect(tpl.components[0]).toEqual({ type: "body", parameters: [{ type: "text", text: "Carmen" }, { type: "text", text: "Gala Night" }, { type: "text", text: "1" }] });
    expect(tpl.components[1]).toEqual({ type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "ver_mi_dia" }] });
    expect(tpl.components).toHaveLength(4);
    expect(calls[4].body.type).toBe("text");
    expect((calls[4].body.text as { body: string }).body).toMatch(/^⏰ En 30 min: 🎱 Bingo/);
  });
  it("falls back to text + buttons for the morning knock when no template is approved", async () => {
    calls.length = 0;
    const outbox = new MetaWhatsAppOutbox({ accessToken: "T", phoneNumberId: "P", fetch: fakeFetch }, () => store.listPeople());
    await outbox.sendTemplate((await store.getPerson("sofia"))!, "morning_knock", { "1": "Sofía", "2": "Inocentes", "3": "1" });
    expect(calls.map((c) => c.body.type)).toEqual(["text", "interactive"]);
  });
  it("surfaces Graph API errors", async () => {
    const failing = (async () => new Response('{"error":{"code":131047,"message":"Re-engagement message"}}', { status: 400 })) as unknown as typeof fetch;
    const outbox = new MetaWhatsAppOutbox({ accessToken: "T", phoneNumberId: "P", fetch: failing }, () => store.listPeople());
    await expect(outbox.send((await store.getPerson("sofia"))!, "x")).rejects.toThrow(/Meta 400: .*131047/);
  });
});

describe("meta webhook routes", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  const sent: { to: string; text: string }[] = [];
  const buttons: { to: string; body: string; ids: string[] }[] = [];
  const store = new MemoryStore();
  seedSample(store);
  const seenTexts: string[] = [];
  const responder: Responder = {
    respond: async (p, text, history) => {
      seenTexts.push(text);
      return { text: `hola ${p.name}`, history: [...history, { role: "user", content: text }, { role: "assistant", content: "x" }] };
    },
  };

  beforeAll(async () => {
    const outbox = {
      send: async (to: Person | "everyone", text: string) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }),
      sendInteractive: async (to: Person, body: string, b: { id: string }[]) => void buttons.push({ to: to.id, body, ids: b.map((x) => x.id) }),
    };
    const chat = new ChatService(store, responder, outbox);
    // One router for the whole suite, as in production, so the retry de-duplication set is shared.
    const router = createRouter({ store, chat, publicUrl: "http://localhost", metaVerifyToken: VERIFY, metaAppSecret: APP_SECRET, metaPhoneNumberId: "PNID" });
    server = createServer((req, res) => void router(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (body: unknown, sign = true) => {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sign) headers["X-Hub-Signature-256"] = "sha256=" + createHmac("sha256", APP_SECRET).update(raw).digest("hex");
    return fetch(`${base}/webhooks/meta`, { method: "POST", headers, body: raw });
  };

  it("answers the verification handshake", async () => {
    const ok = await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("12345");
    expect((await fetch(`${base}/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status).toBe(403);
  });
  it("rejects bad signatures, acks good ones, replies once per message id", async () => {
    expect((await post(webhookBody([{ from: "15550000001", id: "wamid.a", type: "text", text: { body: "hola" } }]), false)).status).toBe(403);
    const body = webhookBody([{ from: "15550000001", id: "wamid.a", type: "text", text: { body: "hola capitán" } }]);
    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200); // Meta retry: same id, no second reply
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([{ to: "sofia", text: "hola Sofía Luna" }]);
  });
  it("turns a sign-up button into a Capitán request and releases a parked morning with buttons", async () => {
    sent.length = 0;
    await store.markDelivered("morning", `sofia:${shipDate(new Date())}`, { full_message: "Buenos días…", offered_activity_ids: ["a04", "a99"] });
    await post(webhookBody([{ from: "15550000001", id: "wamid.b", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "signup:a04", title: "🎱 Bingo" } } }]));
    await new Promise((r) => setTimeout(r, 50));
    expect(seenTexts.at(-1)).toBe("[Botón] Apúntame a la actividad a04.");
    expect(sent.map((s) => s.text)).toEqual(["Buenos días…", "hola Sofía Luna"]);
    expect(buttons).toEqual([{ to: "sofia", body: "¿Te apunto a alguna?", ids: ["signup:a04"] }]); // a99 does not exist → dropped
  });
  it("ignores messages to other numbers in the same WABA", async () => {
    sent.length = 0;
    const r = await post(webhookBody([{ from: "15550000001", id: "wamid.other", type: "text", text: { body: "hola empresa" } }], undefined, "OTHER_NUMBER"));
    expect(r.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
  });
  it("ignores status-only webhooks", async () => {
    sent.length = 0;
    const r = await post({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { statuses: [{ id: "w", status: "delivered", recipient_id: "1" }] } }] }] });
    expect(r.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual([]);
  });
});
