import fs from "node:fs";
import path from "node:path";
import { getSetting, putSetting, type Db } from "./db.ts";
import { GLOBAL_SCOPE, type SecretStore } from "./secrets.ts";

/** A key name becomes the file name `~/.ssh/<name>`: start with a letter, then letters, digits, dots and dashes. */
export const KEY_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

export function validKeyName(name: string): boolean {
  return KEY_NAME_RE.test(name);
}

export function assertKeyName(name: string): void {
  if (!validKeyName(name)) {
    throw new Error(`Invalid key name "${name}": start with a letter; letters, digits, dots and dashes only`);
  }
}

/**
 * The workbench owns `~/.ssh` in the agent's home (ADR 0001): regenerate it wholesale.
 * Materializes every saved key (a global-scope secret with a key name) as `~/.ssh/<name>`
 * (0600 inside a 0700 directory) via the SecretStore — the only decrypting path — and
 * `~/.ssh/config` with `StrictHostKeyChecking accept-new` so non-interactive ssh never hangs
 * on a fingerprint prompt. A manifest (a settings row) records which files we created, so we
 * remove exactly the files of keys that disappeared and never touch anything else. No key
 * value ever reaches a log or an API response.
 */
export function applySsh(db: Db, secrets: SecretStore, home: string): void {
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir, { recursive: true });
  fs.chmodSync(sshDir, 0o700);

  const keys = new Map<string, string>();
  for (const s of secrets.list(GLOBAL_SCOPE)) {
    if (validKeyName(s.name)) keys.set(s.name, secrets.get(GLOBAL_SCOPE, s.name)!);
  }

  const manifest = new Set(getSetting<string[]>(db, "ssh_manifest") ?? []);
  for (const [name, value] of keys) {
    write0600(path.join(sshDir, name), value);
    manifest.add(name);
  }
  for (const name of [...manifest]) {
    if (!keys.has(name)) {
      manifest.delete(name);
      fs.rmSync(path.join(sshDir, name), { force: true });
    }
  }
  putSetting(db, "ssh_manifest", [...manifest]);

  write0600(path.join(sshDir, "config"), "StrictHostKeyChecking accept-new\n");
}

/** Write 0600 via a temp file + rename so a partial write never lands as the key itself. */
function write0600(file: string, value: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type SshHost = { alias: string; user: string; hostname: string; port?: number; keyName: string };

/** The GET /api/ssh response: saved key names with updated-at (names only, never values) and the host list. */
export function sshView(db: Db, secrets: SecretStore) {
  return {
    keys: secrets.list(GLOBAL_SCOPE).filter((s) => validKeyName(s.name)).map(({ name, updatedAt }) => ({ name, updatedAt })),
    hosts: [] as SshHost[],
  };
}
