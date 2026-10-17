import type {
  Activity,
  MemoryEntry,
  MessageLog,
  NewActivity,
  NewPerson,
  Person,
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
  updatePerson(id: string, patch: Partial<Omit<Person, "id">>): Promise<Person>;

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
}
