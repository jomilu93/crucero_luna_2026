import { MemoryStore, seedSample, type Person } from "@crucero/db";
import type { Outbox } from "@crucero/agent";

/** Load the dev store: JSON file if CRUCERO_DATA_FILE is set, seeded on first run. */
export function openStore(opts: { now?: () => Date } = {}): MemoryStore {
  const file = process.env.CRUCERO_DATA_FILE || undefined;
  const store = new MemoryStore({ file, now: opts.now });
  if (!store.snapshot().people.length) seedSample(store);
  return store;
}

/** Console outbox: prints what WhatsApp would deliver. */
export const consoleOutbox: Outbox = {
  async send(to, text) {
    const who = to === "everyone" ? "EVERYONE" : to.name;
    console.log(`\n   📨 → ${who}\n${text.split("\n").map((l) => `      ${l}`).join("\n")}\n`);
  },
};

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    }
  }
  return out;
}

export function describePerson(p: Person): string {
  return `${p.name} (${p.id}, ${p.language}, ${p.role}, humor ${p.humor})`;
}
