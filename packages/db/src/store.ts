import type {
  Activity,
  Conversation,
  Delivery,
  MemoryEntry,
  MessageLog,
  NewActivity,
  NewPerson,
  Person,
  PersonPatch,
  Signup,
  SignupStatus,
} from "./types.js";

export interface ActivityQuery {
  /** Inclusive ISO instant lower bound on startsAt. */
  from?: string;
  /** Exclusive ISO instant upper bound on startsAt. */
  to?: string;
  status?: Activity["status"][];
  sponsorId?: string;
}

/**
 * The persistence contract the agent and workers program against.
 * `MemoryStore` implements it for local dev and tests; a Postgres implementation
 * (see sql/001_init.sql) is the production target.
 */
export interface Store {
  // People
  listPeople(): Promise<Person[]>;
  getPerson(id: string): Promise<Person | undefined>;
  findPersonByPhone(phoneE164: string): Promise<Person | undefined>;
  findPersonByName(name: string): Promise<Person | undefined>;
  createPerson(input: NewPerson): Promise<Person>;
  updatePerson(id: string, patch: PersonPatch): Promise<Person>;
  /**
   * Takes a passenger off the manifest with their sign-ups, memory and chat history; their cancelled
   * activities go too and kids they guarded lose the link. Throws while they host live activities.
   */
  removePerson(id: string): Promise<void>;

  // Activities
  listActivities(q?: ActivityQuery): Promise<Activity[]>;
  getActivity(id: string): Promise<Activity | undefined>;
  createActivity(input: NewActivity): Promise<Activity>;
  updateActivity(id: string, patch: Partial<Omit<Activity, "id" | "createdAt">>): Promise<Activity>;

  // Sign-ups
  listSignups(activityId: string): Promise<Signup[]>;
  listSignupsForPerson(personId: string): Promise<Signup[]>;
  setSignup(activityId: string, personId: string, status: SignupStatus): Promise<Signup>;
  markReminded(activityId: string, personId: string, at: string): Promise<void>;

  // Memory
  remember(personId: string, key: string, value: string): Promise<MemoryEntry>;
  getMemory(personId: string): Promise<MemoryEntry[]>;
  forget(personId: string, key: string): Promise<void>;

  // Log
  logMessage(entry: Omit<MessageLog, "id" | "ts"> & { ts?: string }): Promise<MessageLog>;
  listMessages(personId: string, limit?: number): Promise<MessageLog[]>;

  // Conversations (chat history per passenger)
  getConversation(personId: string): Promise<Conversation | undefined>;
  saveConversation(personId: string, history: unknown[]): Promise<Conversation>;
  clearConversation(personId: string): Promise<void>;

  // Ship-wide settings (e.g. "paused")
  getSetting<T = unknown>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): Promise<void>;

  // Scheduled-send idempotency
  wasDelivered(kind: Delivery["kind"], key: string): Promise<boolean>;
  getDelivery(kind: Delivery["kind"], key: string): Promise<Delivery | undefined>;
  markDelivered(kind: Delivery["kind"], key: string, payload?: unknown): Promise<Delivery>;
}

/** The admin pause switch: while it is on, nothing proactive goes out and only admins get real replies. */
export async function isPaused(store: Store): Promise<boolean> {
  return (await store.getSetting<boolean>("paused")) === true;
}
