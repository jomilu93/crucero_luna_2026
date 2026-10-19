/** Shared domain types for the Crucero Luna. Times are ISO-8601 UTC strings. */

export type Language = "es" | "en";
export type Role = "adult" | "kid";
export type HumorLevel = "full" | "light" | "off";
export type ActivityStatus = "draft" | "published" | "cancelled";
export type SignupStatus = "going" | "maybe" | "out";
export type Channel = "cli" | "whatsapp" | "telegram" | "web" | "voice" | "system";

export interface Person {
  id: string;
  name: string;
  nickname?: string;
  /** Channel address: E.164 for WhatsApp, `tg:<chat id>` for Telegram. */
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
  /** Opted out of proactive messages (morning, reminders, nudges, announcements); replies still flow. */
  muted?: boolean;
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

/** Persisted chat history per passenger so WhatsApp turns continue the same conversation. */
export interface Conversation {
  personId: string;
  /** Anthropic message params (user/assistant turns incl. tool use). Opaque to the store. */
  history: unknown[];
  updatedAt: string;
}

/** Idempotency record for scheduled sends: one row per (kind, key), e.g. ("morning", "sofia:2026-12-28"). */
export interface Delivery {
  kind: "morning" | "morning_full" | "reminder" | "sponsor_nudge" | "announcement";
  key: string;
  sentAt: string;
  /** Optional data for a follow-up step, e.g. the full morning message waiting behind the template knock. */
  payload?: unknown;
}

export type NewActivity = Omit<Activity, "id" | "createdAt" | "status"> & { status?: ActivityStatus };
export type NewPerson = Omit<Person, "id" | "icsToken" | "joinedAt" | "humor" | "wakeTime"> &
  Partial<Pick<Person, "humor" | "wakeTime">>;
