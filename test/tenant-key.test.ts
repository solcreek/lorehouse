// The tenant's data key (#148): made once and kept only wrapped, unwrapped on every start,
// and the tenant's databases readable only with it. A KMS key destroyed or disabled
// leaves the files unreadable.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StrongroomError, type Envelope } from "strongroom";
import { closeKnowledge, openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { Database, encryptInPlace, fileKind, KeyMismatchError } from "../src/sqlite";
import { contextFor, KEY_FILE, loadTenantKey, strongroomKeys, TenantKeyError, type KeyContext, type KeyService } from "../src/tenant-key";
import type { Tenant } from "../src/tenant";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tenantAt(id = "acme"): Tenant {
  const dataDir = mkdtempSync(join(tmpdir(), "lh-key-"));
  dirs.push(dataDir);
  mkdirSync(join(dataDir, id));
  return { id, source: "configured", dataDir, dir: join(dataDir, id) };
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// Strongroom's contract, in memory: AES-GCM under one KEK, the context as AAD. `state`
// stands for the KMS key: disabled or destroyed, nothing unwraps.
class FakeKms implements KeyService {
  state: "enabled" | "disabled" | "destroyed" = "enabled";
  wraps = 0;
  private kek = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  async wrap(key: Uint8Array, context: KeyContext): Promise<Envelope> {
    this.wraps++;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(JSON.stringify(context)) }, await this.kek, key as Uint8Array<ArrayBuffer>));
    return { version: 1, algorithm: "A256GCM", key: "tenant", nonce: b64(nonce), ciphertext: b64(ct), wrappedKey: "fake" };
  }
  async unwrap(envelope: Envelope, context: KeyContext): Promise<Uint8Array> {
    if (this.state !== "enabled") throw new StrongroomError("KMS_KEY_UNAVAILABLE", "Configured KMS key is missing, disabled or unusable.", 502);
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.nonce), additionalData: new TextEncoder().encode(JSON.stringify(context)) }, await this.kek, unb64(envelope.ciphertext)));
    } catch {
      throw new StrongroomError("DECRYPT_FAILED", "Envelope could not be decrypted.", 400);
    }
  }
}

const SECRET = "the launch moves to march";
function knowledgeWith(path: string, key?: Uint8Array) {
  const db = openKnowledge(path, undefined, undefined, key);
  upsertDocument(db, { docId: "seed:1", kind: "seed", source: "s", title: "Plans", text: SECRET });
  return db;
}
// Every byte the database left on disk, -wal and -shm included.
const onDisk = (path: string) => ["", "-wal", "-shm"].map((s) => (existsSync(path + s) ? readFileSync(path + s).toString("latin1") : "")).join("");

describe("the tenant's data key", () => {
  test("with no key service and no key file, the files stay plaintext and nothing is written", async () => {
    const t = tenantAt();
    expect(await loadTenantKey(t, undefined)).toBeUndefined();
    expect(existsSync(join(t.dir, KEY_FILE))).toBe(false);
  });

  test("a tenant in memory has no key, whatever is configured", async () => {
    const t = { ...tenantAt(), source: "throwaway" as const };
    expect(await loadTenantKey(t, new FakeKms())).toBeUndefined();
    expect(existsSync(join(t.dir, KEY_FILE))).toBe(false);
  });

  test("the first start makes a 32-byte key and keeps it wrapped, owner-only; later starts unwrap the same key", async () => {
    const t = tenantAt();
    const kms = new FakeKms();
    const first = (await loadTenantKey(t, kms))!;
    expect(first.made).toBe(true);
    expect(first.key.length).toBe(32);
    const file = join(t.dir, KEY_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(kept).toMatchObject({ version: 1, tenant: "acme", cipher: "aegis", envelope: { version: 1 } });
    expect(readFileSync(file, "utf8")).not.toContain(b64(first.key));
    const again = (await loadTenantKey(t, kms))!;
    expect(again.made).toBe(false);
    expect(Buffer.from(again.key).equals(Buffer.from(first.key))).toBe(true);
    expect(kms.wraps).toBe(1);
  });

  test("a key that doesn't unwrap back is never kept", async () => {
    const t = tenantAt();
    const kms = new FakeKms();
    const broken: KeyService = { wrap: (k, c) => kms.wrap(k, c), unwrap: async () => new Uint8Array(32) };
    await expect(loadTenantKey(t, broken)).rejects.toThrow(/didn't unwrap to itself/);
    expect(existsSync(join(t.dir, KEY_FILE))).toBe(false);
  });

  test("encrypted files and no key service: the start fails, naming what to set", async () => {
    const t = tenantAt();
    await loadTenantKey(t, new FakeKms());
    await expect(loadTenantKey(t, undefined)).rejects.toThrow(/files are encrypted .* set STRONGROOM_URL, STRONGROOM_TOKEN and STRONGROOM_KEY/);
  });

  test("a disabled or destroyed KMS key fails the start: the tenant is suspended or deleted", async () => {
    const t = tenantAt();
    const kms = new FakeKms();
    await loadTenantKey(t, kms);
    for (const state of ["disabled", "destroyed"] as const) {
      kms.state = state;
      const err = await loadTenantKey(t, kms).catch((e) => e);
      expect(err).toBeInstanceOf(TenantKeyError);
      expect(err.message).toMatch(/KMS_KEY_UNAVAILABLE .*suspended or deleted/);
    }
  });

  test("another tenant's key file doesn't open this tenant's files", async () => {
    const a = tenantAt("acme"), b = tenantAt("beta");
    const kms = new FakeKms();
    await loadTenantKey(a, kms);
    writeFileSync(join(b.dir, KEY_FILE), readFileSync(join(a.dir, KEY_FILE)));
    await expect(loadTenantKey(b, kms)).rejects.toThrow(/holds tenant acme's key, not tenant beta's/);
    // Relabelled, the envelope still doesn't unwrap: it is bound to the tenant it was made for.
    const kept = JSON.parse(readFileSync(join(b.dir, KEY_FILE), "utf8"));
    writeFileSync(join(b.dir, KEY_FILE), JSON.stringify({ ...kept, tenant: "beta" }));
    await expect(loadTenantKey(b, kms)).rejects.toThrow(/DECRYPT_FAILED/);
  });

  test("an encrypted database and no key file: no new key is made over it, and the start says key.json is missing", async () => {
    const t = tenantAt();
    const kms = new FakeKms();
    const path = join(t.dir, "lorehouse.db");
    const { key } = (await loadTenantKey(t, kms))!;
    closeKnowledge(knowledgeWith(path, key));
    rmSync(join(t.dir, KEY_FILE));
    await expect(loadTenantKey(t, kms, [path])).rejects.toThrow(/lorehouse\.db is encrypted \(or not SQLite\), but tenant acme has no .*key\.json: put back the key\.json it was encrypted with; no new key was made/);
    expect(existsSync(join(t.dir, KEY_FILE))).toBe(false);
    await expect(loadTenantKey(t, undefined, [path])).rejects.toThrow(/put back the key\.json .* and set STRONGROOM_URL/);
    // Plaintext or absent files are what a first key is made over.
    expect((await loadTenantKey(t, kms, [join(t.dir, "absent.db")]))?.made).toBe(true);
  });

  test("the envelope is bound to the tenant and to its purpose", () => {
    expect(contextFor("acme")).toEqual({ tenantId: "acme", recordId: "database-key", purpose: "lorehouse-database" });
  });
});

describe("encrypted databases", () => {
  test("a plaintext knowledge database is encrypted in place: nothing readable on disk, the same answers with the key", async () => {
    const t = tenantAt();
    const path = join(t.dir, "lorehouse.db");
    closeKnowledge(knowledgeWith(path));
    expect(onDisk(path)).toContain(SECRET);
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    expect(encryptInPlace(path, key)).toBe("encrypted");
    expect(onDisk(path)).not.toContain(SECRET);
    const db = openKnowledge(path, undefined, undefined, key);
    expect(searcher(db)("launch").map((c) => c.id)).toEqual(["seed:1"]);
    closeKnowledge(db);
    // Already encrypted: left alone.
    expect(encryptInPlace(path, key)).toBe("not-plaintext");
  });

  test("a plaintext file a crash left with frames in its -wal is encrypted with them", async () => {
    const t = tenantAt();
    const live = join(t.dir, "live.db");
    const db = knowledgeWith(live);
    // Copied while open: the copy is what a crash leaves, the latest write only in the -wal.
    const path = join(t.dir, "lorehouse.db");
    for (const s of ["", "-wal"]) writeFileSync(path + s, readFileSync(live + s));
    closeKnowledge(db);
    expect(statSync(path + "-wal").size).toBeGreaterThan(0);
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    expect(encryptInPlace(path, key)).toBe("encrypted");
    expect(onDisk(path)).not.toContain(SECRET);
    const again = openKnowledge(path, undefined, undefined, key);
    expect(searcher(again)("launch").map((c) => c.id)).toEqual(["seed:1"]);
    expect(again.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    closeKnowledge(again);
  });

  test("a database reached through a symlink (the old layout's path) is encrypted where the file is", async () => {
    const t = tenantAt();
    const path = join(t.dir, "lorehouse.db");
    closeKnowledge(knowledgeWith(path));
    const old = join(t.dataDir, "lorehouse.db");
    symlinkSync(path, old);
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    expect(encryptInPlace(old, key)).toBe("encrypted");
    expect(lstatSync(old).isSymbolicLink()).toBe(true);
    expect(fileKind(path)).toBe("other");
    expect(onDisk(path)).not.toContain(SECRET);
    closeKnowledge(openKnowledge(old, undefined, undefined, key));
  });

  test("written under the key, no plaintext reaches the file or its -wal", async () => {
    const t = tenantAt();
    const path = join(t.dir, "lorehouse.db");
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    expect(encryptInPlace(path, key)).toBe("no-file");
    const db = knowledgeWith(path, key);
    // Still open: the write is in the -wal.
    expect(statSync(path + "-wal").size).toBeGreaterThan(0);
    expect(onDisk(path)).not.toContain(SECRET);
    closeKnowledge(db);
    expect(onDisk(path)).not.toContain(SECRET);
  });

  test("without the key, with another key, or as plaintext, an encrypted file doesn't open", async () => {
    const t = tenantAt();
    const path = join(t.dir, "lorehouse.db");
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    closeKnowledge(knowledgeWith(path, key));
    expect(() => new Database(path, { key: crypto.getRandomValues(new Uint8Array(32)) })).toThrow(KeyMismatchError);
    expect(() => new Database(path).query("SELECT count(*) FROM sqlite_master").get()).toThrow(/not a database/);
    // A plaintext file opened with a key is refused too: encryptInPlace is the only way in.
    const plain = join(t.dir, "plain.db");
    new Database(plain).exec("CREATE TABLE t (x)");
    expect(() => new Database(plain, { key })).toThrow(KeyMismatchError);
  });

  test("a key that isn't 32 bytes is refused", () => {
    const t = tenantAt();
    expect(() => new Database(join(t.dir, "x.db"), { key: new Uint8Array(31) })).toThrow(/32 bytes, got 31/);
  });

  test("the session store opens through the same driver with the key, in WAL, with nothing readable on disk", async () => {
    const t = tenantAt();
    const path = join(t.dir, "sessions.db");
    const { key } = (await loadTenantKey(t, new FakeKms()))!;
    const db = new Database(path, { key });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE turns (body TEXT)");
    db.query("INSERT INTO turns VALUES (?)").run(SECRET);
    expect(onDisk(path)).not.toContain(SECRET);
    db.close();
    const again = new Database(path, { key });
    expect(again.query("SELECT body FROM turns").get()).toEqual({ body: SECRET });
    again.close();
  });
});

describe("Strongroom's client", () => {
  // Strongroom's HTTP contract as far as Lorehouse uses it: bytes in as base64url, out as
  // application/octet-stream when asked for.
  test("wraps the key as bytes and unwraps it as bytes", async () => {
    const seen: { encrypt?: Record<string, unknown>; accept?: string | null } = {};
    const store = new Map<string, Uint8Array>();
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, any>;
        if (new URL(req.url).pathname === "/v1/encrypt") {
          seen.encrypt = body;
          store.set("c", unb64(body.plaintextBase64url));
          return Response.json({ envelope: { version: 1, algorithm: "A256GCM", key: body.key, nonce: "n", ciphertext: "c", wrappedKey: "w" } });
        }
        seen.accept = req.headers.get("accept");
        return new Response(store.get(body.envelope.ciphertext)! as Uint8Array<ArrayBuffer>, { headers: { "content-type": "application/octet-stream" } });
      },
    });
    try {
      const keys = strongroomKeys({ url: `http://127.0.0.1:${server.port}`, token: "t".repeat(32), key: "tenant-acme" });
      const key = crypto.getRandomValues(new Uint8Array(32));
      const envelope = await keys.wrap(key, contextFor("acme"));
      expect(seen.encrypt).toMatchObject({ key: "tenant-acme", context: contextFor("acme"), plaintextBase64url: b64(key) });
      expect(seen.encrypt).not.toHaveProperty("plaintext");
      const back = await keys.unwrap(envelope, contextFor("acme"));
      expect(seen.accept).toBe("application/octet-stream");
      expect(back).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(back).equals(Buffer.from(key))).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
