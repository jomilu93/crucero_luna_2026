/**
 * Conchitas 🐚, the Moonshine of the Seas' reward for showing up. Hosting earns more than going, and each side
 * vouches for the other: a guest's conchitas count once the host confirms they came, the host's once a guest
 * confirms the activity happened. Balances are derived from the attendance rows; prizes are exchanged in person at
 * the cruise store, so nothing is ever spent or deducted here.
 */
import type { Activity, Attendance, Person, Store } from "@crucero/db";

export const CONCHITAS = { host: 30, guest: 10 } as const;

export interface ConchitaLine {
  activity: Activity;
  role: "host" | "guest";
  amount: number;
  earned: boolean;
}

export interface Chest {
  balance: number;
  /** Earned and still waiting, newest first. */
  lines: ConchitaLine[];
  /** Activities this passenger went to (or signed up for) and hasn't confirmed yet: "did it happen?" */
  toConfirm: Activity[];
  /** Activities they host (or manage) that have started and where nobody is marked as having come yet. */
  toMark: Activity[];
}

const started = (a: Activity, now: Date) => a.status !== "cancelled" && a.startsAt <= now.toISOString();

/** Did someone other than the host confirm this activity happened? */
export const vouchedFor = (a: Activity, rows: Attendance[]) => rows.some((r) => r.personId !== a.sponsorId && !!r.guestConfirmedAt);

export async function chestFor(store: Store, person: Person, now: Date): Promise<Chest> {
  const lines: ConchitaLine[] = [];
  const toConfirm: Activity[] = [];
  const toMark: Activity[] = [];

  // As a guest: anything they signed up for or were marked at, once it has started.
  const mine = new Map<string, Attendance | undefined>();
  for (const s of await store.listSignupsForPerson(person.id)) if (s.status !== "out") mine.set(s.activityId, undefined);
  for (const r of await store.listAttendanceForPerson(person.id)) mine.set(r.activityId, r);
  for (const [id, row] of mine) {
    const a = await store.getActivity(id);
    if (!a || a.sponsorId === person.id || !started(a, now)) continue;
    if (row?.hostConfirmedAt || row?.guestConfirmedAt) lines.push({ activity: a, role: "guest", amount: CONCHITAS.guest, earned: !!row.hostConfirmedAt });
    if (!row?.guestConfirmedAt) toConfirm.push(a);
  }

  // As a host: every activity of theirs that has started.
  for (const a of await store.listActivities({ sponsorId: person.id })) {
    if (!started(a, now)) continue;
    const rows = await store.listAttendance(a.id);
    lines.push({ activity: a, role: "host", amount: CONCHITAS.host, earned: vouchedFor(a, rows) });
    const going = (await store.listSignups(a.id)).filter((s) => s.status !== "out" && s.personId !== a.sponsorId);
    if (going.length && !rows.some((r) => r.hostConfirmedAt)) toMark.push(a);
  }

  lines.sort((x, y) => y.activity.startsAt.localeCompare(x.activity.startsAt));
  const balance = lines.filter((l) => l.earned).reduce((n, l) => n + l.amount, 0);
  return { balance, lines, toConfirm: toConfirm.sort(byStart), toMark: toMark.sort(byStart) };
}

const byStart = (x: Activity, y: Activity) => x.startsAt.localeCompare(y.startsAt);
