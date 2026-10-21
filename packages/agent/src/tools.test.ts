import { MemoryStore, mx, seedSample, type Person } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { buildPassengerContext } from "./context.js";
import { buildMorningBrief } from "./morning.js";
import { buildTools, suggestActivities, type ToolCallRecord, type ToolContext } from "./tools.js";

const NOW = new Date("2026-12-27T15:00:00Z"); // Dec 27, 9:00 am ship time

async function ctxFor(id: string, now = NOW, extra: Partial<ToolContext> = {}) {
  const store = new MemoryStore({ now: () => now });
  seedSample(store);
  const passenger = (await store.getPerson(id)) as Person;
  const sent: { to: string; text: string; mediaUrl?: string }[] = [];
  const calls: ToolCallRecord[] = [];
  const ctx: ToolContext = {
    store,
    passenger,
    now,
    outbox: { send: async (to, text, opts) => void sent.push({ to: to === "everyone" ? "everyone" : to.name, text, ...(opts?.mediaUrl ? { mediaUrl: opts.mediaUrl } : {}) }) },
    onToolCall: (r) => calls.push(r),
    ...extra,
  };
  // Keyed by name for the tests; the union of input types collapses, so loosen `run` here only.
  const tools = Object.fromEntries(buildTools(ctx).map((t) => [t.name, t])) as Record<string, { run: (input: any) => Promise<string> | string }>;
  return { store, passenger, ctx, tools, sent, calls };
}

describe("suggestActivities", () => {
  it("prefers under-subscribed activities the passenger is not in", async () => {
    const { ctx, passenger } = await ctxFor("ricardo");
    const picks = await suggestActivities(ctx, passenger, "2026-12-27");
    // Ricardo hosts bingo (a04) so it is excluded; yoga (a03) has 2 going and is already past 9am.
    expect(picks.map((a) => a.id)).toEqual([]);
    const tomorrow = await suggestActivities(ctx, passenger, "2026-12-28");
    expect(tomorrow.map((a) => a.id)).toEqual(["a05"]);
  });
  it("respects 'not an early riser' memory and capacity", async () => {
    const { ctx, store } = await ctxFor("carmen", new Date("2026-12-28T13:00:00Z"));
    const carmen = (await store.getPerson("carmen"))!;
    // Dec 29: yoga 7am (a06, early) and volleyball 4pm (a07).
    const picks = await suggestActivities(ctx, carmen, "2026-12-29");
    expect(picks.map((a) => a.id)).toEqual(["a07", "a06"]);
    for (const p of ["sofia", "diego", "valeria", "ricardo", "mateo"]) await store.setSignup("a07", p, "going");
    await store.updateActivity("a07", { capacity: 5 });
    const after = await suggestActivities(ctx, carmen, "2026-12-29");
    expect(after.map((a) => a.id)).toEqual(["a06", "a07"]); // full one sinks to the bottom
  });
});

describe("tools", () => {
  it("signs up, reports counts, and records the call", async () => {
    const { tools, calls, store } = await ctxFor("valeria");
    const out = await tools.signup.run({ activity_id: "a04", status: "going" });
    expect(out).toMatch(/Valeria Luna is now 'going'/);
    expect(out).toMatch(/Going now: 3/);
    expect(calls[0].name).toBe("signup");
    expect((await store.listSignups("a04")).some((s) => s.personId === "valeria")).toBe(true);
  });
  it("waitlists when full instead of overbooking", async () => {
    const { tools, store } = await ctxFor("ricardo");
    await store.updateActivity("a03", { capacity: 2 }); // diego + valeria already going
    const out = await tools.signup.run({ activity_id: "a03", status: "going" });
    expect(out).toMatch(/^FULL/);
    expect((await store.listSignups("a03")).find((s) => s.personId === "ricardo")?.status).toBe("maybe");
  });
  it("lets a parent sign up a kid by name", async () => {
    const { tools, store } = await ctxFor("diego");
    const out = await tools.signup.run({ activity_id: "a07", status: "going", person_name: "Mateo" });
    expect(out).toMatch(/Mateo Luna is now 'going'/);
    expect((await store.listSignups("a07")).map((s) => s.personId)).toEqual(["mateo"]);
  });
  it("returns an ERROR string (not a throw) for unknown passengers", async () => {
    const { tools } = await ctxFor("diego");
    const out = await tools.signup.run({ activity_id: "a07", status: "going", person_name: "Zed" });
    expect(out).toMatch(/^ERROR: No passenger named "Zed"/);
  });
  it("creates an activity and auto-signs the sponsor", async () => {
    const { tools, store } = await ctxFor("ricardo");
    const out = await tools.create_activity.run({
      title: "Torneo de dominó",
      emoji: "🁣",
      date: "2026-12-29",
      start_time: "20:00",
      end_time: "22:00",
      location: "Gran Salón",
      capacity: 8,
      bring: "Monedas",
    });
    expect(out).toMatch(/^Created: \[\w{8}\] 🁣 Torneo de dominó · 2026-12-29 8:00 pm–10:00 pm/);
    const a = (await store.listActivities()).find((x) => x.title === "Torneo de dominó")!;
    expect((await store.listSignups(a.id))[0]).toMatchObject({ personId: "ricardo", status: "going" });
  });
  it("handles an end time past midnight", async () => {
    const { tools, store } = await ctxFor("diego");
    await tools.create_activity.run({ title: "After-party", emoji: "🪩", date: "2026-12-31", start_time: "23:00", end_time: "01:00", location: "Gran Salón" });
    const a = (await store.listActivities()).find((x) => x.title === "After-party")!;
    expect(a.endsAt).toBe(mx("2027-01-01", "01:00"));
  });
  it("reschedules keeping the duration", async () => {
    const { tools, store } = await ctxFor("sofia");
    await tools.update_activity.run({ activity_id: "a05", start_time: "07:30" });
    const a = (await store.getActivity("a05"))!;
    expect(a.startsAt).toBe(mx("2026-12-28", "07:30"));
    expect(a.endsAt).toBe(mx("2026-12-28", "08:15"));
  });
  it("cancels and lists who to notify, excluding the sponsor", async () => {
    const { tools } = await ctxFor("ricardo");
    const out = await tools.cancel_activity.run({ activity_id: "a04", reason: "enfermo" });
    expect(out).toMatch(/CANCELLED/);
    expect(out).toMatch(/to notify: Abuela Carmen, Mateo Luna/);
  });
  it("sends to everyone or to one passenger through the outbox", async () => {
    const { tools, sent } = await ctxFor("sofia");
    expect(await tools.send_message.run({ to: "everyone", text: "Yoga puntual a las 7." })).toBe("Sent to 5 passenger(s).");
    await tools.send_message.run({ to: "Ricardo", text: "Trae las monedas." });
    expect(sent.slice(0, 5).map((s) => s.to).sort()).toEqual(["Abuela Carmen", "Diego Luna", "Sofía Luna", "Tío Ricardo", "Valeria Luna"]); // Mateo has no phone
    expect(sent.at(-1)).toEqual({ to: "Tío Ricardo", text: "Trae las monedas." });
  });
  it("respects quiet hours on direct messages and broadcasts", async () => {
    const { tools, sent } = await ctxFor("sofia", new Date(mx("2026-12-27", "23:00")));
    expect(await tools.send_message.run({ to: "Carmen", text: "¿Mañana bingo?" })).toMatch(/^NOT SENT: .*quiet hours until 08:30/);
    const out = await tools.send_message.run({ to: "everyone", text: "Mañana yoga" });
    expect(out).toMatch(/^Sent to 4 passenger\(s\)\. Held back for quiet hours: Abuela Carmen \(quiet until 08:30\)/);
    expect(sent.map((s) => s.to)).not.toContain("Abuela Carmen");
  });
  it("only lets the host change or cancel an activity, and only the person or their guardian take them off", async () => {
    const { tools, store } = await ctxFor("valeria");
    const before = (await store.getActivity("a04"))!;
    expect(await tools.update_activity.run({ activity_id: "a04", start_time: "21:00" })).toMatch(/^NOT ALLOWED: only the host \(Tío Ricardo\)/);
    expect(await tools.cancel_activity.run({ activity_id: "a04", reason: "lluvia" })).toMatch(/^NOT ALLOWED/);
    expect(await store.getActivity("a04")).toEqual(before);
    expect(await tools.signup.run({ activity_id: "a04", status: "out", person_name: "Carmen" })).toMatch(/^NOT ALLOWED: only Abuela Carmen/);
    expect(await tools.signup.run({ activity_id: "a04", status: "going", person_name: "Diego" })).toMatch(/Diego Luna is now 'going'/); // adding someone is fine
    const diego = await ctxFor("diego");
    expect(await diego.tools.signup.run({ activity_id: "a04", status: "out", person_name: "Mateo" })).toMatch(/Mateo Luna is now 'out'/); // guardian
  });
  it("moves an activity to another day keeping its ship-time hours", async () => {
    const { tools, store } = await ctxFor("sofia");
    const a = (await store.getActivity("a05"))!; // Sunrise yoga, Dec 28 7:00-7:45
    await tools.update_activity.run({ activity_id: "a05", date: "2026-12-30" });
    const moved = (await store.getActivity("a05"))!;
    expect(moved.startsAt).toBe(mx("2026-12-30", "07:00"));
    expect(moved.endsAt).toBe(mx("2026-12-30", "07:45"));
    expect(new Date(moved.endsAt).getTime() - new Date(moved.startsAt).getTime()).toBe(new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime());
  });
  it("updates preferences and memory", async () => {
    const { tools, store } = await ctxFor("carmen");
    await tools.set_preferences.run({ humor: "off", quiet_start: "21:00", quiet_end: "09:00" });
    await tools.remember.run({ key: "allergy", value: "camarón" });
    const p = (await store.getPerson("carmen"))!;
    expect(p.humor).toBe("off");
    expect(p.quietHours).toEqual({ start: "21:00", end: "09:00" });
    expect((await store.getMemory("carmen")).map((m) => m.key)).toContain("allergy");
  });
  it("mutes on request and refuses direct messages to a muted passenger", async () => {
    const { tools, store, sent } = await ctxFor("ricardo");
    await tools.set_preferences.run({ muted: true });
    expect((await store.getPerson("ricardo"))!.muted).toBe(true);
    const other = await ctxFor("sofia");
    await other.store.updatePerson("ricardo", { muted: true });
    expect(await other.tools.send_message.run({ to: "Ricardo", text: "hola" })).toMatch(/^NOT SENT/);
    expect(other.sent).toEqual([]);
    expect(sent).toEqual([]);
  });
  it("queues a flyer without claiming it exists when no print shop runs", async () => {
    const { tools, store } = await ctxFor("valeria");
    const out = await tools.generate_flyer.run({ activity_id: "a09", vibe: "retro-cruise", tagline: "Cero vergüenza" });
    expect(out).toMatch(/pending, do not claim it is attached/);
    expect((await store.getActivity("a09"))!.flyerUrl).toMatch(/^pending:retro-cruise/);
  });
  it("makes a flyer and sends it to the passenger as an image", async () => {
    const made: unknown[] = [];
    const flyers = { make: async (id: string, vibe: string, lang: string, tagline?: string) => (made.push({ id, vibe, lang, tagline }), { url: `https://cdn.test/${id}.png` }) };
    const { tools, sent } = await ctxFor("valeria", NOW, { flyers });
    const out = await tools.generate_flyer.run({ activity_id: "a09", vibe: "fiesta" });
    expect(made).toEqual([{ id: "a09", vibe: "fiesta", lang: "es", tagline: undefined }]);
    expect(sent).toEqual([{ to: "Valeria Luna", text: "🎤 Karaoke de camarote", mediaUrl: "https://cdn.test/a09.png" }]);
    expect(out).toMatch(/sent to Valeria Luna as an image/);
  });
  it("hands out the passenger's own web link only", async () => {
    const { tools } = await ctxFor("valeria", NOW, { cabinLink: (p) => `https://ship.test/c/${p.id}.sig` });
    expect(await tools.my_cabin_link.run({})).toMatch(/https:\/\/ship\.test\/c\/valeria\.sig/);
    const none = await ctxFor("valeria");
    expect(await none.tools.my_cabin_link.run({})).toMatch(/not running/);
  });
});

describe("passenger context", () => {
  it("marks the passenger's own activities and includes memory", async () => {
    const { store, passenger } = await ctxFor("diego");
    const text = await buildPassengerContext(store, { person: passenger, now: NOW, text: "" });
    expect(text).toContain("Name: Diego Luna");
    expect(text).toContain("Ship time now:");
    expect(text).toMatch(/★ \[a03\] 🧘 Sunrise yoga con Sofía/);
    expect(text).toMatch(/ {2}\[a04\] 🎱 Bingo Lunático/);
    expect(text).toContain("competitive:");
  });
  it("indexes the rest of the voyage so later activities are found by name", async () => {
    const { store, passenger } = await ctxFor("valeria");
    const text = await buildPassengerContext(store, { person: passenger, now: NOW, text: "" });
    expect(text).toContain("# Rest of the voyage");
    expect(text).toMatch(/★ \[a09\] 2026-12-30 🎤 Karaoke de camarote/);
    expect(text.split("# Rest of the voyage")[1]).not.toContain("[a03]");
  });
  it("shows a headline on special days", async () => {
    const { store, passenger } = await ctxFor("sofia", new Date("2026-12-28T13:00:00Z"));
    const text = await buildPassengerContext(store, { person: passenger, now: new Date("2026-12-28T13:00:00Z"), text: "" });
    expect(text).toContain("Día de los Inocentes");
  });
});

describe("morning brief", () => {
  it("lists own activities and offers suggestions on a light day", async () => {
    const { store } = await ctxFor("ricardo");
    const ricardo = (await store.getPerson("ricardo"))!;
    const early = await buildMorningBrief(store, ricardo, "2026-12-29", new Date(mx("2026-12-29", "06:00")));
    expect(early.mine).toEqual([]);
    expect(early.suggestions.map((a) => a.id)).toEqual(["a06", "a07"]);
    expect(early.softMode).toBe(false);
    // Waking at 7:30, the 7:00 yoga has already started and is not offered.
    const late = await buildMorningBrief(store, ricardo, "2026-12-29", new Date(mx("2026-12-29", "07:30")));
    expect(late.suggestions.map((a) => a.id)).toEqual(["a07"]);
  });
  it("skips suggestions when the day is already full and whispers on Jan 1", async () => {
    const { store } = await ctxFor("diego");
    const diego = (await store.getPerson("diego"))!;
    const nye = await buildMorningBrief(store, diego, "2026-12-31", new Date(mx("2026-12-31", "07:30")));
    expect(nye.mine.map((a) => a.id)).toEqual(["a11", "a12"]);
    expect(nye.suggestions).toEqual([]);
    const jan1 = await buildMorningBrief(store, diego, "2027-01-01", new Date(mx("2027-01-01", "09:00")));
    expect(jan1.softMode).toBe(true);
    expect(jan1.suggestions.map((a) => a.id)).toEqual(["a13"]);
  });
});
