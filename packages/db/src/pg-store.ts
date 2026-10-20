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
  PersonPatch,
  Signup,
  SignupStatus,
} from "./types.js";

/**
 * Minimal query surface so the same store runs on postgres.js in production and on
 * PGlite (in-process Postgres) in tests. Parameters use $1, $2, ...
 */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/** Adapter for the `postgres` package: `fromPostgresJs(postgres(DATABASE_URL))`. */
// Loosely typed on purpose: postgres.js's `unsafe` has an elaborate generic signature we don't need here.
export function fromPostgresJs(sql: { unsafe: (text: string, params?: any) => PromiseLike<unknown> }): Queryable {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params)) as unknown as T[];
    },
  };
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const hhmm = (v: unknown): string => String(v).slice(0, 5);
const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));

function rowToPerson(r: Row): Person {
  return {
    id: String(r.id),
    name: String(r.name),
    nickname: opt<string>(r.nickname),
    phoneE164: opt<string>(r.phone_e164),
    language: r.language as Person["language"],
    role: r.role as Person["role"],
    guardianId: opt<string>(r.guardian_id),
    humor: r.humor as Person["humor"],
    quietHours: r.quiet_start && r.quiet_end ? { start: hhmm(r.quiet_start), end: hhmm(r.quiet_end) } : undefined,
    wakeTime: hhmm(r.wake_time),
    muted: r.muted === true ? true : undefined,
    admin: r.admin === true ? true : undefined,
    icsToken: String(r.ics_token),
    joinedAt: iso(r.joined_at),
  };
}

function rowToActivity(r: Row): Activity {
  return {
    id: String(r.id),
    title: String(r.title),
    emoji: String(r.emoji),
    description: opt<string>(r.description),
    sponsorId: String(r.sponsor_id),
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    location: String(r.location),
    capacity: opt<number>(r.capacity),
    bring: opt<string>(r.bring),
    status: r.status as Activity["status"],
    flyerUrl: opt<string>(r.flyer_url),
    createdVia: r.created_via as Activity["createdVia"],
    createdAt: iso(r.created_at),
    cancelledReason: opt<string>(r.cancelled_reason),
  };
}

function rowToSignup(r: Row): Signup {
  return {
    activityId: String(r.activity_id),
    personId: String(r.person_id),
    status: r.status as SignupStatus,
    createdAt: iso(r.created_at),
    remindedAt: isoOpt(r.reminded_at),
  };
}

function rowToDelivery(r: Row): Delivery {
  const payload = r.payload === null || r.payload === undefined ? undefined : typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
  return { kind: r.kind as Delivery["kind"], key: String(r.key), sentAt: iso(r.sent_at), ...(payload !== undefined ? { payload } : {}) };
}

/** Column map for partial updates: camelCase field → snake_case column. */
const PERSON_COLS: Record<string, string> = {
  name: "name",
  nickname: "nickname",
  phoneE164: "phone_e164",
  language: "language",
  role: "role",
  guardianId: "guardian_id",
  humor: "humor",
  wakeTime: "wake_time",
  muted: "muted",
  admin: "admin",
  icsToken: "ics_token",
};
const ACTIVITY_COLS: Record<string, string> = {
  title: "title",
  emoji: "emoji",
  description: "description",
  sponsorId: "sponsor_id",
  startsAt: "starts_at",
  endsAt: "ends_at",
  location: "location",
  capacity: "capacity",
  bring: "bring",
  status: "status",
  flyerUrl: "flyer_url",
  createdVia: "created_via",
  cancelledReason: "cancelled_reason",
};

function setClause(patch: Record<string, unknown>, cols: Record<string, string>, startAt = 1): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "quietHours") {
      const q = v as Person["quietHours"];
      parts.push(`quiet_start = $${startAt + params.length}`);
      params.push(q ? q.start : null);
      parts.push(`quiet_end = $${startAt + params.length}`);
      params.push(q ? q.end : null);
      continue;
    }
    const col = cols[k];
    if (!col) continue;
    parts.push(`${col} = $${startAt + params.length}`);
    params.push(v);
  }
  return { sql: parts.join(", "), params };
}

/** Production store on Postgres (Supabase). Schema: sql/*.sql (applied in order). */
export class PgStore implements Store {
  constructor(private readonly db: Queryable) {}

  // People
  async listPeople(): Promise<Person[]> {
    return (await this.db.query<Row>("select * from person order by name")).map(rowToPerson);
  }
  async getPerson(id: string): Promise<Person | undefined> {
    const rows = await this.db.query<Row>("select * from person where id::text = $1", [id]);
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }
  async findPersonByPhone(phoneE164: string): Promise<Person | undefined> {
    const rows = await this.db.query<Row>("select * from person where phone_e164 = $1", [phoneE164]);
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }
  async findPersonByName(name: string): Promise<Person | undefined> {
    const rows = await this.db.query<Row>(
      `select * from person
       where lower(unaccent_lite(name)) = lower(unaccent_lite($1))
          or lower(unaccent_lite(coalesce(nickname, ''))) = lower(unaccent_lite($1))
       union all
       select * from person
       where lower(unaccent_lite(name)) like lower(unaccent_lite($1)) || '%'
          or lower(unaccent_lite(name)) like '% ' || lower(unaccent_lite($1)) || '%'
       limit 1`,
      [name.trim()],
    );
    return rows[0] ? rowToPerson(rows[0]) : undefined;
  }
  async createPerson(input: NewPerson): Promise<Person> {
    const rows = await this.db.query<Row>(
      `insert into person (name, nickname, phone_e164, language, role, guardian_id, humor, quiet_start, quiet_end, wake_time)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [
        input.name,
        input.nickname ?? null,
        input.phoneE164 ?? null,
        input.language,
        input.role,
        input.guardianId ?? null,
        input.humor ?? "full",
        input.quietHours?.start ?? null,
        input.quietHours?.end ?? null,
        input.wakeTime ?? "07:30",
      ],
    );
    return rowToPerson(rows[0]);
  }
  async updatePerson(id: string, patch: PersonPatch): Promise<Person> {
    const { sql, params } = setClause(patch as Record<string, unknown>, PERSON_COLS, 2);
    if (!sql) return (await this.getPerson(id))!;
    const rows = await this.db.query<Row>(`update person set ${sql} where id::text = $1 returning *`, [id, ...params]);
    if (!rows[0]) throw new Error(`person not found: ${id}`);
    return rowToPerson(rows[0]);
  }
  async removePerson(id: string): Promise<void> {
    const live = await this.db.query<Row>("select id, title from activity where sponsor_id::text = $1 and status <> 'cancelled' order by starts_at", [id]);
    if (live.length) throw new Error(`still hosts ${live.map((a) => `"${a.title}" [${a.id}]`).join(", ")}; cancel those first`);
    await this.db.query("update person set guardian_id = null where guardian_id::text = $1", [id]);
    await this.db.query("delete from activity where sponsor_id::text = $1", [id]);
    await this.db.query("delete from person where id::text = $1", [id]);
  }

  // Activities
  async listActivities(q: ActivityQuery = {}): Promise<Activity[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      params.push(v);
      where.push(clause.replace("?", `$${params.length}`));
    };
    if (q.from) add("starts_at >= ?", q.from);
    if (q.to) add("starts_at < ?", q.to);
    if (q.sponsorId) add("sponsor_id::text = ?", q.sponsorId);
    if (q.status) add("status::text = any(?)", q.status);
    else where.push("status <> 'cancelled'");
    const rows = await this.db.query<Row>(
      `select * from activity ${where.length ? "where " + where.join(" and ") : ""} order by starts_at, title`,
      params,
    );
    return rows.map(rowToActivity);
  }
  async getActivity(id: string): Promise<Activity | undefined> {
    const rows = await this.db.query<Row>("select * from activity where id = $1", [id]);
    return rows[0] ? rowToActivity(rows[0]) : undefined;
  }
  async createActivity(input: NewActivity): Promise<Activity> {
    const rows = await this.db.query<Row>(
      `insert into activity (title, emoji, description, sponsor_id, starts_at, ends_at, location, capacity, bring, status, flyer_url, created_via)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [
        input.title,
        input.emoji,
        input.description ?? null,
        input.sponsorId,
        input.startsAt,
        input.endsAt,
        input.location,
        input.capacity ?? null,
        input.bring ?? null,
        input.status ?? "published",
        input.flyerUrl ?? null,
        input.createdVia,
      ],
    );
    return rowToActivity(rows[0]);
  }
  async updateActivity(id: string, patch: Partial<Omit<Activity, "id" | "createdAt">>): Promise<Activity> {
    const { sql, params } = setClause(patch as Record<string, unknown>, ACTIVITY_COLS, 2);
    if (!sql) return (await this.getActivity(id))!;
    const rows = await this.db.query<Row>(`update activity set ${sql} where id = $1 returning *`, [id, ...params]);
    if (!rows[0]) throw new Error(`activity not found: ${id}`);
    return rowToActivity(rows[0]);
  }

  // Sign-ups
  async listSignups(activityId: string): Promise<Signup[]> {
    return (await this.db.query<Row>("select * from signup where activity_id = $1 order by created_at", [activityId])).map(rowToSignup);
  }
  async listSignupsForPerson(personId: string): Promise<Signup[]> {
    return (await this.db.query<Row>("select * from signup where person_id::text = $1 order by created_at", [personId])).map(rowToSignup);
  }
  async setSignup(activityId: string, personId: string, status: SignupStatus): Promise<Signup> {
    const rows = await this.db.query<Row>(
      `insert into signup (activity_id, person_id, status) values ($1, $2, $3)
       on conflict (activity_id, person_id) do update set status = excluded.status
       returning *`,
      [activityId, personId, status],
    );
    return rowToSignup(rows[0]);
  }
  async markReminded(activityId: string, personId: string, at: string): Promise<void> {
    await this.db.query("update signup set reminded_at = $3 where activity_id = $1 and person_id::text = $2", [activityId, personId, at]);
  }

  // Memory
  async remember(personId: string, key: string, value: string): Promise<MemoryEntry> {
    const rows = await this.db.query<Row>(
      `insert into memory (person_id, key, value) values ($1, $2, $3)
       on conflict (person_id, key) do update set value = excluded.value, updated_at = now()
       returning *`,
      [personId, key, value],
    );
    const r = rows[0];
    return { personId: String(r.person_id), key: String(r.key), value: String(r.value), updatedAt: iso(r.updated_at) };
  }
  async getMemory(personId: string): Promise<MemoryEntry[]> {
    const rows = await this.db.query<Row>("select * from memory where person_id::text = $1 order by updated_at", [personId]);
    return rows.map((r) => ({ personId: String(r.person_id), key: String(r.key), value: String(r.value), updatedAt: iso(r.updated_at) }));
  }
  async forget(personId: string, key: string): Promise<void> {
    await this.db.query("delete from memory where person_id::text = $1 and key = $2", [personId, key]);
  }

  // Log
  async logMessage(entry: Omit<MessageLog, "id" | "ts"> & { ts?: string }): Promise<MessageLog> {
    const rows = await this.db.query<Row>(
      `insert into message_log (person_id, channel, direction, body, media_url, tool_calls, ts)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, now())) returning *`,
      [entry.personId ?? null, entry.channel, entry.direction, entry.body, entry.mediaUrl ?? null, entry.toolCalls ? JSON.stringify(entry.toolCalls) : null, entry.ts ?? null],
    );
    const r = rows[0];
    return {
      id: String(r.id),
      personId: opt<string>(r.person_id),
      channel: r.channel as MessageLog["channel"],
      direction: r.direction as MessageLog["direction"],
      body: String(r.body),
      mediaUrl: opt<string>(r.media_url),
      toolCalls: r.tool_calls ?? undefined,
      ts: iso(r.ts),
    };
  }
  async listMessages(personId: string, limit = 50): Promise<MessageLog[]> {
    const rows = await this.db.query<Row>(
      "select * from (select * from message_log where person_id::text = $1 order by ts desc limit $2) t order by ts",
      [personId, limit],
    );
    return rows.map((r) => ({
      id: String(r.id),
      personId: opt<string>(r.person_id),
      channel: r.channel as MessageLog["channel"],
      direction: r.direction as MessageLog["direction"],
      body: String(r.body),
      mediaUrl: opt<string>(r.media_url),
      toolCalls: r.tool_calls ?? undefined,
      ts: iso(r.ts),
    }));
  }

  // Conversations
  async getConversation(personId: string): Promise<Conversation | undefined> {
    const rows = await this.db.query<Row>("select * from conversation where person_id::text = $1", [personId]);
    const r = rows[0];
    return r ? { personId: String(r.person_id), history: (typeof r.history === "string" ? JSON.parse(r.history) : r.history) as unknown[], updatedAt: iso(r.updated_at) } : undefined;
  }
  async saveConversation(personId: string, history: unknown[]): Promise<Conversation> {
    const rows = await this.db.query<Row>(
      `insert into conversation (person_id, history, updated_at) values ($1, $2::jsonb, now())
       on conflict (person_id) do update set history = excluded.history, updated_at = now() returning *`,
      [personId, JSON.stringify(history)],
    );
    const r = rows[0];
    return { personId: String(r.person_id), history: (typeof r.history === "string" ? JSON.parse(r.history) : r.history) as unknown[], updatedAt: iso(r.updated_at) };
  }
  async clearConversation(personId: string): Promise<void> {
    await this.db.query("delete from conversation where person_id::text = $1", [personId]);
  }

  // Deliveries
  async wasDelivered(kind: Delivery["kind"], key: string): Promise<boolean> {
    const rows = await this.db.query<Row>("select 1 from delivery where kind = $1 and key = $2", [kind, key]);
    return rows.length > 0;
  }
  async getDelivery(kind: Delivery["kind"], key: string): Promise<Delivery | undefined> {
    const rows = await this.db.query<Row>("select * from delivery where kind = $1 and key = $2", [kind, key]);
    return rows[0] ? rowToDelivery(rows[0]) : undefined;
  }
  async getSetting<T = unknown>(key: string): Promise<T | undefined> {
    const rows = await this.db.query<Row>("select value from ship_setting where key = $1", [key]);
    if (!rows[0]) return undefined;
    const v = rows[0].value;
    return (typeof v === "string" ? JSON.parse(v) : v) as T;
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `insert into ship_setting (key, value) values ($1, $2::jsonb)
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  async markDelivered(kind: Delivery["kind"], key: string, payload?: unknown): Promise<Delivery> {
    const rows = await this.db.query<Row>(
      `insert into delivery (kind, key, payload) values ($1, $2, $3::jsonb) on conflict (kind, key) do update set kind = excluded.kind returning *`,
      [kind, key, payload === undefined ? null : JSON.stringify(payload)],
    );
    return rowToDelivery(rows[0]);
  }
}
