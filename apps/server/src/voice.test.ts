import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ChatService, type Responder, buildPassengerContext } from "@crucero/agent";
import { MemoryStore, seedSample } from "@crucero/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRouter } from "./http.js";
import { phoneBridgePage, tvBridge } from "./bridge.js";
import { GREETING_PAUSE, VoiceService, greetingFor, sentences, speakable, stillThere } from "./voice.js";
import { cabinToken, tvKey } from "./web.js";

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

function setup(opts: { delayMs?: number; bufferAfterMs?: number } = {}) {
  const store = new MemoryStore({ now: () => NOW });
  seedSample(store);
  const heard: { name: string; text: string; channel?: string }[] = [];
  const responder: Responder = {
    respond: async (p, text, history, o) => (await new Promise((r) => setTimeout(r, opts.delayMs ?? 0)), heard.push({ name: p.name, text, channel: o?.channel }), { text: "¡A la orden! 🎱 Bingo a las **8:00 pm** [a04]. Más aquí: https://x.y/z", history: [...history, { role: "user", content: text }] }),
  };
  const outbox = { send: async () => {}, sendTemplate: async () => {} };
  const chat = new ChatService(store, responder, outbox, { now: () => NOW });
  const vendors = fakeVendors();
  const voice = new VoiceService({ store, chat, secret: SECRET, publicUrl: "https://ship.test", cfg: { elevenLabsKey: "xi", anamKey: "an" }, fetch: vendors.fetchFn, now: () => NOW, bufferAfterMs: opts.bufferAfterMs });
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
    expect(agent.conversation_config.turn).toMatchObject({ turn_timeout: 8, silence_end_call_timeout: 45 });
    expect(agent.conversation_config.conversation).toEqual({ max_duration_seconds: 3600 }); // not ElevenLabs's 10 min
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
    expect(anam.body.personaConfig).toMatchObject({ avatarId: "avatar_1", maxSessionLengthSeconds: 3600 }); // the caller hangs up, not a timer
    expect(anam.body.sessionOptions).toEqual({ videoWidth: 768, videoHeight: 1152, videoQuality: "high" }); // phone: portrait
    const el = anam.body.environment.elevenLabsAgentSettings;
    expect(el).toMatchObject({ signedUrl: "wss://eleven/signed", agentId: "agent_1" });
    expect(el.customLlmExtraBody).toBeUndefined(); // needs an override permission the agent may lack (1008)
    expect(el.dynamicVariables.cl_session).toBe(el.userId);
    // The personal greeting, after a silent pause so the avatar's audio has reached the phone.
    expect(el.conversationConfigOverride.agent).toEqual({ language: "en", first_message: `<break time="2.5s" /> Yiá sas, Diego! Capitán Lunáticus here, on the Bridge of the Moonshine of the Seas. What can I do for you?` });
    expect((await voice.personFromSession(el.userId))?.id).toBe("diego");
    expect(await voice.personFromSession(el.userId.replace(/.$/, "x"))).toBeUndefined();
    await store.setSetting("paused", true);
    await expect(voice.startCall(diego)).rejects.toThrow(/paused/);
  });
});

describe("a slow turn", () => {
  it("speaks a buffer phrase first, then the answer, with no comment lines in the stream", async () => {
    const { voice, store } = setup({ delayMs: 80, bufferAfterMs: 10 });
    const sofia = (await store.getPerson("sofia"))!;
    const req = { headers: { authorization: `Bearer ${voice.llmSecret()}` } } as never;
    let raw = "";
    const res = { on: () => res, destroyed: false, writableFinished: false, writeHead: () => res, write: (s: string) => ((raw += s), true), end: (s: string) => (raw += s) } as never;
    await voice.completions(req, res, JSON.stringify({ messages: [{ role: "user", content: "¿qué hay hoy?" }], user_id: voice.sessionFor(sofia) }));
    const deltas = raw.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "");
    expect(deltas[0]).toBe("");
    expect(deltas[1]).toBe("Déjame revisar... ");
    expect(deltas.slice(2).join("")).toBe("¡A la orden! Bingo a las 8:00 pm. Más aquí:");
    expect(raw).not.toMatch(/^:/m);
    expect((await voice.diagnose()).join("\n")).toMatch(/Sofía Luna \(0\.\d s\): ¿qué hay hoy\?/);
  });

  it("survives ElevenLabs cancelling a turn mid-way (the caller kept talking) and does not save it", async () => {
    const { voice, store } = setup({ delayMs: 150, bufferAfterMs: 20 });
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => void voice.completions(req, res, body));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `http://localhost:${(server.address() as AddressInfo).port}/v1/chat/completions`;
    const sofia = (await store.getPerson("sofia"))!;
    const ask = (content: string, signal?: AbortSignal) =>
      fetch(url, { method: "POST", signal, headers: { Authorization: `Bearer ${voice.llmSecret()}` }, body: JSON.stringify({ messages: [{ role: "user", content }], user_id: voice.sessionFor(sofia) }) });
    const abort = new AbortController();
    const first = await ask("quiero apuntarme a", abort.signal);
    const reader = first.body!.getReader();
    await reader.read(); // the role chunk arrives, then the caller keeps talking
    abort.abort();
    await new Promise((r) => setTimeout(r, 250)); // the cancelled turn finishes in the background
    expect(await store.getConversation("sofia")).toBeUndefined();
    const second = await (await ask("quiero apuntarme al bingo de hoy")).text(); // the server is still up
    expect(second).toContain("data: [DONE]");
    expect((await store.getConversation("sofia"))?.history.length).toBeGreaterThan(0);
    expect((await voice.diagnose()).join("\n")).toMatch(/Sofía Luna kept talking; turn cancelled by ElevenLabs after 0\.\d s \(not saved\): quiero apuntarme a/);
    server.close();
  });

  it("answers a fast turn without the buffer phrase", async () => {
    const { voice, store } = setup();
    const req = { headers: { authorization: `Bearer ${voice.llmSecret()}` } } as never;
    let raw = "";
    const res = { on: () => res, destroyed: false, writableFinished: false, writeHead: () => res, write: (s: string) => ((raw += s), true), end: (s: string) => (raw += s) } as never;
    await voice.completions(req, res, JSON.stringify({ messages: [{ role: "user", content: "hola" }], user_id: voice.sessionFor((await store.getPerson("diego"))!) }));
    expect(raw).not.toContain("Let me check");
  });
});

describe("HTTP: custom LLM endpoint, TV pickup and the mic relay", () => {
  let base = "";
  const ctx = setup();
  const server = createServer();
  beforeAll(async () => {
    await ctx.voice.useAvatar("https://media/c.png");
    await ctx.voice.setupAgent();
    const web = { store: ctx.store, outbox: { send: async () => {} }, publicUrl: "http://ship.test", secret: SECRET, voice: ctx.voice, now: () => NOW };
    const router = createRouter({ store: ctx.store, chat: undefined as never, publicUrl: "http://ship.test", voice: ctx.voice, web, tv: { store: ctx.store, key: tvKey(SECRET), voice: ctx.voice, now: () => NOW }, webhooks: [] });
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

  it("answers at any path ending in /chat/completions and notes POSTs nobody answers", async () => {
    const sofia = (await ctx.store.getPerson("sofia"))!;
    const body = JSON.stringify({ stream: true, messages: [{ role: "user", content: "hola" }], user_id: ctx.voice.sessionFor(sofia) });
    const headers = { Authorization: `Bearer ${ctx.voice.llmSecret()}`, "Content-Type": "application/json" };
    const doubled = await fetch(`${base}/v1/chat/completions/chat/completions`, { method: "POST", headers, body });
    expect(doubled.status).toBe(200);
    expect(await doubled.text()).toContain("data: [DONE]");
    expect((await fetch(`${base}/v1/responses`, { method: "POST", headers, body })).status).toBe(404);
    const diag = (await ctx.voice.diagnose()).join("\n");
    expect(diag).toMatch(/custom LLM called at \/v1\/chat\/completions\/chat\/completions/);
    expect(diag).toMatch(/custom LLM hit for Sofía Luna: 1 messages, heard "hola"/);
    expect(diag).toMatch(/POST \/v1\/responses → 404/);
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
    for (let i = 0; i < 25; i++) ctx.voice.clientEvent("Sofía Luna", "closed", "CONNECTION_CLOSED_CODE_NORMAL", "");
    const burst = (await ctx.voice.diagnose()).filter((l) => l.startsWith("event "));
    expect(burst[0]).toMatch(/call closed \(Sofía Luna\) NORMAL ×25$/);
    expect(burst[1]).toMatch(/agent ended/);
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

  it("frames the avatar for the caller's screen: portrait on a phone, landscape on a laptop", async () => {
    const t = cabinToken(SECRET, (await ctx.store.getPerson("sofia"))!);
    const call = (shape?: string) =>
      fetch(`${base}/c/${t}/bridge/session`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: shape ? `shape=${shape}` : "" });
    expect((await call("portrait")).status).toBe(200);
    expect(ctx.calls.at(-1)!.body.sessionOptions).toMatchObject({ videoWidth: 768, videoHeight: 1152 });
    await call("landscape");
    expect(ctx.calls.at(-1)!.body.sessionOptions).toMatchObject({ videoWidth: 1152, videoHeight: 768 });
    await call();
    expect(ctx.calls.at(-1)!.body.sessionOptions).toMatchObject({ videoWidth: 768, videoHeight: 1152 });
    const page = await (await fetch(`${base}/c/${t}/bridge`)).text();
    expect(page).toContain('shape: innerWidth > innerHeight ? "landscape" : "portrait"');
    expect(page).toMatch(/@media \(min-aspect-ratio:1\/1\)\{[^}]*\}\.live video\{object-fit:contain\}/);
  });

  it("starts a TV-mic call as the shared Bridge seat", async () => {
    const res = await fetch(`${base}/tv/${tvKey(SECRET)}/call`, { method: "POST" });
    expect(await res.json()).toEqual({ sessionToken: "anam_session" });
    expect(ctx.calls.at(-1)!.body.environment.elevenLabsAgentSettings.conversationConfigOverride.agent.first_message).toBe(`${GREETING_PAUSE}¡Yiá sas! Aquí el Capitán Lunáticus desde el Puente del Moonshine of the Seas. ¿En qué te ayudo?`);
    expect(ctx.calls.at(-1)!.body.sessionOptions).toEqual({ videoWidth: 1152, videoHeight: 768, videoQuality: "high" }); // TV: landscape
    const page = await (await fetch(`${base}/tv/${tvKey(SECRET)}`)).text();
    expect(page).toContain("Hablar con el Capitán");
    expect(page).toContain("@anam-ai/js-sdk@4.27.1");
  });
});

describe("a dynamic conversation", () => {
  const fakeRes = () => {
    let raw = "";
    const res = { on: () => res, destroyed: false, writableFinished: false, writeHead: () => res, write: (s: string) => ((raw += s), true), end: (s: string) => (raw += s) };
    return { res: res as never, text: () => raw.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "").join("") };
  };

  it("carries every turn forward, across Telegram and the call, in one history", async () => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    const seen: { text: string; channel?: string; turns: number }[] = [];
    const responder: Responder = {
      respond: async (_p, text, history, o) => {
        seen.push({ text, channel: o?.channel, turns: history.length });
        return { text: `(${history.length}) ok`, history: [...history, { role: "user", content: text }, { role: "assistant", content: [{ type: "text", text: "ok" }] }] };
      },
    };
    const chat = new ChatService(store, responder, { send: async () => {}, sendTemplate: async () => {} }, { now: () => NOW });
    const voice = new VoiceService({ store, chat, secret: SECRET, publicUrl: "https://ship.test", cfg: {}, now: () => NOW });
    const sofia = (await store.getPerson("sofia"))!;
    await chat.handle({ phoneE164: sofia.phoneE164!, text: "¿qué hay hoy?", channel: "telegram" });
    const say = async (content: string) => {
      const out = fakeRes();
      await voice.completions({ headers: { authorization: `Bearer ${voice.llmSecret()}` } } as never, out.res, JSON.stringify({ messages: [{ role: "user", content }], user_id: voice.sessionFor(sofia) }));
      return out.text();
    };
    expect(await say("apúntame al bingo")).toBe("(2) ok");
    expect(await say("¿y quién más va?")).toBe("(4) ok");
    expect(seen).toEqual([
      { text: "¿qué hay hoy?", channel: "telegram", turns: 0 },
      { text: "apúntame al bingo", channel: "voice", turns: 2 },
      { text: "¿y quién más va?", channel: "voice", turns: 4 },
    ]);
  });

  it("forgets an interrupted turn that only talked, but remembers one that already acted", async () => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    let acted = false;
    const responder: Responder = {
      respond: async (_p, text, history) => ({
        text: "ok",
        history: [
          ...history,
          { role: "user", content: text },
          { role: "assistant", content: acted ? [{ type: "tool_use", id: "t1", name: "signup", input: { activity_id: "a04" } }] : [{ type: "text", text: "¿cuál?" }] },
          ...(acted ? [{ role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "Signed up" }] }] : []),
        ],
      }),
    };
    const chat = new ChatService(store, responder, { send: async () => {}, sendTemplate: async () => {} }, { now: () => NOW });
    const sofia = (await store.getPerson("sofia"))!;
    await chat.converse(sofia, "apúntame a", "voice", { keep: () => false });
    expect(await store.getConversation("sofia")).toBeUndefined();
    acted = true;
    await chat.converse(sofia, "apúntame al bingo", "voice", { keep: () => false });
    expect(JSON.stringify((await store.getConversation("sofia"))!.history)).toContain('"name":"signup"');
  });

  it("checks in when the caller goes quiet, gently, without calling Claude or saving anything", async () => {
    const { voice, store, heard } = setup();
    const sofia = (await store.getPerson("sofia"))!;
    const ask = async (messages: unknown[]) => {
      const out = fakeRes();
      await voice.completions({ headers: { authorization: `Bearer ${voice.llmSecret()}` } } as never, out.res, JSON.stringify({ messages, user_id: voice.sessionFor(sofia) }));
      return out.text();
    };
    const hi = { role: "assistant", content: "¡Ahoy, Sofía!" };
    expect(await ask([{ role: "system", content: "x" }, hi])).toBe("¿Sigues ahí, Sofía?");
    expect(await ask([hi, { role: "user", content: "hola" }, { role: "assistant", content: "¿Qué se te ofrece?" }])).toBe("¿Sigues ahí, Sofía?");
    expect(await ask([hi, { role: "user", content: "hola" }, { role: "assistant", content: "¿…?" }, { role: "assistant", content: "¿Sigues ahí, Sofía?" }])).toMatch(/^Aquí sigo en el Puente/);
    expect(await ask([hi, { role: "user", content: "  " }])).toBe("¿Sigues ahí, Sofía?");
    expect(heard).toEqual([]);
    expect(await store.getConversation("sofia")).toBeUndefined();
    expect(stillThere({ name: "Diego Luna", language: "en", phoneE164: "+1" }, 3)).toBe("I'll head back to the helm. Call me anytime!");
    expect(stillThere({ name: "Puente (TV)", language: "es", phoneE164: "tv:bridge" }, 1)).toBe("¿Sigues ahí?");
    expect(await ask([hi, { role: "user", content: "¿qué hay hoy?" }])).toContain("Bingo");
  });
});

describe("fillers and check-ins that respect a turn in progress", () => {
  const liveRes = () => {
    let raw = "";
    const handlers: Record<string, (() => void)[]> = {};
    const res = {
      destroyed: false,
      writableFinished: false,
      on: (ev: string, fn: () => void) => ((handlers[ev] ??= []).push(fn), res),
      writeHead: () => res,
      write: (s: string) => ((raw += s), true),
      end: (s: string) => ((raw += s), (res.writableFinished = true)),
    };
    const text = () => raw.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "").join("");
    const hangUp = () => {
      res.destroyed = true;
      for (const fn of handlers.close ?? []) fn();
    };
    return { res: res as never, text, hangUp };
  };
  const build = (opts: { delayMs: number; tool?: boolean; bufferAfterMs?: number }) => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    const responder: Responder = {
      respond: async (_p, text, history, o) => {
        if (opts.tool) o?.onToolStart?.("get_program");
        await new Promise((r) => setTimeout(r, opts.delayMs));
        return { text: "El bingo es a las ocho.", history: [...history, { role: "user", content: text }, { role: "assistant", content: [{ type: "text", text: "El bingo es a las ocho." }] }] };
      },
    };
    const chat = new ChatService(store, responder, { send: async () => {}, sendTemplate: async () => {} }, { now: () => NOW });
    const voice = new VoiceService({ store, chat, secret: SECRET, publicUrl: "https://ship.test", cfg: {}, now: () => NOW, bufferAfterMs: opts.bufferAfterMs });
    return { store, voice };
  };
  const req = (voice: VoiceService) => ({ headers: { authorization: `Bearer ${voice.llmSecret()}` } }) as never;

  it("says no filler on a quick answer, one when a lookup starts, and rotates the wording", async () => {
    const quick = build({ delayMs: 10 });
    const sofia = (await quick.store.getPerson("sofia"))!;
    const a = liveRes();
    await quick.voice.completions(req(quick.voice), a.res, JSON.stringify({ messages: [{ role: "user", content: "hola" }], user_id: quick.voice.sessionFor(sofia) }));
    expect(a.text()).toBe("El bingo es a las ocho.");

    const lookup = build({ delayMs: 30, tool: true, bufferAfterMs: 60_000 });
    const ask = async () => {
      const r = liveRes();
      await lookup.voice.completions(req(lookup.voice), r.res, JSON.stringify({ messages: [{ role: "user", content: "¿a qué hora es el bingo?" }], user_id: lookup.voice.sessionFor(sofia) }));
      return r.text();
    };
    const first = await ask();
    const second = await ask();
    expect(first).toBe("Déjame revisar... El bingo es a las ocho.");
    expect(second).toBe("A ver, un segundo... El bingo es a las ocho.");
  });

  it("answers the pending question when ElevenLabs re-engages during a lookup, instead of asking if you're still there", async () => {
    const { store, voice } = build({ delayMs: 150, tool: true, bufferAfterMs: 60_000 });
    const sofia = (await store.getPerson("sofia"))!;
    const q = { role: "user", content: "¿a qué hora es el bingo?" };
    const a = liveRes();
    const working = voice.completions(req(voice), a.res, JSON.stringify({ messages: [q], user_id: voice.sessionFor(sofia) }));
    await new Promise((r) => setTimeout(r, 40));
    expect(a.text()).toBe("Déjame revisar... ");
    a.hangUp(); // ElevenLabs's turn timeout: it drops this request and asks again with the filler as our last line
    const b = liveRes();
    await voice.completions(req(voice), b.res, JSON.stringify({ messages: [q, { role: "assistant", content: "Déjame revisar..." }], user_id: voice.sessionFor(sofia) }));
    await working;
    expect(b.text()).toBe("El bingo es a las ocho.");
    expect(b.text()).not.toContain("Sigues");
    expect((await store.getConversation("sofia"))?.history.length).toBe(2); // heard after all, so remembered
  });

  it("keeps an answer that finished while nobody was listening for the next request", async () => {
    const { store, voice } = build({ delayMs: 20 });
    const sofia = (await store.getPerson("sofia"))!;
    const q = { role: "user", content: "¿a qué hora es el bingo?" };
    const a = liveRes();
    const working = voice.completions(req(voice), a.res, JSON.stringify({ messages: [q], user_id: voice.sessionFor(sofia) }));
    a.hangUp();
    await working;
    const b = liveRes();
    await voice.completions(req(voice), b.res, JSON.stringify({ messages: [q, { role: "assistant", content: "Ahorita te digo..." }], user_id: voice.sessionFor(sofia) }));
    expect(b.text()).toBe("El bingo es a las ocho.");
  });

  it("asks to repeat, not whether you're there, when the turn behind a filler is gone", async () => {
    const { store, voice } = build({ delayMs: 0 });
    const sofia = (await store.getPerson("sofia"))!;
    const b = liveRes();
    await voice.completions(req(voice), b.res, JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "Mmm, déjame ver... " }], user_id: voice.sessionFor(sofia) }));
    expect(b.text()).toBe("Perdón, se cortó la señal un segundo. ¿Me lo repites?");
    const c = liveRes();
    await voice.completions(req(voice), c.res, JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "Mmm, déjame ver... " }, { role: "assistant", content: "El bingo es a las ocho." }], user_id: voice.sessionFor(sofia) }));
    expect(c.text()).toBe("¿Sigues ahí, Sofía?");
  });
});

describe("call pages", () => {
  it("open the mic before the session starts, so the greeting isn't cut by the phone's audio switch", () => {
    const phone = phoneBridgePage({ lang: "es", base: "/c/x", name: "Sofía", ready: true });
    expect(phone.indexOf("getUserMedia(MIC)")).toBeGreaterThan(0);
    expect(phone.indexOf("getUserMedia(MIC)")).toBeLessThan(phone.indexOf('post("/bridge/session"'));
    expect(phone).toContain('streamToVideoElement("cap", mic)');
    const tv = tvBridge({ key: "k" });
    expect(tv.indexOf("ownMic = await navigator.mediaDevices.getUserMedia")).toBeLessThan(tv.indexOf('"/call", { method: "POST" }'));
    expect(tv).toContain('begin(j.sessionToken, "El Puente", ownMic)');
  });
});

describe("the greeting", () => {
  it("opens with a pause on the agent too, and the custom LLM greets if ever asked before anyone spoke", async () => {
    const { voice, store, heard, calls } = setup();
    await voice.setupAgent();
    expect(calls.find((c) => c.url.endsWith("/agents/create"))!.body.conversation_config.agent.first_message).toMatch(/^<break time="2\.5s" \/> ¡Yiá sas!/);
    const diego = (await store.getPerson("diego"))!;
    let raw = "";
    const res = { on: () => res, destroyed: false, writableFinished: false, writeHead: () => res, write: (s: string) => ((raw += s), true), end: (s: string) => (raw += s) } as never;
    await voice.completions({ headers: { authorization: `Bearer ${voice.llmSecret()}` } } as never, res, JSON.stringify({ messages: [{ role: "system", content: "x" }], user_id: voice.sessionFor(diego) }));
    const said = raw.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content ?? "").join("");
    expect(said).toBe(greetingFor(diego));
    expect(heard).toEqual([]);
    expect(greetingFor({ name: "Puente (TV)", language: "es", phoneE164: "tv:bridge" })).toMatch(/^¡Yiá sas! Aquí el Capitán Lunáticus/);
  });
});
