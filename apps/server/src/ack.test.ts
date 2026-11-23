import { MemoryStore, mx, seedSample } from "@crucero/db";
import { describe, expect, it } from "vitest";
import { acknowledgment } from "./ack.js";

const NOW = new Date(mx("2026-12-27", "15:00"));

describe("what the Capitán says while he acts", () => {
  it("names the action, the activity and the person, in the caller's language", async () => {
    const store = new MemoryStore({ now: () => NOW });
    seedSample(store);
    const sofia = (await store.getPerson("sofia"))!;
    const diego = (await store.getPerson("diego"))!; // reads English
    const say = (p: typeof sofia, tool: string, input: Record<string, unknown> = {}) => acknowledgment(store, p, tool, input, NOW);
    expect(await say(sofia, "signup", { activity_id: "a04", status: "going" })).toBe("Va, te apunto a Bingo Lunático... ");
    expect(await say(sofia, "signup", { activity_id: "a04", status: "going", person_name: "Mateo" })).toBe("Va, apunto a Mateo a Bingo Lunático... ");
    expect(await say(sofia, "signup", { activity_id: "a04", status: "out" })).toBe("Te quito de Bingo Lunático... ");
    expect(await say(sofia, "get_program", { date: "2026-12-27" })).toBe("Déjame revisar el programa de hoy... ");
    expect(await say(sofia, "get_program", { date: "2026-12-28" })).toBe("Déjame revisar el programa de mañana... ");
    expect(await say(sofia, "get_program", { date: "2026-12-31" })).toBe("Déjame revisar el programa del jueves, 31 de diciembre... ");
    expect(await say(sofia, "send_message", { to: "Ricardo", text: "x" })).toBe("Le mando tu mensaje a Ricardo... ");
    expect(await say(sofia, "send_message", { to: "everyone", text: "x" })).toBe("Lo anuncio a todo el barco... ");
    expect(await say(sofia, "create_activity", { title: "Torneo de dominó" })).toBe("Anoto Torneo de dominó en el programa... ");
    expect(await say(sofia, "generate_flyer", { activity_id: "a09", vibe: "retro-cruise" })).toBe("Mando el flyer de Karaoke de camarote a la imprenta... ");
    expect(await say(diego, "who_is_going", { activity_id: "a04" })).toBe("Let me see who's going to Bingo Lunático... ");
    expect(await say(diego, "signup", { activity_id: "nope", status: "maybe" })).toBe("Putting you down as a maybe for that one... ");
    // Instant tools need no holding line.
    for (const tool of ["remember", "set_preferences", "my_cabin_link", "admin_pause"]) expect(await say(sofia, tool)).toBeUndefined();
  });
});
