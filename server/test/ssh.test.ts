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
import { applySsh, assertKeyName, hostsFile, loadSshHosts, saveSshHosts, sshConfig, sshView, testSshHost, validKeyName, validateHosts } from "../src/ssh.ts";

const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----\n`;

function tmp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ssh-"));
  const db = openDb(path.join(root, "t.db"));
  return {
    db,
    secrets: new SecretStore(db, "a-master-key-of-some-length"),
    home: path.join(root, "home"),
    agent: path.join(root, "agent"),
  };
}

test("key names validate like file names", () => {
  for (const ok of ["media", "My-Host", "a.b-c9", "A"]) assert.ok(validKeyName(ok), ok);
  for (const bad of ["", " lead", "_lead", "sp ace", "tab\tx"]) assert.ok(!validKeyName(bad), bad);
  assert.throws(() => assertKeyName("bad name"), /key name/i);
  assert.equal(assertKeyName("media"), undefined);
});

test("applySsh materializes saved keys into the agent's home", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);

  applySsh(db, secrets, home, agent);

  const keyFile = path.join(home, ".ssh", "media");
  assert.equal(fs.readFileSync(keyFile, "utf8"), KEY);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "key file is 0600");
  assert.equal(fs.statSync(path.join(home, ".ssh")).mode & 0o777, 0o700, ".ssh dir is 0700");
  const cfg = path.join(home, ".ssh", "config");
  assert.match(fs.readFileSync(cfg, "utf8"), /^StrictHostKeyChecking accept-new/);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600, "config is 0600");
});

test("re-saving a key re-materializes the file with the new value", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  applySsh(db, secrets, home, agent);

  const other = `-----BEGIN OPENSSH PRIVATE KEY-----\nandZXJ0aA==\n-----END OPENSSH PRIVATE KEY-----\n`;
  secrets.set(GLOBAL_SCOPE, "media", other);
  applySsh(db, secrets, home, agent);

  assert.equal(fs.readFileSync(path.join(home, ".ssh", "media"), "utf8"), other);
});

test("deleting a key removes its file; the manifest keeps the workbench from touching files it didn't create", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "rogue"), "pre-existing, not ours\n");

  secrets.set(GLOBAL_SCOPE, "media", KEY);
  applySsh(db, secrets, home, agent);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "media")));

  secrets.delete(GLOBAL_SCOPE, "media");
  applySsh(db, secrets, home, agent);

  assert.ok(!fs.existsSync(path.join(home, ".ssh", "media")), "deleted key's file is removed");
  assert.equal(fs.readFileSync(path.join(home, ".ssh", "rogue"), "utf8"), "pre-existing, not ours\n", "untouched files survive");

  // The manifest lives in the db: a fresh store (e.g. after a restart) removes nothing new.
  applySsh(db, new SecretStore(db, "a-master-key-of-some-length"), home, agent);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "rogue")));
});

test("applySsh writes the host config blocks and a non-secret hosts file into the agent dir", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  saveSshHosts(db, [
    { alias: "media", user: "ubuntu", hostname: "10.0.0.5", port: "2222", keyName: "media" },
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
  ]);

  applySsh(db, secrets, home, agent);

  const cfg = fs.readFileSync(path.join(home, ".ssh", "config"), "utf8");
  assert.equal(
    cfg,
    [
      "StrictHostKeyChecking accept-new",
      "",
      "Host media",
      "    User ubuntu",
      "    HostName 10.0.0.5",
      "    Port 2222",
      "    IdentityFile ~/.ssh/media",
      "",
      "Host box",
      "    User root",
      "    HostName box.local",
    ].join("\n") + "\n",
  );
  const hostsJson = fs.readFileSync(hostsFile(agent), "utf8");
  assert.deepEqual(JSON.parse(hostsJson), {
    hosts: [
      { alias: "media", user: "ubuntu", hostname: "10.0.0.5", port: 2222, keyName: "media" },
      { alias: "box", user: "root", hostname: "box.local", keyName: "" },
    ],
  });
  assert.ok(!hostsJson.includes("OPENSSH"), "the hosts file never carries key values");
  assert.equal(fs.statSync(hostsFile(agent)).mode & 0o777, 0o600);
});

test("saving a shorter host list removes the stale config blocks and regenerates the hosts file", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  saveSshHosts(db, [
    { alias: "media", user: "ubuntu", hostname: "10.0.0.5", keyName: "media" },
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
  ]);
  applySsh(db, secrets, home, agent);

  saveSshHosts(db, [{ alias: "box", user: "root", hostname: "box.local", keyName: "" }]);
  applySsh(db, secrets, home, agent);

  const cfg = fs.readFileSync(path.join(home, ".ssh", "config"), "utf8");
  assert.ok(!cfg.includes("Host media"), "stale block removed");
  assert.ok(!cfg.includes("10.0.0.5"));
  assert.ok(cfg.includes("Host box"));
  assert.deepEqual(JSON.parse(fs.readFileSync(hostsFile(agent), "utf8")).hosts, [
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
  ]);
  assert.ok(fs.existsSync(path.join(home, ".ssh", "media")), "the key file stays while its key is still saved");
});

test("deleting a key a host references removes the key file but keeps the host block, so the host is visibly broken", () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  saveSshHosts(db, [{ alias: "media", user: "ubuntu", hostname: "10.0.0.5", keyName: "media" }]);
  applySsh(db, secrets, home, agent);

  secrets.delete(GLOBAL_SCOPE, "media");
  applySsh(db, secrets, home, agent);

  assert.ok(!fs.existsSync(path.join(home, ".ssh", "media")), "key file removed via the manifest");
  const cfg = fs.readFileSync(path.join(home, ".ssh", "config"), "utf8");
  assert.ok(cfg.includes("Host media"), "host kept");
  assert.ok(cfg.includes("IdentityFile ~/.ssh/media"), "still points at the now-missing key; ssh fails at connect and the view warns");
});

test("the connection test refuses an unknown alias before any ssh runs", async () => {
  const { db, secrets, home, agent } = tmp();
  await assert.rejects(testSshHost(db, secrets, home, agent, "nope"), /Unknown host "nope"/);
  await assert.rejects(testSshHost(db, secrets, home, agent, "  "), /alias/i);
});

test("the connection test runs the BatchMode probe after materialization and reports ok or a short failure detail", async () => {
  const { db, secrets, home, agent } = tmp();
  fs.mkdirSync(home, { recursive: true });
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  saveSshHosts(db, [{ alias: "media", user: "ubuntu", hostname: "10.0.0.5", keyName: "media" }]);

  // A fake ssh on PATH: a system boundary, so the probe is tested without a real network.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "wb-sshbin-"));
  const fake = path.join(bin, "ssh");
  const probe = (body: string) => {
    fs.writeFileSync(fake, `#!/bin/sh\necho "args:$@" > "$HOME/.ssh-probe-args"\nenv > "$HOME/.ssh-probe-env"\n${body}`);
    fs.chmodSync(fake, 0o755);
  };
  const oldPath = process.env.PATH;
  const oldKey = process.env.WORKBENCH_MASTER_KEY;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.WORKBENCH_MASTER_KEY = "leak-check-master-key-1234567";
  try {
    probe(`[ -f "$HOME/.ssh/media" ] || { echo 'key file missing at probe time' >&2; exit 1; }`);
    const ok = await testSshHost(db, secrets, home, agent, "media");
    assert.equal(ok.ok, true);
    const args = fs.readFileSync(path.join(home, ".ssh-probe-args"), "utf8");
    assert.match(args, /args:-o BatchMode=yes -o ConnectTimeout=10 media true/);
    const env = fs.readFileSync(path.join(home, ".ssh-probe-env"), "utf8");
    assert.ok(!env.includes("leak-check-master-key-1234567"), "the master key never reaches the ssh child");

    probe(`echo 'ssh: 10.0.0.5: Permission denied (publickey). Requires a passphrase.' >&2\nexit 255`);
    const bad = await testSshHost(db, secrets, home, agent, "media");
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /Permission denied/);
    assert.ok(bad.detail.length <= 200, "short detail");
    assert.ok(!bad.detail.includes("b3BlbnNzaA=="), "no key material in the detail");

    probe(`exit 255`);
    const silent = await testSshHost(db, secrets, home, agent, "media");
    assert.equal(silent.ok, false);
    assert.match(silent.detail, /exit code 255/);
  } finally {
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.WORKBENCH_MASTER_KEY;
    else process.env.WORKBENCH_MASTER_KEY = oldKey;
    fs.rmSync(bin, { recursive: true, force: true });
  }
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

test("the ssh view flags hosts whose key is missing, and never leaks key values", () => {
  const { db, secrets } = tmp();
  secrets.set(GLOBAL_SCOPE, "media", KEY);
  saveSshHosts(db, [
    { alias: "media", user: "ubuntu", hostname: "10.0.0.5", keyName: "media" },
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
    { alias: "ghost", user: "u", hostname: "g.example", keyName: "not-saved" },
  ]);

  const view = sshView(db, secrets);

  assert.deepEqual(
    view.hosts.map((h) => [h.alias, h.keyMissing]),
    [
      ["media", false],
      ["box", false],
      ["ghost", true],
    ],
  );
  assert.ok(!JSON.stringify(view).includes("b3BlbnNzaA=="), "never values");
  assert.ok(!JSON.stringify(view).includes("OPENSSH"));
});

test("host input is normalized: surrounding spaces on user/hostname are trimmed, empty port omitted, empty key means no key", () => {
  const ok = validateHosts([
    { alias: "Media", user: "ubuntu ", hostname: " 10.0.0.5 ", port: "2222", keyName: " media " },
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
  ]);
  assert.deepEqual(ok, [
    { alias: "Media", user: "ubuntu", hostname: "10.0.0.5", port: 2222, keyName: "media" },
    { alias: "box", user: "root", hostname: "box.local", keyName: "" },
  ]);
  assert.deepEqual(
    validateHosts([{ alias: "a", user: "u", hostname: "h", port: 22, keyName: "" }]),
    [{ alias: "a", user: "u", hostname: "h", port: 22, keyName: "" }],
  );
});

test("invalid host input is rejected with a message naming the problem", () => {
  assert.throws(() => validateHosts(null), /list/i);
  assert.throws(() => validateHosts("nope"), /list/i);
  assert.throws(() => validateHosts([{ alias: " lead", user: "u", hostname: "h", keyName: "" }]), /alias/i);
  assert.throws(() => validateHosts([{ alias: "sp ace", user: "u", hostname: "h", keyName: "" }]), /alias/i);
  assert.throws(
    () =>
      validateHosts([
        { alias: "a", user: "u", hostname: "h", keyName: "" },
        { alias: "a", user: "u", hostname: "h2", keyName: "" },
      ]),
    /duplicate/i,
  );
  assert.throws(() => validateHosts([{ alias: "a", user: "  ", hostname: "h", keyName: "" }]), /user is required/i);
  assert.throws(() => validateHosts([{ alias: "a", user: "u", hostname: "", keyName: "" }]), /hostname is required/i);
  for (const bad of [0, 65536, "abc", 2.5, "1e3"]) {
    assert.throws(
      () => validateHosts([{ alias: "a", user: "u", hostname: "h", port: bad, keyName: "" }]),
      /port/i,
      JSON.stringify(bad),
    );
  }
  assert.throws(() => validateHosts([{ alias: "a", user: "u", hostname: "h", keyName: "bad name" }]), /key name/i);
});

test("sshConfig is the StrictHostKeyChecking line plus one Host block per host, omitting unset Port and missing key", () => {
  assert.equal(sshConfig([]), "StrictHostKeyChecking accept-new\n");
  assert.equal(
    sshConfig([
      { alias: "media", user: "ubuntu", hostname: "10.0.0.5", port: 2222, keyName: "media" },
      { alias: "box", user: "root", hostname: "box.local", keyName: "" },
    ]),
    [
      "StrictHostKeyChecking accept-new",
      "",
      "Host media",
      "    User ubuntu",
      "    HostName 10.0.0.5",
      "    Port 2222",
      "    IdentityFile ~/.ssh/media",
      "",
      "Host box",
      "    User root",
      "    HostName box.local",
    ].join("\n") + "\n",
  );
});

test("hosts save as a full list and load back; invalid input never lands", () => {
  const { db } = tmp();
  assert.deepEqual(loadSshHosts(db), []);
  const saved = saveSshHosts(db, [{ alias: "media", user: "ubuntu", hostname: "10.0.0.5", port: "", keyName: "media" }]);
  assert.deepEqual(saved, [{ alias: "media", user: "ubuntu", hostname: "10.0.0.5", keyName: "media" }]);
  assert.deepEqual(loadSshHosts(db), saved);
  assert.throws(() => saveSshHosts(db, [{ alias: "x", user: "", hostname: "h" }]), /user is required/i);
  assert.deepEqual(loadSshHosts(db), saved, "a rejected save leaves the previous list intact");
});
