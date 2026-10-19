import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";
import { seedSample } from "./seed.js";
import { dayBounds, mx } from "./time.js";

const fresh = () => {
  const store = new MemoryStore({ now: () => new Date("2026-12-27T15:00:00Z") });
  seedSample(store);
  return store;
};

describe("MemoryStore", () => {
  it("seeds a roster and an 8-day program", async () => {
    const store = fresh();
    expect((await store.listPeople()).length).toBe(6);
    const acts = await store.listActivities();
    expect(acts.length).toBe(14);
    expect(acts[0].title).toMatch(/Simulacro/);
  });
  it("filters activities by ship-local day", async () => {
    const store = fresh();
    const { from, to } = dayBounds("2026-12-31");
    const nye = await store.listActivities({ from, to });
    expect(nye.map((a) => a.title)).toEqual(["Sunrise yoga con Sofía", "Cena de gala con disfraces", "Cuenta regresiva en el Puente"]);
  });
  it("hides cancelled activities unless asked", async () => {
    const store = fresh();
    await store.updateActivity("a04", { status: "cancelled", cancelledReason: "test" });
    expect((await store.listActivities()).some((a) => a.id === "a04")).toBe(false);
    expect((await store.listActivities({ status: ["cancelled"] })).map((a) => a.id)).toEqual(["a04"]);
  });
  it("upserts sign-ups", async () => {
    const store = fresh();
    await store.setSignup("a09", "ricardo", "maybe");
    await store.setSignup("a09", "ricardo", "going");
    const s = await store.listSignups("a09");
    expect(s.filter((x) => x.personId === "ricardo")).toHaveLength(1);
    expect(s[0].status).toBe("going");
  });
  it("finds people by name, nickname, first name, accent-insensitively", async () => {
    const store = fresh();
    expect((await store.findPersonByName("sofia"))?.id).toBe("sofia");
    expect((await store.findPersonByName("Abuela Carmen"))?.id).toBe("carmen");
    expect((await store.findPersonByName("carmen"))?.id).toBe("carmen");
    expect((await store.findPersonByName("Ricardo"))?.id).toBe("ricardo");
    expect(await store.findPersonByName("Nadie")).toBeUndefined();
  });
  it("remembers and forgets", async () => {
    const store = fresh();
    await store.remember("sofia", "coffee", "black, no sugar");
    await store.remember("sofia", "coffee", "oat latte");
    expect((await store.getMemory("sofia")).map((m) => m.value)).toEqual(["oat latte"]);
    await store.forget("sofia", "coffee");
    expect(await store.getMemory("sofia")).toEqual([]);
  });
  it("creates activities with generated ids and timestamps", async () => {
    const store = fresh();
    const a = await store.createActivity({
      title: "Dominó",
      emoji: "🁣",
      sponsorId: "ricardo",
      startsAt: mx("2026-12-29", "20:00"),
      endsAt: mx("2026-12-29", "22:00"),
      location: "Gran Salón",
      createdVia: "cli",
    });
    expect(a.id).toHaveLength(8);
    expect(a.status).toBe("published");
    expect(a.createdAt).toBe("2026-12-27T15:00:00.000Z");
  });
});
