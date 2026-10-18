/**
 * Apply SQL migrations in packages/db/sql to DATABASE_URL, in filename order, once each.
 *   DATABASE_URL=postgres://… pnpm db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "sql");
const sql = postgres(url, { max: 1 });

await sql.unsafe(`create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())`);
const applied = new Set((await sql.unsafe<{ name: string }[]>(`select name from schema_migration`)).map((r) => r.name));
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  console.log(`applying ${file}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(readFileSync(join(dir, file), "utf8"));
    await tx.unsafe(`insert into schema_migration (name) values ($1)`, [file]);
  });
}
console.log("migrations up to date");
await sql.end();
