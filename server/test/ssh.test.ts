/**
 * SSH keys materialized for the agent: name validation, materialization into a temp home
 * (content, file/directory modes), removal on key delete via the manifest, and the
 * /api/ssh view (names only, never values). Unit seam: temp dirs + a real SecretStore and db.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { GLOBAL_SCOPE, SecretStore } from "../src/secrets.ts";
import { applySsh, assertKeyName, sshView, validKeyName } from "../src/ssh.ts";

const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\n`;

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ssh-"));
  const db = openDb(path.join(root, "t.db"));
  return { db, secrets: new SecretStore(db, "a-master-key-of-some-length"), home: path.join(root, "home") };
}

test("key names validate like file names", () => {
  for (const ok of ["media", "My-Host", "a.b-c9", "A"]) assert.ok(validKeyName(ok), ok);
  for (const bad of ["", " lead", "_lead", "sp ace", "tab\tx"]) assert.ok(!validKeyName(bad), bad);
  assert.throws(() => assertKeyName("bad name"), /key name/i);
  assert.equal(assertKeyName("media"), undefined);
});

test("applySsh materializes saved keys into the agent's home", () => {
  const { db, secrets, home } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);

  applySsh(db, secrets, home);

  const keyFile = path.join(home, ".ssh", "media");
  assert.equal(fs.readFileSync(keyFile, "utf8"), KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "key file is 0600");
  assert.equal(fs.statSync(path.join(home, ".ssh")).mode & 0o777, 0o700, ".ssh dir is 0700");
  const cfg = path.join(home, ".ssh", "config");
  assert.match(fs.readFileSync(cfg, "utf8"), /^StrictHostKeyChecking accept-new/);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600, "config is 0600");
});

test("re-saving a key re-materializes the file with the new value", () => {
  const { db, secrets, home } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  applySsh(db, secrets, home);

  const other = `-----BEGIN OPENSSH PRIVATE KEY-----\nandZXJ0aA==\n-----END OPENSSH PRIVATE KEY-----\n`;
  secrets.set(GLOBAL_SCOPE, "media", other);
  applySsh(db, secrets, home);

  assert.equal(fs.readFileSync(path.join(home, ".ssh", "media"), "utf8"), other);
});

test("deleting a key removes its file; the manifest keeps the workbench from touching files it didn't create", () => {
  const { db, secrets, home } = tmp();
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "rogue"), "pre-existing, not ours\n");

  secrets.set(GLOBAL_SCOPE, "media", KEY);
  applySsh(db, secrets, home);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "media")));

  secrets.delete(GLOBAL_SCOPE, "media");
  applySsh(db, secrets, home);

  assert.ok(!fs.existsSync(path.join(home, ".ssh", "media")), "deleted key's file is removed");
  assert.equal(fs.readFileSync(path.join(home, ".ssh", "rogue"), "utf8"), "pre-existing, not ours\n", "untouched files survive");

  // The manifest lives in the db: a fresh store (e.g. after a restart) removes nothing new.
  applySsh(db, new SecretStore(db, "a-master-key-of-some-length"), home);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "rogue")));
});

test("the secret store accepts key names with dots and dashes, and rejects the rest with a message", () => {
  const { db, secrets } = tmp();
  secrets.set(GLOBAL_SCOPE, "media-server", KEY);
  assert.equal(secrets.get(GLOBAL_SCOPE, "media-server"), KEY);
  assert.throws(() => secrets.set(GLOBAL_SCOPE, "bad name", KEY), /Invalid variable name: bad name/);
  assert.throws(() => secrets.set(GLOBAL_SCOPE, "", KEY), /Invalid variable name/);
});

test("the ssh view lists key names with updated-at, never values, and an empty host list", () => {
  const { db, secrets } = tmp();
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  secrets.set("me/app", "media", KEY); // repo-scoped secrets are not keys
  const before = Date.now();

  const view = sshView(db, secrets);

  assert.equal(view.keys.length, 1);
  assert.equal(view.keys[0].name, "media");
  assert.equal(typeof view.keys[0].updatedAt, "number");
  assert.ok(view.keys[0].updatedAt >= before - 1000);
  assert.deepEqual(view.hosts, []);
  // Never values: the key material must not appear anywhere in the response.
  assert.ok(!JSON.stringify(view).includes("b3BlbnNzaA=="));
  assert.ok(!JSON.stringify(view).includes("OPENSSH"));
});
