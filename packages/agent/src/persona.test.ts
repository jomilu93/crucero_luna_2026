import { describe, expect, it } from "vitest";
import { CAPTAIN_NAME, MASCOT_NAME, SHIP_FORMER_NAME, SHIP_NAME } from "./brand.js";
import { PERSONA } from "./persona.js";

describe("persona", () => {
  it("names the ship, its former name, the Greek captain and his first mate", () => {
    expect(PERSONA).toContain(`**${CAPTAIN_NAME}**`);
    expect(PERSONA).toContain(SHIP_NAME);
    expect(PERSONA).toContain(SHIP_FORMER_NAME);
    expect(PERSONA).toContain(`la Primera Oficial ${MASCOT_NAME}** (she/her)`);
    expect(PERSONA).toMatch(/Greek/);
    expect(PERSONA).not.toMatch(/Lunático\b/); // the old name
  });

  it("keeps the humor guard rails for the new running gags", () => {
    expect(PERSONA).toMatch(/counts as the message's one gag: a Manpaty "clink clink", a tale from your seafaring past/);
    expect(PERSONA).toMatch(/special occasions/);
    expect(PERSONA).toMatch(/"card shark".*age jokes/);
    expect(PERSONA).toMatch(/never joke about anyone's body, age, health, relationships, money or parenting/);
  });

  it("stays free of per-request data so it caches", () => {
    expect(PERSONA).not.toMatch(/\$\{|20\d\d-\d\d-\d\dT/);
  });
});
