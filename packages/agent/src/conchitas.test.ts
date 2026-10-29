import { MemoryStore, mx, seedSample, type Person } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { CONCHITAS, chestFor } from "./conchitas.js";
import { buildPassengerContext } from "./context.js";
import { attendanceAskText, tick } from "./scheduler.js";
import { buildTools, type ToolContext } from "./tools.js";

// Dec 27, 9:00 am ship time: Sofía's sunrise yoga (a03, 7:00–7:45, Diego and Valeria going) is over; bingo (a04) is tonight.
const NOW = new Date(mx("2026-12-27", "09:00"));

function setup(now = NOW) {
  const store = new MemoryStore({ now: () => now });
  seedSample(store);
  const sent: { to: string; text: string }[] = [];
  const tools = async (id: string) => {
    const ctx: ToolContext = { store, passenger: (await store.getPerson(id)) as Person, now, outbox: { send: async (to, text) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }) } };
    return Object.fromEntries(buildTools(ctx).map((t) => [t.name, t])) as Record<string, { run: (input: any) => Promise<string> }>;
  };
  const chest = async (id: string) => chestFor(store, (await store.getPerson(id))!, now);
  return { store, sent, tools, chest };
}

describe("conchitas 🐚", () => {
  it("pays the guest when the host vouches for them, and the host when a guest confirms it happened", async () => {
    const { tools, chest } = setup();
    expect((await chest("diego")).balance).toBe(0);
    expect((await chest("diego")).toConfirm.map((a) => a.id)).toEqual(["a03"]);
    expect((await chest("sofia")).toMark.map((a) => a.id)).toEqual(["a03"]);

    // Sofía (host) says Diego came: Diego earns his 10; Sofía still waits for a guest to vouch.
    const marked = await (await tools("sofia")).mark_attendance.run({ activity_id: "a03", people: ["Diego"] });
    expect(marked).toMatch(/Marked as there \(\+10 conchitas each\): Diego Luna/);
    expect(marked).toMatch(/Signed up but not marked: Valeria Luna/);
    expect((await chest("diego")).balance).toBe(CONCHITAS.guest);
    expect((await chest("sofia")).balance).toBe(0);
    expect((await chest("sofia")).toMark).toEqual([]);

    // Valeria confirms it happened: Sofía earns 30; Valeria's own 10 wait for Sofía.
    expect(await (await tools("valeria")).confirm_event.run({ activity_id: "a03" })).toMatch(/Sofía Luna gets 30 conchitas.*count once the host marks/);
    expect((await chest("sofia")).balance).toBe(CONCHITAS.host);
    expect((await chest("valeria")).balance).toBe(0);
    expect((await chest("valeria")).lines[0]).toMatchObject({ role: "guest", earned: false });
    await (await tools("sofia")).mark_attendance.run({ activity_id: "a03", people: ["Valeria"] });
    expect((await chest("valeria")).balance).toBe(CONCHITAS.guest);

    // Confirming twice doesn't pay twice; taking someone off takes their conchitas away.
    await (await tools("diego")).confirm_event.run({ activity_id: "a03" });
    expect((await chest("sofia")).balance).toBe(CONCHITAS.host);
    await (await tools("sofia")).mark_attendance.run({ activity_id: "a03", people: ["Diego"], attended: false });
    expect((await chest("diego")).balance).toBe(0);

    expect(await (await tools("diego")).my_conchitas.run({})).toMatch(/^Diego Luna: 0 conchitas\.\n- went to \[a03\] Sunrise yoga con Sofía: 10 \(waiting for the host to mark them\)/);
  });

  it("refuses what doesn't add up: not your activity, not yet, the host vouching for themselves", async () => {
    const { tools } = setup();
    expect(await (await tools("diego")).mark_attendance.run({ activity_id: "a03", people: ["Valeria"] })).toMatch(/^NOT ALLOWED/);
    expect(await (await tools("sofia")).confirm_event.run({ activity_id: "a03" })).toMatch(/^NOT ALLOWED/);
    expect(await (await tools("carmen")).confirm_event.run({ activity_id: "a04" })).toMatch(/^NOT YET/);
    expect(await (await tools("ricardo")).mark_attendance.run({ activity_id: "a04", people: ["Carmen"] })).toMatch(/^NOT YET/);
    expect(await (await tools("sofia")).mark_attendance.run({ activity_id: "a03", people: ["Sofía"] })).toMatch(/Marked as there .*: nobody/);
  });

  it("puts what to ask in the Capitán's context", async () => {
    const { store, tools } = setup();
    const ctx = async (id: string) => buildPassengerContext(store, { person: (await store.getPerson(id))!, now: NOW, text: "" });
    expect(await ctx("diego")).toMatch(/# Conchitas 🐚: 0\n- to confirm it happened \(ask: ¿se hizo\?\): \[a03\] Sunrise yoga con Sofía/);
    expect(await ctx("sofia")).toMatch(/- hosted, to say who came \(ask: ¿quién vino\?\): \[a03\]/);
    await (await tools("diego")).confirm_event.run({ activity_id: "a03" });
    expect(await ctx("diego")).not.toContain("to confirm it happened");
    expect(await ctx("sofia")).toMatch(/# Conchitas 🐚: 30/);
  });

  it("asks the host who came and each guest whether it happened, once, after the activity", async () => {
    const { store, sent } = setup();
    const deps = {
      store,
      outbox: { send: async (to: Person | "everyone", text: string) => void sent.push({ to: to === "everyone" ? "everyone" : to.id, text }) },
      writeMorning: async () => {
        throw new Error("no mornings in this test");
      },
      useTemplates: false,
      pageLink: (p: Person, path: string) => `https://ship.test/c/${p.id}${path}`,
    };
    // 7:50: the yoga ended 5 minutes ago, too soon.
    expect((await tick(deps, new Date(mx("2026-12-27", "07:50")))).attendanceAsks).toEqual([]);
    const r = await tick(deps, new Date(mx("2026-12-27", "08:05")));
    expect(r.attendanceAsks.sort()).toEqual(["a03:diego", "a03:sofia", "a03:valeria"]);
    expect(sent.find((m) => m.to === "sofia")!.text).toBe(`${attendanceAskText((await store.getActivity("a03"))!, (await store.getPerson("sofia"))!, undefined, true)}\nhttps://ship.test/c/sofia/a/a03`);
    expect(sent.find((m) => m.to === "sofia")!.text).toMatch(/^🐚 ¿Quién vino a 🧘 Sunrise yoga con Sofía\?/);
    expect(sent.find((m) => m.to === "diego")!.text).toMatch(/^🐚 Did 🧘 Sunrise yoga con Sofía happen\? Reply "yes".*Sofía earns 30 sand dollars/);
    expect((await tick(deps, new Date(mx("2026-12-27", "08:06")))).attendanceAsks).toEqual([]);
  });
});
