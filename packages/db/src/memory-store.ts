import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ActivityQuery, Store } from "./store.js";
import type {
  Activity,
  Conversation,
  Delivery,
  MemoryEntry,
  MessageLog,
  NewActivity,
  NewPerson,
  Person,
  Signup,
  SignupStatus,
} from "./types.js";

interface Snapshot {
  people: Person[];
  activities: Activity[];
  signups: Signup[];
  memory: MemoryEntry[];
  messages: MessageLog[];
  conversations: Conversation[];
  deliveries: Delivery[];
}

const empty = (): Snapshot => ({ people: [], activities: [], signups: [], memory: [], messages: [], conversations: [], deliveries: [] });

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

/**
 * In-memory store with optional JSON-file persistence. Good enough for the CLI harness,
 * tests and a single-process pilot; not for concurrent writers.
 */
export class MemoryStore implements Store {
  private data: Snapshot;
  private readonly file?: string;
  readonly now: () => Date;

  constructor(opts: { file?: string; now?: () => Date } = {}) {
    this.file = opts.file;
    this.now = opts.now ?? (() => new Date());
    this.data = this.file && existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Snapshot) : empty();
  }

  /** Replace the whole dataset (used by seeding and tests). */
  load(snapshot: Partial<Snapshot>): void {
    this.data = { ...empty(), ...snapshot };
    this.persist();
  }

  snapshot(): Snapshot {
    return structuredClone(this.data);
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // People
  async listPeople(): Promise<Person[]> {
    return [...this.data.people].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getPerson(id: string): Promise<Person | undefined> {
    return this.data.people.find((p) => p.id === id);
  }
  async findPersonByPhone(phoneE164: string): Promise<Person | undefined> {
    return this.data.people.find((p) => p.phoneE164 === phoneE164);
  }
  async findPersonByName(name: string): Promise<Person | undefined> {
    const n = normalize(name);
    return (
      this.data.people.find((p) => normalize(p.name) === n || (p.nickname && normalize(p.nickname) === n)) ??
      this.data.people.find((p) => normalize(p.name).startsWith(n) || normalize(p.name).split(" ").includes(n))
    );
  }
  async createPerson(input: NewPerson): Promise<Person> {
    const person: Person = {
      humor: "full",
      wakeTime: "07:30",
      ...input,
      id: randomUUID(),
      icsToken: randomBytes(12).toString("base64url"),
      joinedAt: this.ts(),
    };
    this.data.people.push(person);
    this.persist();
    return person;
  }
  async updatePerson(id: string, patch: Partial<Omit<Person, "id">>): Promise<Person> {
    const p = this.data.people.find((x) => x.id === id);
    if (!p) throw new Error(`person not found: ${id}`);
    Object.assign(p, patch);
    this.persist();
    return p;
  }

  // Activities
  async listActivities(q: ActivityQuery = {}): Promise<Activity[]> {
    return this.data.activities
      .filter((a) => (q.from ? a.startsAt >= q.from : true))
      .filter((a) => (q.to ? a.startsAt < q.to : true))
      .filter((a) => (q.status ? q.status.includes(a.status) : a.status !== "cancelled"))
      .filter((a) => (q.sponsorId ? a.sponsorId === q.sponsorId : true))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }
  async getActivity(id: string): Promise<Activity | undefined> {
    return this.data.activities.find((a) => a.id === id);
  }
  async createActivity(input: NewActivity): Promise<Activity> {
    const activity: Activity = { status: "published", ...input, id: randomUUID().slice(0, 8), createdAt: this.ts() };
    this.data.activities.push(activity);
    this.persist();
    return activity;
  }
  async updateActivity(id: string, patch: Partial<Omit<Activity, "id" | "createdAt">>): Promise<Activity> {
    const a = this.data.activities.find((x) => x.id === id);
    if (!a) throw new Error(`activity not found: ${id}`);
    Object.assign(a, patch);
    this.persist();
    return a;
  }

  // Sign-ups
  async listSignups(activityId: string): Promise<Signup[]> {
    return this.data.signups.filter((s) => s.activityId === activityId);
  }
  async listSignupsForPerson(personId: string): Promise<Signup[]> {
    return this.data.signups.filter((s) => s.personId === personId);
  }
  async setSignup(activityId: string, personId: string, status: SignupStatus): Promise<Signup> {
    let s = this.data.signups.find((x) => x.activityId === activityId && x.personId === personId);
    if (s) {
      s.status = status;
    } else {
      s = { activityId, personId, status, createdAt: this.ts() };
      this.data.signups.push(s);
    }
    this.persist();
    return s;
  }
  async markReminded(activityId: string, personId: string, at: string): Promise<void> {
    const s = this.data.signups.find((x) => x.activityId === activityId && x.personId === personId);
    if (s) s.remindedAt = at;
    this.persist();
  }

  // Memory
  async remember(personId: string, key: string, value: string): Promise<MemoryEntry> {
    let m = this.data.memory.find((x) => x.personId === personId && x.key === key);
    if (m) {
      m.value = value;
      m.updatedAt = this.ts();
    } else {
      m = { personId, key, value, updatedAt: this.ts() };
      this.data.memory.push(m);
    }
    this.persist();
    return m;
  }
  async getMemory(personId: string): Promise<MemoryEntry[]> {
    return this.data.memory.filter((m) => m.personId === personId);
  }
  async forget(personId: string, key: string): Promise<void> {
    this.data.memory = this.data.memory.filter((m) => !(m.personId === personId && m.key === key));
    this.persist();
  }

  // Log
  async logMessage(entry: Omit<MessageLog, "id" | "ts"> & { ts?: string }): Promise<MessageLog> {
    const log: MessageLog = { ...entry, id: randomUUID(), ts: entry.ts ?? this.ts() };
    this.data.messages.push(log);
    this.persist();
    return log;
  }
  async listMessages(personId: string, limit = 50): Promise<MessageLog[]> {
    return this.data.messages.filter((m) => m.personId === personId).slice(-limit);
  }

  // Conversations
  async getConversation(personId: string): Promise<Conversation | undefined> {
    return this.data.conversations.find((c) => c.personId === personId);
  }
  async saveConversation(personId: string, history: unknown[]): Promise<Conversation> {
    let c = this.data.conversations.find((x) => x.personId === personId);
    if (c) {
      c.history = history;
      c.updatedAt = this.ts();
    } else {
      c = { personId, history, updatedAt: this.ts() };
      this.data.conversations.push(c);
    }
    this.persist();
    return c;
  }
  async clearConversation(personId: string): Promise<void> {
    this.data.conversations = this.data.conversations.filter((c) => c.personId !== personId);
    this.persist();
  }

  // Deliveries
  async wasDelivered(kind: Delivery["kind"], key: string): Promise<boolean> {
    return this.data.deliveries.some((d) => d.kind === kind && d.key === key);
  }
  async getDelivery(kind: Delivery["kind"], key: string): Promise<Delivery | undefined> {
    return this.data.deliveries.find((d) => d.kind === kind && d.key === key);
  }
  async markDelivered(kind: Delivery["kind"], key: string, payload?: unknown): Promise<Delivery> {
    const existing = this.data.deliveries.find((d) => d.kind === kind && d.key === key);
    if (existing) return existing;
    const d: Delivery = { kind, key, sentAt: this.ts(), ...(payload !== undefined ? { payload } : {}) };
    this.data.deliveries.push(d);
    this.persist();
    return d;
  }
}
