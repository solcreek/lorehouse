// Q4 (#85): a channel taken off AGENT_CHANNELS. purge.ts removes its threads from
// LOREHOUSE_DB on start and notes that its sessions "are no longer reachable once the
// channel is unlisted". This checks the other path: a thread in a channel that STAYS listed
// whose earlier search returned the removed channel's text.
//   1. AGENT_CHANNELS=C1,C2; a C2 thread carries a marker word
//   2. asked in C1, the scripted model searches and quotes the C2 hit
//   3. restart with AGENT_CHANNELS=C1: purge.ts drops C2 from LOREHOUSE_DB
//   4. a follow-up in the C1 thread: is the C2 text in the model request?
//
//   bun docs/experiments/session-redaction/05-channel.ts [--cleanup]

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, admin, cleanup, mention, modelRequests, start } from "./harness.ts";
import { markerHits, markerRows } from "./01-where.ts";

const MARKER = "NARWHALMARKER";
const dir = join(tmpdir(), "lorehouse-poc66", "channel");
cleanup(dir);
const fixture = JSON.parse(readFileSync(join(REPO, "conformance/fixtures/slack-history.json"), "utf8"));
const c2Root = "1790000700.000100";
fixture.C2 = [{ ts: c2Root, user: "U3", text: `The mango supplier contract renews on the ${MARKER} terms we agreed` }];
const out: Record<string, unknown> = {};

let thread = "";
{
  const run = await start(dir, fixture, { env: { AGENT_CHANNELS: "C1,C2" } });
  try {
    out.listedBoth = { c2Doc: (await admin(run, `/api/v1/documents/slack:C2:${c2Root}`)).status };
    const q = await mention(run, "[q1] [quote] when does the mango supplier contract renew?");
    thread = q.ts;
    out.ask = { thread, quotesMarker: q.reply.includes(MARKER) };
  } finally {
    await run.stop();
  }
}
{
  const run = await start(dir, fixture, { env: { AGENT_CHANNELS: "C1" } });
  try {
    out.afterUnlist = {
      c2Doc: (await admin(run, `/api/v1/documents/slack:C2:${c2Root}`)).status,
      sessionsDbMarkerBytes: markerHits(run.sessionsDb, MARKER),
    };
    const before = (await modelRequests(run)).length;
    await mention(run, "anything else on suppliers?", thread);
    const reqs = (await modelRequests(run)).slice(before);
    out.followUpInC1 = reqs.map((r) => ({ messages: r.body.messages.length, markerInRequest: JSON.stringify(r.body).split(MARKER).length - 1 }));
  } finally {
    await run.stop();
  }
  out.sessionRows = markerRows(run.sessionsDb, MARKER).rows.map((r) => `${r.table} ${r.key} ${r.role ?? ""}`);
}
console.log(JSON.stringify(out, null, 2));
if (process.argv.includes("--cleanup")) cleanup(dir);
