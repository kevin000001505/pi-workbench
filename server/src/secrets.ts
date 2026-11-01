import crypto from "node:crypto";
import type { Db, SecretRow } from "./db.ts";

export const GLOBAL_SCOPE = "global";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,127}$/;

/**
 * Env-variable store, encrypted at rest with AES-256-GCM. Values go in and never come back out over
 * the API: `envFor()` is the only decrypting path to a pi process environment; `get()` also decrypts
 * for the LLM key, for ssh key materialization into `~/.ssh` (see ssh.ts, ADR 0001), and for the
 * auto-approve keys in their own scope, which `envFor()` never reads (see autoapprove.ts, ADR 0002).
 */
export class SecretStore {
  private key: Buffer;
  private db: Db;

  constructor(db: Db, masterKey: string) {
    if (masterKey.length < 16) {
      throw new Error("WORKBENCH_MASTER_KEY must be set (at least 16 characters; `openssl rand -base64 32`)");
    }
    this.db = db;
    this.key = crypto.scryptSync(masterKey, "pi-workbench/secrets/v1", 32);
  }

  list(scope?: string) {
    const rows = (
      scope
        ? this.db.prepare("SELECT scope, name, updated_at FROM secrets WHERE scope = ? ORDER BY name").all(scope)
        : this.db.prepare("SELECT scope, name, updated_at FROM secrets ORDER BY scope, name").all()
    ) as Pick<SecretRow, "scope" | "name" | "updated_at">[];
    return rows.map((r) => ({ scope: r.scope, name: r.name, updatedAt: r.updated_at }));
  }

  set(scope: string, name: string, value: string) {
    if (!NAME_RE.test(name)) throw new Error(`Invalid variable name: ${name}`);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    // Bind the ciphertext to its slot so rows can't be swapped between names or scopes.
    cipher.setAAD(Buffer.from(`${scope}\0${name}`));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    this.db
      .prepare(
        `INSERT INTO secrets (scope, name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(scope, name, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64"), Date.now());
  }

  /** Set several secrets in one transaction: all of them are written, or none. */
  setAll(scope: string, entries: [string, string][]) {
    this.db.exec("BEGIN");
    try {
      for (const [name, value] of entries) this.set(scope, name, value);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  delete(scope: string, name: string) {
    this.db.prepare("DELETE FROM secrets WHERE scope = ? AND name = ?").run(scope, name);
  }

  get(scope: string, name: string): string | undefined {
    const row = this.db.prepare("SELECT * FROM secrets WHERE scope = ? AND name = ?").get(scope, name) as
      | SecretRow
      | undefined;
    return row ? this.decrypt(row) : undefined;
  }

  /** Global variables overlaid with the repo's own. */
  envFor(repoId?: string): Record<string, string> {
    const env: Record<string, string> = {};
    const rows = this.db
      .prepare("SELECT * FROM secrets WHERE scope = ? OR scope = ? ORDER BY scope = ? DESC")
      .all(GLOBAL_SCOPE, repoId ?? GLOBAL_SCOPE, GLOBAL_SCOPE) as SecretRow[];
    for (const row of rows) env[row.name] = this.decrypt(row);
    return env;
  }

  private decrypt(row: SecretRow): string {
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv, "base64"));
    decipher.setAAD(Buffer.from(`${row.scope}\0${row.name}`));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(row.data, "base64")), decipher.final()]).toString("utf8");
  }
}

/** Scopes the workbench keeps for itself (`wb:…`, e.g. the auto-approve keys): the Secrets page never sees them. */
const isReserved = (scope: string) => scope.startsWith("wb:");

/** The secrets the Secrets page lists: names only, reserved scopes left out. */
export const userSecrets = (store: SecretStore) => store.list().filter((s) => !isReserved(s.scope));

/** The Secrets page may write or delete only the global scope and tracked repos' scopes. */
export function assertUserScope(scope: string, isRepo: (scope: string) => boolean) {
  if (isReserved(scope) || (scope !== GLOBAL_SCOPE && !isRepo(scope))) throw Object.assign(new Error(`Unknown scope ${scope}`), { status: 400 });
}
