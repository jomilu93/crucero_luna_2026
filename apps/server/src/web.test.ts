import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatService, type Responder } from "@crucero/agent";
import { MemoryStore, mx, seedSample, type Person } from "@crucero/db";
import QRCode from "qrcode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlyerService, type ImageGenerator, imageType, renderFlyerPng } from "./flyer.js";
import { createRouter } from "./http.js";
import { DiskMediaStore, SupabaseMediaStore } from "./media.js";
import { parseTelegramUpdate } from "./telegram.js";
import { tvData } from "./tv.js";
import { cabinToken, tvKey } from "./web.js";

const SECRET = "test-web-secret";
const NOW = new Date(mx("2026-12-27", "19:30")); // Dec 27, 7:30 pm ship time: bingo (8 pm) is next
const noFetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
const PNG = [0x89, 0x50, 0x4e, 0x47];
const QR = await QRCode.toDataURL("https://t.me/CapitanBot?start=signup_a04");

describe("web app and TV routes", () => {
  let base = "";
  let server: ReturnType<typeof createServer>;
  const store = new MemoryStore({ now: () => NOW });
  seedSample(store);
  const sent: { to: string; text: string; mediaUrl?: string }[] = [];
  const outbox = { send: async (to: Person | "everyone", text: string, opts?: { mediaUrl?: string }) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text, mediaUrl: opts?.mediaUrl }) };
  const responder: Responder = { respond: async (_p, text, history) => ({ text: "ok", history: [...history, { role: "user", content: text }] }) };
  const media = new DiskMediaStore(mkdtempSync(join(tmpdir(), "crucero-media-")), "http://ship.test");
  const flyers = { make: async (id: string) => ({ url: await media.put(`flyers/${id}.png`, new Uint8Array(PNG), "image/png") }) };
  const token = async (id: string) => cabinToken(SECRET, (await store.getPerson(id))!);

  beforeAll(async () => {
    const router = createRouter({
      store,
      chat: new ChatService(store, responder, outbox),
      publicUrl: "http://ship.test",
      web: { store, outbox, publicUrl: "http://ship.test", secret: SECRET, flyers, botUsername: () => "CapitanBot", now: () => NOW },
      tv: { store, key: tvKey(SECRET), botUsername: () => "CapitanBot", now: () => NOW },
      diskMedia: media,
      webhooks: [],
    });
    server = createServer((req, res) => void router(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const post = (path: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });

  it("rejects forged cabin links and serves the real one", async () => {
    expect((await fetch(`${base}/c/valeria.forged`)).status).toBe(404);
    const res = await fetch(`${base}/c/${await token("valeria")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("¡Hola, Valeria!");
    expect(html).toContain("/cal/"); // calendar link
    expect(html).toContain("https://t.me/CapitanBot");
  });

  it("shows a day of the program and an activity page", async () => {
    const t = await token("valeria");
    const program = await (await fetch(`${base}/c/${t}/program?date=2026-12-27`)).text();
    expect(program).toContain("Bingo Lunático");
    const page = await (await fetch(`${base}/c/${t}/a/a04`)).text();
    expect(page).toContain("Tío Ricardo");
    expect(page).toContain("¡Voy!");
    expect(page).not.toContain("Cancelar actividad"); // not the host
  });

  it("signs up through the same tool rules, and refuses what the chat refuses", async () => {
    const t = await token("valeria");
    const ok = await post(`/c/${t}/a/a04/signup`, { status: "going" });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/c/${t}/a/a04?ok=Listo.`);
    expect((await store.listSignups("a04")).find((s) => s.personId === "valeria")?.status).toBe("going");
    const denied = await post(`/c/${t}/a/a04/cancel`, { reason: "lluvia" });
    expect(decodeURIComponent(denied.headers.get("location")!)).toMatch(/NOT ALLOWED: only the host \(Tío Ricardo\)/);
    expect((await store.getActivity("a04"))!.status).toBe("published");
  });

  it("creates an activity from the sponsor form, with a flyer sent to the chat", async () => {
    const t = await token("diego");
    const res = await post(`/c/${t}/new`, { title: "Torneo de ajedrez", emoji: "♟️", date: "2026-12-30", start: "17:00", end: "18:30", location: "Gran Salón", capacity: "8", vibe: "retro-cruise" });
    expect(res.status).toBe(303);
    const id = res.headers.get("location")!.match(/\/a\/([^?]+)/)![1];
    const a = (await store.getActivity(id))!;
    expect(a).toMatchObject({ title: "Torneo de ajedrez", sponsorId: "diego", capacity: 8, createdVia: "web", startsAt: mx("2026-12-30", "17:00") });
    expect(sent.at(-1)).toMatchObject({ to: "diego", mediaUrl: `http://ship.test/media/flyers/${id}.png` });
    const img = await fetch(`${base}/media/flyers/${id}.png`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await img.arrayBuffer())].slice(0, 4)).toEqual(PNG);
  });

  it("saves settings", async () => {
    const t = await token("ricardo");
    await post(`/c/${t}/settings`, { language: "en", humor: "light", wake: "08:15", quiet_start: "22:00", quiet_end: "08:00", muted: "on" });
    expect(await store.getPerson("ricardo")).toMatchObject({ language: "en", humor: "light", wakeTime: "08:15", quietHours: { start: "22:00", end: "08:00" }, muted: true });
  });

  it("shows the admin panel only to admins, and runs admin actions through the admin tools", async () => {
    const t = await token("sofia");
    expect((await fetch(`${base}/c/${t}/admin`)).status).toBe(404);
    expect(await (await fetch(`${base}/c/${t}`)).text()).not.toContain("/admin");
    expect((await post(`/c/${t}/admin/pause`, { paused: "on" })).status).toBe(404);
    await store.updatePerson("sofia", { admin: true });
    const page = await (await fetch(`${base}/c/${t}/admin`)).text();
    expect(page).toContain("Puente de mando");
    expect(page).toContain(`/tv/${tvKey(SECRET)}`);
    expect((await post(`/c/${t}/admin/pause`, { paused: "on" })).headers.get("location")).toBe(`/c/${t}/admin?ok=Listo.`);
    expect(await store.getSetting("paused")).toBe(true);
    await post(`/c/${t}/admin/pause`, { paused: "off" });
    await post(`/c/${t}/admin/role`, { person: "valeria", role: "kid", guardian: "sofia" });
    expect(await store.getPerson("valeria")).toMatchObject({ role: "kid", guardianId: "sofia" });
    await post(`/c/${t}/admin/role`, { person: "valeria", role: "adult" });
    const fake = await store.createPerson({ name: "Test Number", phoneE164: "+16315551181", language: "es", role: "adult" });
    await post(`/c/${t}/admin/remove`, { person: fake.id });
    expect(await store.getPerson(fake.id)).toBeUndefined();
    const denied = await post(`/c/${t}/admin/remove`, { person: "ricardo" });
    expect(decodeURIComponent(denied.headers.get("location")!)).toMatch(/still hosts/);
    await store.updatePerson("sofia", { admin: false });
  });

  it("guards TV mode with its key and serves now/next data", async () => {
    expect((await fetch(`${base}/tv/wrong`)).status).toBe(404);
    expect(await (await fetch(`${base}/tv/${tvKey(SECRET)}`)).text()).toContain("EL PUENTE");
    const data = await (await fetch(`${base}/tv/${tvKey(SECRET)}/data.json`)).json();
    expect(data.next).toMatchObject({ id: "a04", title: "Bingo Lunático" });
    expect(data.next.qr).toMatch(/^data:image\/png;base64,/);
    expect(data.joinQr).toMatch(/^data:image\/png;base64,/);
    expect(data.today.map((a: { id: string }) => a.id)).toContain("a04");
  });

  it("tvData works without a bot (no QR codes)", async () => {
    const data = await tvData({ store, key: "k", now: () => NOW });
    expect(data.next?.qr).toBeNull();
    expect(data.joinQr).toBeNull();
  });
});

describe("flyers", () => {
  it("renders a PNG flyer without network access", async () => {
    const png = await renderFlyerPng(
      { vibe: "fiesta", emoji: "🎱", headline: "Bingo Lunático", tagline: "¡Suerte!", when: "dom 27 dic · 8:00 pm", where: "Gran Salón", host: "Organiza: Tío Ricardo", qrLabel: "¡Apúntate!", qrDataUrl: QR },
      noFetch,
    );
    expect([...png.slice(0, 4)]).toEqual(PNG);
    expect(png.length).toBeGreaterThan(20_000);
  }, 30_000);

  it("writes the brief with Claude, paints with the image model, stores and attaches the flyer", async () => {
    const store = new MemoryStore();
    seedSample(store);
    const prompts: string[] = [];
    const client = { messages: { parse: async () => ({ parsed_output: { headline: "Bingo Lunático", tagline: "¡Que la luna reparta!", art_prompt: "moonlit bingo balls" } }) } } as unknown as Anthropic;
    const images: ImageGenerator = { generate: async (p) => (prompts.push(p), new Uint8Array(await renderFlyerPng({ vibe: "zen", emoji: "", headline: "", tagline: "", when: "", where: "", host: "", qrLabel: "", qrDataUrl: QR }, noFetch))) };
    const media = new DiskMediaStore(mkdtempSync(join(tmpdir(), "crucero-flyer-")), "http://ship.test");
    const service = new FlyerService({ store, media, client, images, signupUrl: (a) => `https://t.me/CapitanBot?start=signup_${a.id}`, fetch: noFetch });
    const out = await service.make("a04", "fiesta", "es");
    expect(out.usedAiArt).toBe(true);
    expect(prompts[0]).toMatch(/^moonlit bingo balls\. Style: .*no text/);
    expect((await store.getActivity("a04"))!.flyerUrl).toBe(out.url);
    expect(out.url).toMatch(/^http:\/\/ship\.test\/media\/flyers\/a04-\d+\.png$/);
  }, 30_000);

  it("labels Flux's JPEG art as JPEG (a PNG label renders an empty, grey flyer)", () => {
    expect(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(new Uint8Array(PNG))).toBe("image/png");
    expect(imageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
  });

  it("falls back to the vibe template when the image model fails", async () => {
    const store = new MemoryStore();
    seedSample(store);
    const client = { messages: { parse: async () => ({ parsed_output: null }) } } as unknown as Anthropic;
    const images: ImageGenerator = { generate: async () => Promise.reject(new Error("fal 500")) };
    const media = new DiskMediaStore(mkdtempSync(join(tmpdir(), "crucero-flyer-")), "http://ship.test");
    const logs: string[] = [];
    const service = new FlyerService({ store, media, client, images, signupUrl: () => "https://t.me/x", fetch: noFetch, log: (l) => logs.push(l) });
    const out = await service.make("a04", "gala", "en");
    expect(out.usedAiArt).toBe(false);
    expect(logs.join()).toMatch(/flyer art ERROR fal 500/);
  }, 30_000);
});

describe("supabase storage", () => {
  const capture = async (key: string) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => (calls.push({ url, headers: init.headers as Record<string, string> }), new Response("{}"))) as unknown as typeof fetch;
    const url = await new SupabaseMediaStore({ url: "https://x.supabase.co", serviceRoleKey: key, fetch: fetchFn }).put("flyers/a.png", new Uint8Array(PNG), "image/png");
    return { url, calls };
  };

  it("sends a new secret key in apikey only", async () => {
    const { url, calls } = await capture("sb_secret_abc");
    expect(url).toBe("https://x.supabase.co/storage/v1/object/public/media/flyers/a.png");
    expect(calls.map((c) => c.headers.apikey)).toEqual(["sb_secret_abc", "sb_secret_abc"]);
    expect(calls.every((c) => !c.headers.Authorization)).toBe(true);
  });

  it("ignores a path on SUPABASE_URL (the dashboard shows …/rest/v1/)", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => (calls.push(url), new Response("{}"))) as unknown as typeof fetch;
    const url = await new SupabaseMediaStore({ url: "https://x.supabase.co/rest/v1/", serviceRoleKey: "sb_secret_abc", fetch: fetchFn }).put("f.png", new Uint8Array(PNG), "image/png");
    expect(calls).toEqual(["https://x.supabase.co/storage/v1/bucket", "https://x.supabase.co/storage/v1/object/media/f.png"]);
    expect(url).toBe("https://x.supabase.co/storage/v1/object/public/media/f.png");
  });

  it("also sends a legacy service_role JWT as a Bearer token", async () => {
    const { calls } = await capture("eyJhbGciOi.legacy");
    expect(calls[1].headers.Authorization).toBe("Bearer eyJhbGciOi.legacy");
  });
});

describe("telegram deep links", () => {
  it("turns /start signup_<id> from a flyer QR into a sign-up tap", () => {
    const u = parseTelegramUpdate({ update_id: 1, message: { message_id: 1, from: { id: 7, first_name: "Ana" }, chat: { id: 7, type: "private" }, text: "/start signup_a04" } });
    expect(u?.message).toMatchObject({ phoneE164: "tg:7", text: "Hola Capitán", buttonPayload: "signup:a04" });
  });
});
