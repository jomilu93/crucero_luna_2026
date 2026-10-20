import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder, buildPassengerContext } from "@crucero/agent";
import { MemoryStore, seedSample } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRouter } from "./http.js";
import { VoiceService, sentences, speakable } from "./voice.js";
import { tvKey } from "./web.js";

const SECRET = "voice-secret";
const NOW = new Date("2026-12-27T19:00:00Z");

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };
function fakeVendors() {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body });
    const reply = (o: unknown) => new Response(JSON.stringify(o), { status: url.includes("agents/create") ? 200 : 200 });
    if (url.includes("/v1/convai/secrets")) return reply({ type: "stored", name: body.name, secret_id: "sec_1" });
    if (url.includes("/v1/convai/agents/create")) return reply({ agent_id: "agent_1" });
    if (url.includes("/v1/convai/agents/") && (init.method ?? "GET") === "GET")
      return reply({
        conversation_config: { agent: { language: "es", prompt: { llm: "custom-llm", custom_llm: { url: "https://ship.test/v1/chat/completions" } } }, tts: { voice_id: "v1", model_id: "eleven_flash_v2_5" } },
        platform_settings: { overrides: { custom_llm_extra_body: false, conversation_config_override: { agent: { first_message: true, language: true } } } },
      });
    if (url.includes("/v1/convai/agents/")) return reply({});
    if (url.includes("/v1/convai/conversations?")) return reply({ conversations: [{ conversation_id: "conv_12345678", status: "failed", call_duration_secs: 0 }] });
    if (url.includes("/v1/convai/conversations/")) return reply({ transcript: [], metadata: { termination_reason: "Custom LLM extra body override is not allowed for this AI agent." } });
    if (url.includes("get-signed-url")) return reply({ signed_url: "wss://eleven/signed" });
    if (url.endsWith("/v1/avatars")) return new Response(JSON.stringify({ id: "avatar_1", imageUrl: body.imageUrl }), { status: 201 });
    if (url.endsWith("/v1/auth/session-token")) return reply({ sessionToken: "anam_session" });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

function setup() {
  const store = new MemoryStore({ now: () => NOW });
  seedSample(store);
  const heard: { name: string; text: string; channel?: string }[] = [];
  const responder: Responder = {
    respond: async (p, text, history, opts) => (heard.push({ name: p.name, text, channel: opts?.channel }), { text: "¡A la orden! 🎱 Bingo a las **8:00 pm** [a04]. Más aquí: https://x.y/z", history: [...history, { role: "user", content: text }] }),
  };
  const outbox = { send: async () => {}, sendTemplate: async () => {} };
  const chat = new ChatService(store, responder, outbox, { now: () => NOW });
  const vendors = fakeVendors();
  const voice = new VoiceService({ store, chat, secret: SECRET, publicUrl: "https://ship.test", cfg: { elevenLabsKey: "xi", anamKey: "an" }, fetch: vendors.fetchFn, now: () => NOW });
  return { store, voice, heard, ...vendors };
}

describe("speech helpers", () => {
  it("strips emoji, markdown, links and ids for the voice", () => {
    expect(speakable("¡A la orden! 🎱 Bingo a las **8:00 pm** [a04]. Más aquí: https://x.y/z")).toBe("¡A la orden! Bingo a las 8:00 pm. Más aquí:");
    expect(sentences("Hola. ¿Vas? ¡Sí! fin")).toEqual(["Hola. ", "¿Vas? ", "¡Sí! ", "fin"]);
  });

  it("adds spoken-reply rules on voice turns and shared-TV rules for the TV seat", async () => {
    const { store } = setup();
    const sofia = (await store.getPerson("sofia"))!;
    expect(await buildPassengerContext(store, { person: sofia, now: NOW, text: "hola", channel: "voice" })).toMatch(/live voice call/);
    expect(await buildPassengerContext(store, { person: sofia, now: NOW, text: "hola", channel: "telegram" })).not.toMatch(/live voice call/);
    const { voice } = setup();
    const tv = await voice.tvPassenger();
    expect(tv).toMatchObject({ name: "Puente (TV)", phoneE164: "tv:bridge", muted: true });
  });
});

describe("setup from the Admin tab", () => {
  it("creates the ElevenLabs agent with our server as its custom LLM, then updates it in place", async () => {
    const { voice, calls, store } = setup();
    expect(await voice.setupAgent()).toBe("agent_1");
    expect(calls[0]).toMatchObject({ url: "https://api.elevenlabs.io/v1/convai/secrets", method: "POST", body: { type: "new", value: voice.llmSecret() } });
    expect(calls[0].headers["xi-api-key"]).toBe("xi");
    const agent = calls[1].body;
    expect(agent.conversation_config.agent.prompt).toMatchObject({ llm: "custom-llm", custom_llm: { url: "https://ship.test/v1/chat/completions", api_key: { secret_id: "sec_1" } } });
    expect(agent.platform_settings.overrides.conversation_config_override.agent).toEqual({ first_message: true, language: true });
    expect(agent.platform_settings.overrides.custom_llm_extra_body).toBe(true);
    expect(agent.conversation_config.agent.prompt.prompt).toContain("[session:{{cl_session}}]");
    expect(agent.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders).toEqual({ cl_session: "none" });
    expect(await store.getSetting("voice_agent_id")).toBe("agent_1");
    await voice.setVoice("VoiceIdEspanol123");
    expect(calls.at(-1)).toMatchObject({ url: "https://api.elevenlabs.io/v1/convai/agents/agent_1", method: "PATCH" });
    expect(calls.at(-1)!.body.conversation_config.tts.voice_id).toBe("VoiceIdEspanol123");
  });

  it("turns a portrait into the Capitán's Anam avatar", async () => {
    const { voice, calls, store } = setup();
    expect((await voice.status()).ready).toBe(false);
    expect(await voice.useAvatar("https://media/captain.png")).toBe("avatar_1");
    expect(calls[0]).toMatchObject({ url: "https://api.anam.ai/v1/avatars", body: { displayName: "Capitán Lunáticus", imageUrl: "https://media/captain.png" } });
    expect(calls[0].headers.Authorization).toBe("Bearer an");
    await voice.setupAgent();
    expect(await voice.status()).toMatchObject({ ready: true, avatarId: "avatar_1", agentId: "agent_1", portraitUrl: "https://media/captain.png" });
    expect(await store.getSetting("captain_avatar_id")).toBe("avatar_1");
  });
});

describe("a call", () => {
  it("starts an Anam session wired to the ElevenLabs agent with a signed passenger session", async () => {
    const { voice, calls, store } = setup();
    await expect(voice.startCall((await store.getPerson("diego"))!)).rejects.toThrow(/not set up yet/);
    await voice.useAvatar("https://media/c.png");
    await voice.setupAgent();
    const diego = (await store.getPerson("diego"))!;
    expect(await voice.startCall(diego)).toEqual({ sessionToken: "anam_session" });
    const anam = calls.at(-1)!;
    expect(anam.url).toBe("https://api.anam.ai/v1/auth/session-token");
    expect(anam.body.personaConfig).toMatchObject({ avatarId: "avatar_1" });
    expect(anam.body.sessionOptions).toEqual({ videoWidth: 768, videoHeight: 1152, videoQuality: "high" }); // phone: portrait
    const el = anam.body.environment.elevenLabsAgentSettings;
    expect(el).toMatchObject({ signedUrl: "wss://eleven/signed", agentId: "agent_1" });
    expect(el.customLlmExtraBody).toBeUndefined(); // needs an override permission the agent may lack (1008)
    expect(el.dynamicVariables.cl_session).toBe(el.userId);
    expect(el.conversationConfigOverride.agent).toMatchObject({ language: "en", first_message: expect.stringMatching(/^Yiá sas, Diego! Capitán Lunáticus here, on the Bridge of the Moon of the Seas/) });
    expect((await voice.personFromSession(el.userId))?.id).toBe("diego");
    expect(await voice.personFromSession(el.userId.replace(/.$/, "x"))).toBeUndefined();
    await store.setSetting("paused", true);
    await expect(voice.startCall(diego)).rejects.toThrow(/paused/);
  });
});

describe("HTTP: custom LLM endpoint, TV pickup and the mic relay", () => {
  let base = "";
  const ctx = setup();
  const server = createServer();
  beforeAll(async () => {
    await ctx.voice.useAvatar("https://media/c.png");
    await ctx.voice.setupAgent();
    const router = createRouter({ store: ctx.store, chat: undefined as never, publicUrl: "http://ship.test", voice: ctx.voice, tv: { store: ctx.store, key: tvKey(SECRET), voice: ctx.voice, now: () => NOW }, webhooks: [] });
    server.on("request", (req, res) => void router(req, res));
    server.on("upgrade", (req, socket, head) => {
      if (!ctx.voice.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const complete = (auth: string, body: unknown) =>
    fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("answers ElevenLabs as the Capitán, streaming speakable sentences", async () => {
    expect((await complete("wrong", {})).status).toBe(401);
    const sofia = (await ctx.store.getPerson("sofia"))!;
    const res = await complete(ctx.voice.llmSecret(), {
      model: "capitan-lunatico",
      stream: true,
      messages: [{ role: "system", content: "x" }, { role: "assistant", content: "¡Ahoy!" }, { role: "user", content: "¿Qué hay hoy en la noche?" }],
      user_id: ctx.voice.sessionFor(sofia),
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const raw = await res.text();
    const content = raw
      .split("\n\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "")
      .join("");
    expect(content).toBe("¡A la orden! Bingo a las 8:00 pm. Más aquí:");
    expect(raw.trim().endsWith("data: [DONE]")).toBe(true);
    expect(ctx.heard.at(-1)).toEqual({ name: "Sofía Luna", text: "¿Qué hay hoy en la noche?", channel: "voice" });
    expect((await ctx.store.getConversation("sofia"))?.history.length).toBeGreaterThan(0); // shared with the chat
  });

  it("finds the passenger from the prompt's session variable when user_id is missing, and notes unknown callers", async () => {
    const diego = (await ctx.store.getPerson("diego"))!;
    const ask = (system: string) =>
      complete(ctx.voice.llmSecret(), { stream: true, messages: [{ role: "system", content: system }, { role: "user", content: "hola" }] }).then((r) => r.text());
    await ask(`You are Capitán Lunáticus. [session:${ctx.voice.sessionFor(diego)}]`);
    expect(ctx.heard.at(-1)).toMatchObject({ name: "Diego Luna", text: "hola" });
    expect(await ask("You are Capitán Lunáticus. [session:none]")).toContain("se cortó la señal");
    const diag = (await ctx.voice.diagnose()).join("\n");
    expect(diag).toMatch(/custom LLM hit without a valid passenger session/);
    expect(diag).toMatch(/custom LLM refused: wrong API key/);
  });

  it("diagnoses the live agent and the last conversation's end reason", async () => {
    ctx.voice.clientEvent("Sofía Luna", "closed", "CONNECTION_CLOSED_CODE_SERVER_CLOSED_CONNECTION", "agent ended");
    const lines = (await ctx.voice.diagnose()).join("\n");
    expect(lines).toMatch(/agent llm: custom-llm → https:\/\/ship\.test\/v1\/chat\/completions ✓/);
    expect(lines).toMatch(/extra body ✗ · first message ✓ · language ✓/);
    expect(lines).toMatch(/conversation 12345678 · failed · 0 s · 0 turns · ended: Custom LLM extra body override is not allowed/);
    expect(lines).toMatch(/call closed \(Sofía Luna\) SERVER_CLOSED_CONNECTION: agent ended/);
    const tvLog = await fetch(`${base}/tv/${tvKey(SECRET)}/log`, { method: "POST", body: new URLSearchParams({ event: "closed", code: "X", details: "tv detail" }) });
    expect(tvLog.status).toBe(200);
    expect((await ctx.voice.diagnose()).join("\n")).toMatch(/call closed \(TV\) X: tv detail/);
  });

  it("hands a phone's call to the TV once and relays the phone's mic to it", async () => {
    const valeria = (await ctx.store.getPerson("valeria"))!;
    const { relay } = await ctx.voice.requestTvCall(valeria);
    const poll = async () => (await (await fetch(`${base}/tv/${tvKey(SECRET)}/call.json`)).json()).call;
    const call = await poll();
    expect(call).toMatchObject({ sessionToken: "anam_session", name: "Valeria", relay });
    expect(await poll()).toBeNull();
    expect((await fetch(`${base}/tv/wrong/call.json`)).status).toBe(404);

    const wsBase = base.replace("http", "ws");
    const bad = new WebSocket(`${wsBase}${relay.replace(/k=[^&]+/, "k=nope")}&role=tv`);
    await new Promise((r) => bad.on("error", r).on("close", r));

    const tv = new WebSocket(`${wsBase}${relay}&role=tv`);
    const tvGot: (string | Buffer)[] = [];
    tv.on("message", (d, bin) => tvGot.push(bin ? (d as Buffer) : d.toString()));
    await new Promise((r) => tv.on("open", r));
    const phone = new WebSocket(`${wsBase}${relay}&role=phone`);
    const phoneGot: string[] = [];
    phone.on("message", (d) => phoneGot.push(d.toString()));
    await new Promise((r) => phone.on("open", r));
    phone.send(Buffer.from(new Int16Array([1, -1, 32767]).buffer));
    phone.send(JSON.stringify({ type: "end" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(tvGot[0]).toBe(JSON.stringify({ type: "peer", role: "phone", connected: true }));
    expect([...new Int16Array((tvGot[1] as Buffer).buffer.slice((tvGot[1] as Buffer).byteOffset, (tvGot[1] as Buffer).byteOffset + 6))]).toEqual([1, -1, 32767]);
    expect(tvGot[2]).toBe(JSON.stringify({ type: "end" }));
    expect(phoneGot[0]).toBe(JSON.stringify({ type: "peer", role: "tv", connected: true }));
    phone.close();
    tv.close();
  });

  it("starts a TV-mic call as the shared Bridge seat", async () => {
    const res = await fetch(`${base}/tv/${tvKey(SECRET)}/call`, { method: "POST" });
    expect(await res.json()).toEqual({ sessionToken: "anam_session" });
    expect(ctx.calls.at(-1)!.body.environment.elevenLabsAgentSettings.conversationConfigOverride.agent.first_message).toMatch(/^¡Yiá sas! Aquí el Capitán Lunáticus desde el Puente del Moon of the Seas/);
    expect(ctx.calls.at(-1)!.body.sessionOptions).toEqual({ videoWidth: 1152, videoHeight: 768, videoQuality: "high" }); // TV: landscape
    const page = await (await fetch(`${base}/tv/${tvKey(SECRET)}`)).text();
    expect(page).toContain("Hablar con el Capitán");
    expect(page).toContain("@anam-ai/js-sdk@4.27.1");
  });
});
