import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder } from "@crucero/agent";
import { MemoryStore, seedSample, type Person } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouter } from "./http.js";
import { TelegramOutbox, parseTelegramUpdate, telegramWebhookSecret, tgAddress, toTelegramHtml } from "./telegram.js";

const privateChat = { id: 4242, type: "private" };
const from = { id: 4242, first_name: "Sofía", last_name: "Luna" };

describe("telegram parsing", () => {
  it("turns text, /start, buttons, voice notes and photos into inbound messages", () => {
    expect(parseTelegramUpdate({ update_id: 1, message: { message_id: 1, from, chat: privateChat, text: " hola capitán " } })?.message).toEqual({
      phoneE164: "tg:4242",
      profileName: "Sofía Luna",
      text: "hola capitán",
      channel: "telegram",
    });
    expect(parseTelegramUpdate({ update_id: 2, message: { message_id: 2, from, chat: privateChat, text: "/start abc" } })?.message?.text).toBe("Hola Capitán");
    const tap = parseTelegramUpdate({ update_id: 3, callback_query: { id: "cb1", from, data: "signup:a04", message: { message_id: 3, chat: privateChat } } });
    expect(tap?.callbackQueryId).toBe("cb1");
    expect(tap?.message).toMatchObject({ phoneE164: "tg:4242", buttonPayload: "signup:a04" });
    expect(parseTelegramUpdate({ update_id: 4, message: { message_id: 4, from, chat: privateChat, voice: {} } })?.message?.text).toMatch(/nota de voz/);
    expect(parseTelegramUpdate({ update_id: 5, message: { message_id: 5, from, chat: privateChat, photo: [{}], caption: "mira" } })?.message).toMatchObject({ text: "mira", mediaUrl: "telegram-media://5" });
  });
  it("ignores groups and non-updates", () => {
    expect(parseTelegramUpdate({ update_id: 6, message: { message_id: 6, from, chat: { id: -1, type: "group" }, text: "hola" } })?.message).toBeUndefined();
    expect(parseTelegramUpdate({ hello: "world" })).toBeUndefined();
  });
  it("converts the Capitán's markdown to Telegram HTML, escaping the rest", () => {
    expect(toTelegramHtml("**Bingo** a las 8 <pm> & *Ding-dong* _ojo_")).toBe("<b>Bingo</b> a las 8 &lt;pm&gt; &amp; <b>Ding-dong</b> <i>ojo</i>");
    expect(toTelegramHtml("2 * 3 = 6, snake_case_name")).toBe("2 * 3 = 6, snake_case_name");
  });
  it("derives a stable webhook secret Telegram accepts", () => {
    expect(telegramWebhookSecret("123:ABC")).toMatch(/^[a-f0-9]{48}$/);
    expect(telegramWebhookSecret("123:ABC")).toBe(telegramWebhookSecret("123:ABC"));
  });
});

describe("telegram outbox", () => {
  const store = new MemoryStore();
  seedSample(store);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let failNextParse = false;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    if (failNextParse && body.parse_mode) {
      failNextParse = false;
      return new Response('{"ok":false,"description":"Bad Request: can\'t parse entities"}', { status: 400 });
    }
    return new Response('{"ok":true,"result":{}}', { status: 200 });
  }) as unknown as typeof fetch;
  const outbox = new TelegramOutbox({ botToken: "123:ABC", fetch: fakeFetch }, () => store.listPeople());

  it("sends HTML messages and inline buttons to tg: passengers only", async () => {
    await store.updatePerson("sofia", { phoneE164: tgAddress(4242) });
    const sofia = (await store.getPerson("sofia"))!;
    await outbox.send(sofia, "**Hola**");
    expect(calls[0].url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "4242", text: "<b>Hola</b>", parse_mode: "HTML" });
    await outbox.sendInteractive(sofia, "¿Te apunto?", [{ id: "signup:a04", title: "🎱 Bingo" }]);
    expect(calls[1].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "🎱 Bingo", callback_data: "signup:a04" }]] });
    calls.length = 0;
    await outbox.send((await store.getPerson("diego"))!, "hola"); // WhatsApp-boarded passenger: skipped
    await outbox.send("everyone", "aviso");
    expect(calls.map((c) => c.body.chat_id)).toEqual(["4242"]);
  });
  it("falls back to plain text when Telegram rejects the markup", async () => {
    calls.length = 0;
    failNextParse = true;
    await outbox.send((await store.getPerson("sofia"))!, "*raro");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ chat_id: "4242", link_preview_options: { is_disabled: true }, text: "*raro" });
  });
});

describe("telegram webhook route", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  const SECRET = telegramWebhookSecret("123:ABC");
  const store = new MemoryStore();
  const sent: { to: string; text: string }[] = [];
  const answered: string[] = [];
  const responder: Responder = {
    respond: async (p, text, history) => ({ text: `hola ${p.name}`, history: [...history, { role: "user", content: text }, { role: "assistant", content: "x" }] }),
  };

  beforeAll(async () => {
    const outbox = { send: async (to: Person | "everyone", text: string) => void sent.push({ to: to === "everyone" ? "everyone" : to.phoneE164!, text }) };
    const chat = new ChatService(store, responder, outbox);
    const router = createRouter({
      store,
      chat,
      publicUrl: "http://localhost",
      telegramSecret: SECRET,
      answerTelegramCallback: async (id) => void answered.push(id),
      webhooks: ["telegram"],
    });
    server = createServer((req, res) => void router(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (body: unknown, secret: string | undefined = SECRET) =>
    fetch(`${base}/webhooks/telegram`, { method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) }, body: JSON.stringify(body) });

  it("rejects a wrong secret, boards a new passenger, and replies once per update", async () => {
    const update = { update_id: 10, message: { message_id: 1, from, chat: privateChat, text: "/start" } };
    expect((await post(update, "wrong")).status).toBe(403);
    expect((await post(update)).status).toBe(200);
    expect((await post(update)).status).toBe(200); // Telegram retry: same update_id, no second reply
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toEqual([{ to: "tg:4242", text: "hola Sofía Luna" }]);
    expect((await store.findPersonByPhone("tg:4242"))?.name).toBe("Sofía Luna");
  });
  it("acknowledges button taps", async () => {
    await post({ update_id: 11, callback_query: { id: "cb9", from, data: "ver_mi_dia", message: { message_id: 2, chat: privateChat } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(answered).toEqual(["cb9"]);
  });
  it("keeps parked channels' webhooks closed", async () => {
    expect((await fetch(`${base}/webhooks/meta`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${base}/webhooks/twilio`, { method: "POST", body: "" })).status).toBe(404);
  });
});
