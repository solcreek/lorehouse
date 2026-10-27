// tenant-key.ts — the tenant's data key: the one key its database files are encrypted with
// (#148; ADR 0004, ADR 0005 §2). It is 32 random bytes made on the tenant's first start
// with a key service configured, and kept only as an envelope in `key.json` in the
// tenant's directory, wrapped by the tenant's Strongroom deployment under its KMS key.
// Every start unwraps it again; nothing else stores it.
//
//   no key.json, no Strongroom   plaintext files, as before #148
//   no key.json, Strongroom      a new key is made, proved to unwrap, then kept; the
//                                databases are encrypted in place (src/app.ts)
//   key.json, Strongroom         the key is unwrapped; the files open only with it
//   key.json, no Strongroom      the start fails: the files are encrypted
//
// Destroying the tenant's KMS key leaves key.json unwrappable, and with it every copy of
// the files, backups included. A disabled key fails the start the same way, until it is
// enabled again.
//
// The key the start returns is the caller's to wipe (`fill(0)`) once the databases are
// open. Strongroom's client reads it into that one buffer and never makes a string of it.
// Wrapping a new key sends it as base64url text, which can't be wiped: that happens once,
// on the first start.

import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Strongroom, StrongroomError, type Envelope } from "strongroom";
import { CIPHER, fileKind, KEY_BYTES } from "./sqlite";
import type { Tenant } from "./tenant";

export const KEY_FILE = "key.json";

// What the envelope is bound to (Strongroom's AAD): the tenant, and which of its keys this
// is. An envelope moved into another tenant's directory doesn't unwrap there.
export type KeyContext = { tenantId: string; recordId: string; purpose: string };
export const contextFor = (tenantId: string): KeyContext => ({ tenantId, recordId: "database-key", purpose: "lorehouse-database" });

// Wraps and unwraps a data key: Strongroom (strongroomKeys), or a fake in tests.
export interface KeyService {
  wrap(key: Uint8Array, context: KeyContext): Promise<Envelope>;
  unwrap(envelope: Envelope, context: KeyContext): Promise<Uint8Array>;
}

export function strongroomKeys(config: { url: string; token: string; key: string }, fetchImpl?: typeof fetch): KeyService {
  const client = new Strongroom({ url: config.url, token: config.token, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return {
    wrap: (key, context) => client.encrypt({ plaintext: key, context, key: config.key }),
    unwrap: (envelope, context) => client.decryptBytes({ envelope, context }),
  };
}

type KeyFile = { version: 1; tenant: string; cipher: typeof CIPHER; envelope: Envelope; created: string };

export class TenantKeyError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = "TenantKeyError";
  }
}

export type TenantKey = { key: Uint8Array; made: boolean };

// The tenant's data key, or undefined for plaintext files (see the table at the top).
// `files`: the tenant's databases. With no key file, one that is already encrypted (or isn't
// a database) fails the start rather than get a new key it can't be opened with: its
// key.json is missing.
export async function loadTenantKey(tenant: Tenant, service: KeyService | undefined, files: string[] = []): Promise<TenantKey | undefined> {
  // A tenant in memory has no files to encrypt.
  if (tenant.source === "throwaway") return undefined;
  const path = join(tenant.dir, KEY_FILE);
  if (existsSync(path)) {
    const file = readKeyFile(path, tenant.id);
    if (!service) throw new TenantKeyError(`tenant ${tenant.id}'s files are encrypted (${path}), and the start needs its key: set STRONGROOM_URL, STRONGROOM_TOKEN and STRONGROOM_KEY`);
    return { key: await unwrap(service, file.envelope, tenant.id), made: false };
  }
  const unreadable = files.filter((f) => fileKind(f) === "other");
  if (unreadable.length) throw new TenantKeyError(`${unreadable.join(" and ")} ${unreadable.length === 1 ? "is" : "are"} encrypted (or not SQLite), but tenant ${tenant.id} has no ${path}: put back the key.json it was encrypted with${service ? "; no new key was made" : ", and set STRONGROOM_URL, STRONGROOM_TOKEN and STRONGROOM_KEY"}`);
  if (!service) return undefined;
  return { key: await make(service, tenant, path), made: true };
}

function readKeyFile(path: string, tenantId: string): KeyFile {
  let file: KeyFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new TenantKeyError(`${path} isn't readable: ${e instanceof Error ? e.message : e}`);
  }
  if (file?.version !== 1 || file.cipher !== CIPHER || typeof file.envelope !== "object" || file.envelope === null) {
    throw new TenantKeyError(`${path} isn't a version 1 key file for the ${CIPHER} cipher`);
  }
  if (file.tenant !== tenantId) throw new TenantKeyError(`${path} holds tenant ${file.tenant}'s key, not tenant ${tenantId}'s`);
  return file;
}

async function unwrap(service: KeyService, envelope: Envelope, tenantId: string): Promise<Uint8Array> {
  let key: Uint8Array;
  try {
    key = await service.unwrap(envelope, contextFor(tenantId));
  } catch (e) {
    throw keyError(e, `can't unwrap tenant ${tenantId}'s data key`);
  }
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    throw new TenantKeyError(`tenant ${tenantId}'s data key unwrapped to ${key.length} bytes, not ${KEY_BYTES}`);
  }
  return key;
}

async function make(service: KeyService, tenant: Tenant, path: string): Promise<Uint8Array> {
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    let envelope: Envelope;
    try {
      envelope = await service.wrap(key, contextFor(tenant.id));
    } catch (e) {
      throw keyError(e, `can't wrap a new data key for tenant ${tenant.id}`);
    }
    // Nothing is encrypted under a key this install can't get back: unwrap it first.
    const back = await unwrap(service, envelope, tenant.id);
    const same = back.every((b, i) => b === key[i]);
    back.fill(0);
    if (!same) throw new TenantKeyError(`tenant ${tenant.id}'s new data key didn't unwrap to itself`);
    keep(path, { version: 1, tenant: tenant.id, cipher: CIPHER, envelope, created: new Date().toISOString() });
    return key;
  } catch (e) {
    key.fill(0);
    throw e;
  }
}

// Written whole and synced, then linked into place: a crash leaves no key file or a whole
// one, and a key file already there is never replaced.
function keep(path: string, file: KeyFile): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as { code?: string }).code === "EEXIST") throw new TenantKeyError(`${path} appeared while this start made a key: another process is starting this tenant`);
      throw e;
    }
    const dir = openSync(join(path, ".."), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Strongroom's errors say what failed and whether a retry can help; a KMS key that is
// disabled or destroyed says the tenant is suspended or deleted.
function keyError(e: unknown, what: string): TenantKeyError {
  if (e instanceof TenantKeyError) return e;
  if (e instanceof StrongroomError) {
    const why = e.code === "KMS_KEY_UNAVAILABLE" ? " (its KMS key is missing, disabled or destroyed: the tenant is suspended or deleted)" : "";
    return new TenantKeyError(`${what}: Strongroom ${e.code}${why}: ${e.message}`, e.retryable);
  }
  return new TenantKeyError(`${what}: ${e instanceof Error ? e.message : e}`);
}
