/** Shared domain types for the Crucero Luna. Times are ISO-8601 UTC strings. */

export type Language = "es" | "en";
export type Role = "adult" | "kid";
export type HumorLevel = "full" | "light" | "off";
export type ActivityStatus = "draft" | "published" | "cancelled";
export type SignupStatus = "going" | "maybe" | "out";
export type Channel = "cli" | "whatsapp" | "web" | "voice" | "system";

export interface Person {
  id: string;
  name: string;
  nickname?: string;
  phoneE164?: string;
  language: Language;
  role: Role;
  /** For kids: the adult who receives their reminders. */
  guardianId?: string;
  humor: HumorLevel;
  /** Local wall-clock hours in which the Capitán stays silent, e.g. { start: "22:00", end: "08:00" }. */
  quietHours?: { start: string; end: string };
  /** Local wall-clock time for the morning message, "HH:MM". */
  wakeTime: string;
  icsToken: string;
  joinedAt: string;
}

export interface Activity {
  id: string;
  title: string;
  emoji: string;
  description?: string;
  sponsorId: string;
  startsAt: string;
  endsAt: string;
  /** Free text, in ship-speak: "Lido Deck (balcón)", "Playa Condesa". */
  location: string;
  capacity?: number;
  bring?: string;
  status: ActivityStatus;
  flyerUrl?: string;
  createdVia: Channel;
  createdAt: string;
  cancelledReason?: string;
}

export interface Signup {
  activityId: string;
  personId: string;
  status: SignupStatus;
  createdAt: string;
  remindedAt?: string;
}

export interface MemoryEntry {
  personId: string;
  key: string;
  value: string;
  updatedAt: string;
}

export interface MessageLog {
  id: string;
  personId?: string;
  channel: Channel;
  direction: "in" | "out";
  body: string;
  mediaUrl?: string;
  toolCalls?: unknown;
  ts: string;
}

export type NewActivity = Omit<Activity, "id" | "createdAt" | "status"> & { status?: ActivityStatus };
export type NewPerson = Omit<Person, "id" | "icsToken" | "joinedAt" | "humor" | "wakeTime"> &
  Partial<Pick<Person, "humor" | "wakeTime">>;
