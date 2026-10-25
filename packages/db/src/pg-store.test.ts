import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgStore, type Queryable } from "./pg-store.js";
import { dayBounds, mx } from "./time.js";
import type { Person } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

let pg: PGlite;
let store: PgStore;
let sofia: Person;
let diego: Person;

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(join(here, "..", "sql")).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(join(here, "..", "sql", f), "utf8"));
  const db: Queryable = { query: async (text, params = []) => (await pg.query(text, params)).rows as never };
  store = new PgStore(db);
  sofia = await store.createPerson({ name: "Sofía Luna", phoneE164: "+15550000001", language: "es", role: "adult", wakeTime: "06:30" });
  diego = await store.createPerson({ name: "Diego Luna", phoneE164: "+15550000002", language: "en", role: "adult" });
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe("PgStore on a real Postgres (PGlite)", () => {
  it("creates people with defaults and finds them by phone and name", async () => {
    expect(sofia.humor).toBe("full");
    expect(sofia.wakeTime).toBe("06:30");
    expect(diego.wakeTime).toBe("07:30");
    expect(sofia.icsToken.length).toBeGreaterThan(8);
    expect((await store.findPersonByPhone("+15550000002"))?.id).toBe(diego.id);
    expect((await store.findPersonByName("sofia"))?.id).toBe(sofia.id);
    expect((await store.findPersonByName("Sofía Luna"))?.id).toBe(sofia.id);
    expect(await store.findPersonByName("nadie")).toBeUndefined();
  });

  it("keeps a web passenger's own phone apart from their chat address, and admins created as such", async () => {
    const web = await store.createPerson({ name: "Tía Lupe", contactPhone: "+525512345678", language: "es", role: "adult", admin: true });
    expect(web).toMatchObject({ contactPhone: "+525512345678", admin: true });
    expect(web.phoneE164).toBeUndefined();
    const linked = await store.updatePerson(web.id, { phoneE164: "tg:42" });
    expect(linked).toMatchObject({ phoneE164: "tg:42", contactPhone: "+525512345678" });
    await expect(store.createPerson({ name: "Otra", contactPhone: "+525512345678", language: "es", role: "adult" })).rejects.toThrow();
    await store.removePerson(web.id);
  });

  it("updates people including quiet hours", async () => {
    const p = await store.updatePerson(diego.id, { humor: "light", quietHours: { start: "22:00", end: "08:00" }, nickname: "Dieguito" });
    expect(p.humor).toBe("light");
    expect(p.quietHours).toEqual({ start: "22:00", end: "08:00" });
    expect((await store.findPersonByName("dieguito"))?.id).toBe(diego.id);
    const cleared = await store.updatePerson(diego.id, { quietHours: undefined, humor: "full" });
    expect(cleared.quietHours).toEqual({ start: "22:00", end: "08:00" }); // undefined fields are skipped, not nulled
    expect((await store.updatePerson(diego.id, { muted: true })).muted).toBe(true);
    expect((await store.updatePerson(diego.id, { muted: false })).muted).toBeUndefined();
  });

  it("creates, lists, filters and updates activities", async () => {
    const yoga = await store.createActivity({
      title: "Sunrise yoga",
      emoji: "🧘",
      sponsorId: sofia.id,
      startsAt: mx("2026-12-28", "07:00"),
      endsAt: mx("2026-12-28", "07:45"),
      location: "Lido Deck",
      capacity: 8,
      createdVia: "web",
    });
    const bingo = await store.createActivity({
      title: "Bingo",
      emoji: "🎱",
      sponsorId: diego.id,
      startsAt: mx("2026-12-27", "20:00"),
      endsAt: mx("2026-12-27", "21:30"),
      location: "Gran Salón",
      createdVia: "cli",
    });
    expect(yoga.id).toHaveLength(8);
    expect(yoga.status).toBe("published");
    expect(yoga.startsAt).toBe("2026-12-28T13:00:00.000Z");

    const all = await store.listActivities();
    expect(all.map((a) => a.title)).toEqual(["Bingo", "Sunrise yoga"]);
    const { from, to } = dayBounds("2026-12-28");
    expect((await store.listActivities({ from, to })).map((a) => a.id)).toEqual([yoga.id]);
    expect((await store.listActivities({ sponsorId: diego.id })).map((a) => a.id)).toEqual([bingo.id]);

    const moved = await store.updateActivity(yoga.id, { startsAt: mx("2026-12-28", "07:30"), capacity: 10 });
    expect(moved.startsAt).toBe(mx("2026-12-28", "07:30"));
    expect(moved.capacity).toBe(10);

    await store.updateActivity(bingo.id, { status: "cancelled", cancelledReason: "lluvia" });
    expect((await store.listActivities()).map((a) => a.id)).toEqual([yoga.id]);
    expect((await store.listActivities({ status: ["cancelled"] }))[0].cancelledReason).toBe("lluvia");
  });

  it("upserts sign-ups and marks reminders", async () => {
    const [yoga] = await store.listActivities();
    await store.setSignup(yoga.id, diego.id, "maybe");
    const s = await store.setSignup(yoga.id, diego.id, "going");
    expect(s.status).toBe("going");
    expect(await store.listSignups(yoga.id)).toHaveLength(1);
    expect((await store.listSignupsForPerson(diego.id))[0].activityId).toBe(yoga.id);
    await store.markReminded(yoga.id, diego.id, "2026-12-28T12:30:00.000Z");
    expect((await store.listSignups(yoga.id))[0].remindedAt).toBe("2026-12-28T12:30:00.000Z");
  });

  it("rejects an activity that ends before it starts", async () => {
    await expect(
      store.createActivity({ title: "Bad", emoji: "x", sponsorId: sofia.id, startsAt: mx("2026-12-28", "10:00"), endsAt: mx("2026-12-28", "09:00"), location: "x", createdVia: "cli" }),
    ).rejects.toThrow();
  });

  it("stores memory, messages, conversations and deliveries", async () => {
    await store.remember(sofia.id, "coffee", "black");
    await store.remember(sofia.id, "coffee", "oat latte");
    expect((await store.getMemory(sofia.id)).map((m) => m.value)).toEqual(["oat latte"]);
    await store.forget(sofia.id, "coffee");
    expect(await store.getMemory(sofia.id)).toEqual([]);

    await store.logMessage({ personId: sofia.id, channel: "whatsapp", direction: "in", body: "hola" });
    await store.logMessage({ personId: sofia.id, channel: "whatsapp", direction: "out", body: "¡Ahoy!", toolCalls: [{ name: "get_program" }] });
    const log = await store.listMessages(sofia.id);
    expect(log.map((m) => m.body)).toEqual(["hola", "¡Ahoy!"]);
    expect(log[1].toolCalls).toEqual([{ name: "get_program" }]);

    const history = [{ role: "user", content: "hola" }, { role: "assistant", content: [{ type: "text", text: "¡Ahoy!" }] }];
    await store.saveConversation(sofia.id, history);
    expect((await store.getConversation(sofia.id))?.history).toEqual(history);
    await store.clearConversation(sofia.id);
    expect(await store.getConversation(sofia.id)).toBeUndefined();

    expect(await store.wasDelivered("morning", `${sofia.id}:2026-12-28`)).toBe(false);
    await store.markDelivered("morning", `${sofia.id}:2026-12-28`, { full_message: "Buenos días" });
    await store.markDelivered("morning", `${sofia.id}:2026-12-28`); // idempotent, keeps the first payload
    expect(await store.wasDelivered("morning", `${sofia.id}:2026-12-28`)).toBe(true);
    expect((await store.getDelivery("morning", `${sofia.id}:2026-12-28`))?.payload).toEqual({ full_message: "Buenos días" });
    await store.markDelivered("reminder", "x");
    expect((await store.getDelivery("reminder", "x"))?.payload).toBeUndefined();
  });

  it("stores the admin flag and ship settings, and removes a passenger cleanly", async () => {
    expect(await store.getSetting("paused")).toBeUndefined();
    await store.setSetting("paused", true);
    expect(await store.getSetting("paused")).toBe(true);
    await store.setSetting("paused", false);
    expect(await store.getSetting("paused")).toBe(false);

    const fake = await store.createPerson({ name: "Test Number", phoneE164: "+16315551181", language: "es", role: "adult" });
    expect((await store.updatePerson(fake.id, { admin: true })).admin).toBe(true);
    const kid = await store.createPerson({ name: "Kid Test", language: "es", role: "kid", guardianId: fake.id });
    const hosted = await store.createActivity({ title: "Prueba", emoji: "🧪", sponsorId: fake.id, startsAt: mx("2026-12-30", "10:00"), endsAt: mx("2026-12-30", "11:00"), location: "Lido", createdVia: "web" });
    await store.setSignup(hosted.id, sofia.id, "going");
    await store.remember(fake.id, "k", "v");
    await store.saveConversation(fake.id, [{ role: "user", content: "hi" }]);
    await store.logMessage({ personId: fake.id, channel: "telegram", direction: "in", body: "hi" });
    await expect(store.removePerson(fake.id)).rejects.toThrow(/still hosts "Prueba"/);
    await store.updateActivity(hosted.id, { status: "cancelled" });
    await store.removePerson(fake.id);
    expect(await store.getPerson(fake.id)).toBeUndefined();
    expect(await store.getActivity(hosted.id)).toBeUndefined();
    expect((await store.getPerson(kid.id))!.guardianId).toBeUndefined();
    expect(await store.getConversation(fake.id)).toBeUndefined();
    expect((await store.updatePerson(kid.id, { guardianId: sofia.id })).guardianId).toBe(sofia.id);
    expect((await store.updatePerson(kid.id, { guardianId: null })).guardianId).toBeUndefined();
  });
});
