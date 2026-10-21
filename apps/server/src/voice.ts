/**
 * "Call the Bridge": live video calls with the Capitán.
 *
 *   phone / TV page ──Anam SDK (WebRTC)──▶ Anam (photoreal avatar) ──▶ ElevenLabs agent (ears + voice)
 *                                                                          │ custom LLM
 *                                                                          ▼
 *                                POST /v1/chat/completions (here) → ChatService.converse → the Capitán
 *
 * The same brain, tools, memory and chat history answer by voice: ElevenLabs only listens and
 * speaks. Each call carries a signed session in elevenlabs_extra_body naming the passenger.
 *
 * Setup (Admin tab): portraits of the Capitán painted with Flux → one becomes his Anam avatar;
 * "set up the voice agent" creates the ElevenLabs agent that calls this server. Env:
 * ELEVENLABS_API_KEY, ANAM_API_KEY, optional ELEVENLABS_AGENT_ID / ELEVENLABS_VOICE_ID / ANAM_AVATAR_ID.
 *
 * "Talk on the TV" from a phone: the phone's mic is relayed over a WebSocket (/voice/relay/<call>)
 * to the TV page, which feeds it to the avatar as its microphone.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { CAPTAIN_NAME, type ChatService, SHIP_NAME, TV_ADDRESS } from "@crucero/agent";
import { type Person, type Store, isPaused } from "@crucero/db";
import { WebSocket, WebSocketServer } from "ws";
import type { ImageGenerator } from "./flyer.js";
import type { MediaStore } from "./media.js";

export interface VoiceConfig {
  elevenLabsKey?: string;
  anamKey?: string;
  /** Overrides the agent created from the Admin tab. */
  agentId?: string;
  voiceId?: string;
  /** Overrides the avatar picked in the Admin tab. */
  avatarId?: string;
}

export interface VoiceDeps {
  store: Store;
  chat: ChatService;
  secret: string;
  publicUrl: string;
  cfg: VoiceConfig;
  images?: ImageGenerator;
  media?: MediaStore;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface VoiceStatus {
  elevenLabs: boolean;
  anam: boolean;
  agentId?: string;
  avatarId?: string;
  voiceId: string;
  portraits: string[];
  portraitUrl?: string;
  canPaint: boolean;
  /** Everything needed for a call is in place. */
  ready: boolean;
}

/** A pending "talk on the TV" call, waiting for the TV page to pick it up. */
export interface TvCall {
  id: string;
  key: string;
  sessionToken: string;
  name: string;
  createdAt: number;
}

/** A multilingual premade ElevenLabs voice; pick a Spanish one from the voice library in the Admin tab. */
export const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
const TTS_MODEL = "eleven_flash_v2_5";
const SESSION_TTL_MS = 2 * 3600 * 1000;
const PORTRAIT_PROMPT =
  "Photorealistic head-and-shoulders portrait of a cheerful, charismatic Greek cruise ship captain in his late fifties, Mediterranean features, warm smile, thick silver beard and bushy eyebrows, crisp white captain's uniform with gold epaulettes and a white captain's hat with a golden moon emblem, looking straight at the camera, face centered and fully visible, soft natural light, blurred background of a sunny Acapulco bay seen from a ship's bridge, shallow depth of field, 85mm photo";

const hmac = (secret: string, data: string, len = 32) => createHmac("sha256", secret).update(data).digest("base64url").slice(0, len);
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** What the Capitán says, cleaned up for text-to-speech: no emoji, markdown, links or ids. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[[A-Za-z0-9-]{3,12}\]/g, "")
    .replace(/[*_`#>~]/g, "")
    .replace(/\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Splits speech into sentence-sized chunks so the voice can start before the whole reply is streamed. */
export function sentences(text: string): string[] {
  return text.match(/[^.!?\n]*[.!?\n]+["')\]]*\s*|[^.!?\n]+$/g)?.filter((s) => s.trim()) ?? [text];
}

export class VoiceService {
  private readonly fetchFn: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly tvCalls = new Map<string, TvCall>();
  private readonly relays = new Map<string, { phone?: WebSocket; tv?: WebSocket }>();
  private wss?: WebSocketServer;
  /** Recent call events (browser close reasons, custom LLM hits) for the Admin tab's diagnostics. */
  private readonly events: string[] = [];

  constructor(private readonly deps: VoiceDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => new Date());
  }

  // ---------- secrets and tokens ----------

  /** The API key ElevenLabs sends to our custom LLM endpoint as a Bearer token. */
  llmSecret(): string {
    return hmac(this.deps.secret, "voice-llm", 40);
  }

  /** Names the passenger on a call; travels in elevenlabs_extra_body and expires. */
  sessionFor(person: Person): string {
    const exp = this.now().getTime() + SESSION_TTL_MS;
    return `${person.id}.${exp}.${hmac(this.deps.secret, `voice:${person.id}:${exp}`)}`;
  }

  async personFromSession(token: unknown): Promise<Person | undefined> {
    if (typeof token !== "string") return undefined;
    const [id, exp, sig] = token.split(".");
    if (!id || !exp || !sig || Number(exp) < this.now().getTime()) return undefined;
    if (!safeEqual(sig, hmac(this.deps.secret, `voice:${id}:${exp}`))) return undefined;
    return this.deps.store.getPerson(id);
  }

  relaySig(callId: string): string {
    return hmac(this.deps.secret, `relay:${callId}`, 20);
  }

  // ---------- configuration ----------

  async status(): Promise<VoiceStatus> {
    const { cfg, store } = this.deps;
    const agentId = cfg.agentId ?? (await store.getSetting<string>("voice_agent_id"));
    const avatarId = cfg.avatarId ?? (await store.getSetting<string>("captain_avatar_id"));
    return {
      elevenLabs: !!cfg.elevenLabsKey,
      anam: !!cfg.anamKey,
      agentId,
      avatarId,
      voiceId: cfg.voiceId ?? (await store.getSetting<string>("voice_id")) ?? DEFAULT_VOICE_ID,
      portraits: (await store.getSetting<string[]>("captain_portraits")) ?? [],
      portraitUrl: await store.getSetting<string>("captain_portrait"),
      canPaint: !!this.deps.images && !!this.deps.media,
      ready: !!cfg.elevenLabsKey && !!cfg.anamKey && !!agentId && !!avatarId,
    };
  }

  /** Paints a portrait of the Capitán with the image model and keeps it as a candidate. */
  async paintPortrait(): Promise<string> {
    const { images, media, store } = this.deps;
    if (!images || !media) throw new Error("set FAL_KEY to paint the Capitán");
    const bytes = await images.generate(PORTRAIT_PROMPT, { width: 1024, height: 1024 });
    const ext = bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : "png";
    const url = await media.put(`captain/portrait-${Date.now()}.${ext}`, bytes, ext === "jpg" ? "image/jpeg" : "image/png");
    const portraits = [url, ...((await store.getSetting<string[]>("captain_portraits")) ?? [])].slice(0, 6);
    await store.setSetting("captain_portraits", portraits);
    return url;
  }

  /** Turns a portrait into the Capitán's live Anam avatar. */
  async useAvatar(imageUrl: string): Promise<string> {
    const key = this.deps.cfg.anamKey;
    if (!key) throw new Error("set ANAM_API_KEY first");
    const res = await this.fetchFn("https://api.anam.ai/v1/avatars", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: CAPTAIN_NAME, imageUrl }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Anam avatar ${res.status}: ${body.slice(0, 200)}`);
    const id = (JSON.parse(body) as { id?: string }).id;
    if (!id) throw new Error("Anam returned no avatar id");
    await this.deps.store.setSetting("captain_avatar_id", id);
    await this.deps.store.setSetting("captain_portrait", imageUrl);
    this.log(`voice: captain avatar ${id}`);
    return id;
  }

  async setVoice(voiceId: string): Promise<void> {
    if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) throw new Error("that does not look like an ElevenLabs voice id");
    await this.deps.store.setSetting("voice_id", voiceId);
    const agentId = this.deps.cfg.agentId ?? (await this.deps.store.getSetting<string>("voice_agent_id"));
    if (agentId) await this.setupAgent(); // push the new voice to the agent
  }

  /** The ElevenLabs agent config: our server is its brain, ElevenLabs only listens and speaks. */
  agentConfig(secretId: string, voiceId: string) {
    return {
      name: CAPTAIN_NAME,
      conversation_config: {
        agent: {
          first_message: `¡Yiá sas! Aquí el ${CAPTAIN_NAME} desde el Puente del ${SHIP_NAME}. ¿En qué te ayudo?`,
          dynamic_variables: { dynamic_variable_placeholders: { cl_session: "none" } },
          language: "es",
          prompt: {
            // {{cl_session}} is filled per call (dynamic variables need no override permission) and reaches
            // our endpoint inside the system message: the backup way to know who is calling.
            prompt: `You are ${CAPTAIN_NAME}. Your replies come from the ship's own server. [session:{{cl_session}}]`,
            llm: "custom-llm",
            custom_llm: { url: `${this.deps.publicUrl}/v1/chat/completions`, model_id: "capitan-lunatico", api_key: { secret_id: secretId } },
          },
        },
        tts: { voice_id: voiceId, model_id: TTS_MODEL },
      },
      platform_settings: {
        // Each call names its passenger in custom_llm_extra_body; ElevenLabs refuses it (1008) unless allowed here.
        overrides: { custom_llm_extra_body: true, conversation_config_override: { agent: { first_message: true, language: true } } },
      },
    };
  }

  private async eleven(path: string, init: RequestInit = {}): Promise<unknown> {
    const key = this.deps.cfg.elevenLabsKey;
    if (!key) throw new Error("set ELEVENLABS_API_KEY first");
    const res = await this.fetchFn(`https://api.elevenlabs.io${path}`, {
      ...init,
      headers: { "xi-api-key": key, "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`ElevenLabs ${init.method ?? "GET"} ${path.split("?")[0]} ${res.status}: ${body.slice(0, 240)}`);
    return body ? JSON.parse(body) : {};
  }

  /** Creates (or updates) the ElevenLabs agent that calls this server. Returns its id. */
  async setupAgent(): Promise<string> {
    const { store } = this.deps;
    const secret = (await this.eleven("/v1/convai/secrets", {
      method: "POST",
      body: JSON.stringify({ type: "new", name: `crucero-llm-${Date.now()}`, value: this.llmSecret() }),
    })) as { secret_id?: string };
    if (!secret.secret_id) throw new Error("ElevenLabs returned no secret id");
    const voiceId = (await this.status()).voiceId;
    const config = this.agentConfig(secret.secret_id, voiceId);
    const existing = this.deps.cfg.agentId ?? (await store.getSetting<string>("voice_agent_id"));
    if (existing) {
      await this.eleven(`/v1/convai/agents/${existing}`, { method: "PATCH", body: JSON.stringify(config) });
      this.log(`voice: updated ElevenLabs agent ${existing}`);
      return existing;
    }
    const created = (await this.eleven("/v1/convai/agents/create", { method: "POST", body: JSON.stringify(config) })) as { agent_id?: string };
    if (!created.agent_id) throw new Error("ElevenLabs returned no agent id");
    await store.setSetting("voice_agent_id", created.agent_id);
    this.log(`voice: created ElevenLabs agent ${created.agent_id}`);
    return created.agent_id;
  }

  // ---------- calls ----------

  /** The TV's pseudo-passenger: one shared seat on the Bridge, never messaged. */
  async tvPassenger(): Promise<Person> {
    const { store } = this.deps;
    return (
      (await store.findPersonByPhone(TV_ADDRESS)) ??
      (await store.updatePerson((await store.createPerson({ name: "Puente (TV)", phoneE164: TV_ADDRESS, language: "es", role: "adult" })).id, { muted: true }))
    );
  }

  /** An Anam session token for one call: avatar + ElevenLabs agent + the passenger's signed session. */
  async startCall(person: Person, screen: "phone" | "tv" = "phone"): Promise<{ sessionToken: string }> {
    const st = await this.status();
    if (!st.ready) throw new Error("the Capitán's video call is not set up yet (Admin tab → Capitán en vivo)");
    if (!person.admin && (await isPaused(this.deps.store))) throw new Error("the ship is paused");
    const signed = (await this.eleven(`/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(st.agentId!)}`)) as { signed_url?: string };
    if (!signed.signed_url) throw new Error("ElevenLabs returned no signed URL");
    const first = person.phoneE164 === TV_ADDRESS ? undefined : (person.nickname ?? person.name.split(" ")[0]);
    const session = this.sessionFor(person);
    const greeting =
      person.language === "en"
        ? `Yiá sas${first ? `, ${first}` : ""}! ${CAPTAIN_NAME} here, on the Bridge of the ${SHIP_NAME}. What can I do for you?`
        : `¡Yiá sas${first ? `, ${first}` : ""}! Aquí el ${CAPTAIN_NAME} desde el Puente del ${SHIP_NAME}. ¿En qué te ayudo?`;
    const res = await this.fetchFn("https://api.anam.ai/v1/auth/session-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.deps.cfg.anamKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personaConfig: { avatarId: st.avatarId, avatarModel: "cara-4", directorNotes: { presetStyle: "warm", expressivity: 0.6 } },
        // Cara 4's largest frames, portrait for phones and landscape for the TV, starting on the high bitrate
        // profile instead of ramping up from a blurry one.
        sessionOptions: { ...(screen === "tv" ? { videoWidth: 1152, videoHeight: 768 } : { videoWidth: 768, videoHeight: 1152 }), videoQuality: "high" },
        environment: {
          elevenLabsAgentSettings: {
            signedUrl: signed.signed_url,
            agentId: st.agentId,
            // The signed passenger session rides as the user id, which ElevenLabs forwards to the custom LLM
            // as user_id; unlike custom_llm_extra_body it needs no override permission on the agent.
            userId: session,
            dynamicVariables: { cl_session: session },
            conversationConfigOverride: { agent: { first_message: greeting, language: person.language } },
          },
        },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Anam session ${res.status}: ${body.slice(0, 200)}`);
    const sessionToken = (JSON.parse(body) as { sessionToken?: string }).sessionToken;
    if (!sessionToken) throw new Error("Anam returned no session token");
    this.note(`call started for ${person.name}`);
    return { sessionToken };
  }

  /** A phone asks the TV to take the call: the TV picks it up from pollTvCall and listens to the phone's mic. */
  async requestTvCall(person: Person): Promise<{ callId: string; relay: string }> {
    const { sessionToken } = await this.startCall(person, "tv");
    const id = randomBytes(9).toString("base64url");
    const key = this.relaySig(id);
    this.tvCalls.clear(); // one TV, one call
    this.tvCalls.set(id, { id, key, sessionToken, name: person.nickname ?? person.name.split(" ")[0], createdAt: Date.now() });
    return { callId: id, relay: `/voice/relay/${id}?k=${key}` };
  }

  /** The TV polls this; a call is handed out once and expires after a minute unclaimed. */
  pollTvCall(): TvCall | undefined {
    for (const [id, call] of this.tvCalls) {
      this.tvCalls.delete(id);
      if (Date.now() - call.createdAt < 60_000) return call;
    }
    return undefined;
  }

  /** A call event: from a browser (why Anam closed the call) or from our own endpoints. Logged and kept for the Admin tab. */
  note(line: string): void {
    const entry = `${this.now().toISOString().slice(11, 19)} ${line}`.slice(0, 400);
    this.events.unshift(entry);
    this.events.length = Math.min(this.events.length, 20);
    this.log(`voice ${line}`);
  }

  clientEvent(who: string, event: string, code: string, details: string): void {
    this.note(`call ${event} (${who})${code ? ` ${code.replace("CONNECTION_CLOSED_CODE_", "")}` : ""}${details ? `: ${details}` : ""}`);
  }

  /**
   * Admin diagnostics: what the ElevenLabs agent really has configured, how the last
   * conversations ended (ElevenLabs keeps the termination reason), and our recent call events.
   */
  async diagnose(): Promise<string[]> {
    const out: string[] = [];
    const st = await this.status();
    out.push(`keys: elevenlabs ${st.elevenLabs ? "✓" : "✗"} · anam ${st.anam ? "✓" : "✗"} · avatar ${st.avatarId ?? "✗"} · agent ${st.agentId ?? "✗"}`);
    if (st.elevenLabs && st.agentId) {
      try {
        const agent = (await this.eleven(`/v1/convai/agents/${st.agentId}`)) as any;
        const prompt = agent?.conversation_config?.agent?.prompt ?? {};
        const ov = agent?.platform_settings?.overrides ?? {};
        const want = `${this.deps.publicUrl}/v1/chat/completions`;
        out.push(`agent llm: ${prompt.llm ?? "?"} → ${prompt.custom_llm?.url ?? "no custom url"}${prompt.custom_llm?.url === want ? " ✓" : ` ✗ (expected ${want})`}`);
        out.push(`agent overrides: extra body ${ov.custom_llm_extra_body ? "✓" : "✗"} · first message ${ov.conversation_config_override?.agent?.first_message ? "✓" : "✗"} · language ${ov.conversation_config_override?.agent?.language ? "✓" : "✗"}`);
        out.push(`agent voice: ${agent?.conversation_config?.tts?.voice_id ?? "?"} · tts ${agent?.conversation_config?.tts?.model_id ?? "?"} · language ${agent?.conversation_config?.agent?.language ?? "?"}`);
        const list = (await this.eleven(`/v1/convai/conversations?agent_id=${encodeURIComponent(st.agentId)}&page_size=3`)) as any;
        for (const c of (list?.conversations ?? []).slice(0, 3)) {
          const d = (await this.eleven(`/v1/convai/conversations/${c.conversation_id}`).catch(() => ({}))) as any;
          const m = d?.metadata ?? {};
          const err = m.error ? ` · error ${JSON.stringify(m.error).slice(0, 200)}` : "";
          out.push(
            `conversation ${String(c.conversation_id).slice(-8)} · ${c.status ?? d.status ?? "?"} · ${c.call_duration_secs ?? m.call_duration_secs ?? "?"} s · ${(d?.transcript ?? []).length} turns · ended: ${m.termination_reason || "?"}${err}`,
          );
        }
        if (!(list?.conversations ?? []).length) out.push("no conversations on ElevenLabs yet: the call never reached the agent (check Anam)");
      } catch (err) {
        out.push(`ElevenLabs check failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    out.push(...(this.events.length ? this.events.map((e) => `event ${e}`) : ["no call events since the last deploy"]));
    return out;
  }

  // ---------- the custom LLM endpoint ElevenLabs calls ----------

  /** POST /v1/chat/completions (OpenAI-compatible, SSE). */
  async completions(req: IncomingMessage, res: ServerResponse, rawBody: string): Promise<void> {
    const auth = req.headers.authorization ?? "";
    if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), this.llmSecret())) {
      this.note(`custom LLM refused: ${auth ? "wrong" : "missing"} API key (Admin tab → set up the voice agent again)`);
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "bad api key" } }));
      return;
    }
    let body: { messages?: { role: string; content: unknown }[]; user_id?: unknown; elevenlabs_extra_body?: { session?: unknown } };
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    const system = (body.messages ?? []).find((m) => m.role === "system");
    const fromPrompt = typeof system?.content === "string" ? system.content.match(/\[session:([A-Za-z0-9._-]+)\]/)?.[1] : undefined;
    const person =
      (await this.personFromSession(body.user_id)) ??
      (await this.personFromSession(fromPrompt)) ??
      (await this.personFromSession(body.elevenlabs_extra_body?.session));
    if (!person) this.note(`custom LLM hit without a valid passenger session (user_id ${body.user_id ? "present" : "missing"}, prompt ${fromPrompt ? "has" : "lacks"} session)`);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.map((p: { text?: string }) => p.text ?? "").join(" ") : "";

    const id = `chatcmpl-${randomBytes(6).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, string>, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "capitan-lunatico", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(chunk({ role: "assistant" }));
    const ping = setInterval(() => res.write(": thinking\n\n"), 2000); // keeps proxies from closing a slow turn

    let reply: string;
    try {
      if (!person) reply = "Perdón, se cortó la señal del Puente. Vuelve a llamar desde tu página, por favor.";
      else if (!text.trim()) reply = person.language === "en" ? "I'm listening." : "Te escucho.";
      else reply = speakable(await this.deps.chat.converse(person, text, "voice")) || (person.language === "en" ? "Aye aye!" : "¡A la orden!");
      if (person) this.log(`voice ${person.name}: ${text.slice(0, 60)} → ${reply.slice(0, 80)}`);
    } catch (err) {
      this.log(`voice ERROR ${err instanceof Error ? err.message : err}`);
      reply = person?.language === "en" ? "Rough seas on the line, give me a moment and ask again." : "Hay oleaje en la línea; dame un momento y vuelve a preguntar.";
    } finally {
      clearInterval(ping);
    }
    for (const s of sentences(reply)) res.write(chunk({ content: s }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  }

  // ---------- phone → TV mic relay ----------

  /** Attach to the HTTP server's upgrade event. Phone frames (16 kHz PCM) go to the TV; control messages both ways. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", this.deps.publicUrl);
    const m = url.pathname.match(/^\/voice\/relay\/([A-Za-z0-9_-]+)$/);
    if (!m) return false;
    const role = url.searchParams.get("role");
    if ((role !== "phone" && role !== "tv") || !safeEqual(url.searchParams.get("k") ?? "", this.relaySig(m[1]))) {
      socket.destroy();
      return true;
    }
    this.wss ??= new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.wss.handleUpgrade(req, socket, head, (ws) => this.join(m[1], role, ws));
    return true;
  }

  private join(callId: string, role: "phone" | "tv", ws: WebSocket): void {
    const pair = this.relays.get(callId) ?? {};
    pair[role]?.close();
    pair[role] = ws;
    this.relays.set(callId, pair);
    const other = () => this.relays.get(callId)?.[role === "phone" ? "tv" : "phone"];
    const tell = (s: WebSocket | undefined, msg: object) => s?.readyState === WebSocket.OPEN && s.send(JSON.stringify(msg));
    tell(other(), { type: "peer", role, connected: true });
    if (other()) tell(ws, { type: "peer", role: role === "phone" ? "tv" : "phone", connected: true });
    ws.on("message", (data, isBinary) => {
      const o = other();
      if (o?.readyState === WebSocket.OPEN) o.send(data, { binary: isBinary });
    });
    ws.on("close", () => {
      const p = this.relays.get(callId);
      if (p?.[role] === ws) delete p[role];
      tell(other(), { type: "peer", role, connected: false });
      if (p && !p.phone && !p.tv) this.relays.delete(callId);
    });
  }
}
