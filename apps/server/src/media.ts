/**
 * Where generated images (flyers) live. Telegram fetches them by URL, the web app and the TV show them.
 *
 * - Supabase Storage (production): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (a secret key sb_secret_…, or the
 *   legacy service_role JWT), public bucket SUPABASE_BUCKET
 *   (default "media", created on first use).
 * - Local disk (before Supabase exists): files under MEDIA_DIR (default <data dir>/media), served by this
 *   server at /media/<key>.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

export interface MediaStore {
  /** Stores bytes under a key like "flyers/a04-1700000000.png" and returns a public URL. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

export interface SupabaseMediaConfig {
  url: string;
  serviceRoleKey: string;
  bucket?: string;
  fetch?: typeof fetch;
}

export class SupabaseMediaStore implements MediaStore {
  private readonly fetchFn: typeof fetch;
  private readonly bucket: string;
  private bucketReady = false;
  private readonly base: string;

  constructor(private readonly cfg: SupabaseMediaConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
    this.bucket = cfg.bucket ?? "media";
    // Only the origin counts: the dashboard also shows the URL as https://<ref>.supabase.co/rest/v1/.
    this.base = new URL(cfg.url).origin;
  }

  private headers(extra: Record<string, string> = {}) {
    const key = this.cfg.serviceRoleKey;
    // New secret keys (sb_secret_…) go in apikey only; legacy service_role JWTs (eyJ…) also as a Bearer token.
    return { ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), apikey: key, ...extra };
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    const res = await this.fetchFn(`${this.base}/storage/v1/bucket`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: this.bucket, name: this.bucket, public: true }),
    });
    // 200 created; 400/409 "already exists" is fine too.
    if (!res.ok && res.status !== 400 && res.status !== 409) throw new Error(`Supabase bucket ${res.status}: ${(await res.text()).slice(0, 200)}`);
    this.bucketReady = true;
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
    await this.ensureBucket();
    const res = await this.fetchFn(`${this.base}/storage/v1/object/${this.bucket}/${key}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": contentType, "x-upsert": "true", "Cache-Control": "public, max-age=31536000" }),
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new Error(`Supabase upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return `${this.base}/storage/v1/object/public/${this.bucket}/${key}`;
  }
}

export class DiskMediaStore implements MediaStore {
  constructor(
    private readonly dir: string,
    private readonly publicUrl: string,
  ) {}

  private path(key: string): string {
    const p = normalize(join(this.dir, key));
    if (!p.startsWith(normalize(this.dir))) throw new Error("bad media key");
    return p;
  }

  async put(key: string, bytes: Uint8Array, _contentType?: string): Promise<string> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    return `${this.publicUrl}/media/${key}`;
  }

  /** For GET /media/<key>; undefined when missing or outside the media dir. */
  async read(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(key));
    } catch {
      return undefined;
    }
  }
}

export function mediaContentType(key: string): string {
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}
