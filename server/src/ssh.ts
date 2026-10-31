import { spawn } from "node:child_process";
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

/** The non-secret hosts file in pi's agent dir (the extension reads it; key names only, never values). */
export const hostsFile = (agentDir: string) => path.join(agentDir, "workbench-ssh.json");

/**
 * The workbench owns `~/.ssh` in the agent's home (ADR 0001): regenerate it wholesale.
 * Materializes every saved key (a global-scope secret with a key name) as `~/.ssh/<name>`
 * (0600 inside a 0700 directory) via the SecretStore — the only decrypting path — and
 * `~/.ssh/config` with `StrictHostKeyChecking accept-new` so non-interactive ssh never hangs
 * on a fingerprint prompt, plus one `Host <alias>` block per saved host. It also writes the
 * non-secret hosts file into pi's agent dir so the extension can name the known hosts. A
 * manifest (a settings row) records which key files we created, so we remove exactly the files
 * of keys that disappeared and never touch anything else. No key value ever reaches a log,
 * an API response or the hosts file.
 */
export function applySsh(db: Db, secrets: SecretStore, home: string, agentDir: string): void {
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

  const hosts = loadSshHosts(db);
  write0600(path.join(sshDir, "config"), sshConfig(hosts));
  fs.mkdirSync(agentDir, { recursive: true });
  write0600(hostsFile(agentDir), JSON.stringify({ hosts }, null, 2) + "\n");
}

/** Write 0600 via a temp file + rename so a partial write never lands as the key itself. */
function write0600(file: string, value: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export type SshHost = { alias: string; user: string; hostname: string; port?: number; keyName: string };

/**
 * Validate the full host list (the PUT /api/ssh/hosts body): alias like a file name and unique,
 * user and hostname required, port 1–65535 or omitted (ssh defaults to 22), keyName following the
 * key-name pattern ("" = no key). Throws with a message naming the problem; returns the normalized
 * list. A host referencing a key that does not exist yet is valid: it saves and warns instead.
 */
export function validateHosts(input: unknown): SshHost[] {
  if (!Array.isArray(input)) throw new Error("Hosts must be a list");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const h = (raw ?? {}) as Record<string, unknown>;
    // No trim on the alias (or key name below): a space in " lead" is invalid, not a typo to fix.
    const alias = typeof h.alias === "string" ? h.alias : "";
    if (!KEY_NAME_RE.test(alias)) throw new Error(`Invalid alias "${alias}": start with a letter; letters, digits, dots and dashes only`);
    if (seen.has(alias)) throw new Error(`Duplicate alias "${alias}"`);
    seen.add(alias);
    const user = typeof h.user === "string" ? h.user.trim() : "";
    if (!user) throw new Error(`Host "${alias}": user is required`);
    const hostname = typeof h.hostname === "string" ? h.hostname.trim() : "";
    if (!hostname) throw new Error(`Host "${alias}": hostname is required`);
    let port: number | undefined;
    if (h.port !== undefined && h.port !== null && h.port !== "") {
      const p = typeof h.port === "string" ? (/^\d+$/.test(h.port) ? Number(h.port) : NaN) : (h.port as number);
      if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) {
        throw new Error(`Host "${alias}": port must be a number between 1 and 65535`);
      }
      port = p;
    }
    const keyName = typeof h.keyName === "string" ? h.keyName.trim() : "";
    if (keyName && !KEY_NAME_RE.test(keyName)) throw new Error(`Host "${alias}": invalid key name "${keyName}"`);
    const out: SshHost = { alias, user, hostname, keyName };
    if (port !== undefined) out.port = port;
    return out;
  });
}

/** Saved host list from the settings row (global scope, like the other settings). */
export function loadSshHosts(db: Db): SshHost[] {
  return getSetting<SshHost[]>(db, "ssh_hosts") ?? [];
}

/**
 * The whole of the generated `~/.ssh/config` (ADR 0001: the workbench owns it, no merging):
 * `StrictHostKeyChecking accept-new` so non-interactive ssh never hangs on a fingerprint prompt,
 * then one `Host <alias>` block per host with `User`, `HostName`, `Port` (when set) and
 * `IdentityFile ~/.ssh/<key>` (omitted when the host has no key).
 */
export function sshConfig(hosts: SshHost[]): string {
  const lines: string[] = ["StrictHostKeyChecking accept-new"];
  for (const h of hosts) {
    lines.push("", `Host ${h.alias}`, `    User ${h.user}`, `    HostName ${h.hostname}`);
    if (h.port !== undefined) lines.push(`    Port ${h.port}`);
    if (h.keyName) lines.push(`    IdentityFile ~/.ssh/${h.keyName}`);
  }
  return lines.join("\n") + "\n";
}

/** Validate and save the full host list; the caller then re-applies ssh (config + files). */
export function saveSshHosts(db: Db, input: unknown): SshHost[] {
  const hosts = validateHosts(input);
  putSetting(db, "ssh_hosts", hosts);
  return hosts;
}

/** The GET /api/ssh response: saved key names with updated-at (names only, never values) and the
 * saved hosts; a host whose key is not saved (or no longer is) is flagged `keyMissing` so the UI
 * can warn "key not set" — the host still saves, ssh just fails at connect. */
export function sshView(db: Db, secrets: SecretStore) {
  const keys = secrets.list(GLOBAL_SCOPE).filter((s) => validKeyName(s.name));
  const names = new Set(keys.map((k) => k.name));
  return {
    keys: keys.map(({ name, updatedAt }) => ({ name, updatedAt })),
    hosts: loadSshHosts(db).map((h) => ({ ...h, keyMissing: !!h.keyName && !names.has(h.keyName) })),
  };
}

/**
 * The per-row Test button: `ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> true` after a fresh
 * materialization, so it checks exactly what the agent will get. BatchMode keeps a non-interactive
 * probe from hanging on prompts (passphrase-protected keys fail fast instead). The child sees only
 * HOME and PATH — never the master key or any other secret. The result is ok plus a short detail
 * from stderr (the last non-empty line), never key material.
 */
export async function testSshHost(
  db: Db,
  secrets: SecretStore,
  home: string,
  agentDir: string,
  alias: string,
): Promise<{ ok: boolean; detail: string }> {
  const a = alias.trim();
  if (!a) throw new Error("Alias is required");
  if (!loadSshHosts(db).some((h) => h.alias === a)) throw new Error(`Unknown host "${a}"`);
  applySsh(db, secrets, home, agentDir);
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const p = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", a, "true"], {
      env: { HOME: home, PATH: process.env.PATH },
      timeout: 30_000,
    });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += String(d)));
    p.on("error", (e) => (stderr += `\n${e.message}`));
    p.on("close", (code) => resolve({ code, stderr }));
  });
  if (code === 0) return { ok: true, detail: "" };
  const line =
    stderr
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  const detail = (line || (code === null ? "ssh timed out" : `ssh exit code ${code}`)).slice(0, 200);
  return { ok: false, detail };
}
