// approvals.ts — who may answer a pull request card (PR_APPROVER, ADR 0002 §6), and who did.
//
// The card (src/tools/pull-request.ts) names a policy, APPROVER_POLICY, with the requester
// and the turn it was posted in. June asks authorizeAnswer (approverGate) as each click
// arrives; a click the rule lets through is recorded here, in Lorehouse's own database, as
// the card's approver for that turn. June doesn't hand the tool who answered when it
// resumes (the stored answer is the input alone), so this record is how the tool knows.
//
// At the moment of use, before it pushes, the tool checks the rule against the recorded
// approver (approvalStore.decide). A card with no record was answered without asking
// authorizeAnswer: one parked before this deploy, whose only answerer June keeps as the
// requester. Under requester and anyone that is what June's default allowed; under
// not-requester it fails closed.
//
// A record belongs to one card in one turn (the ts of the Slack message that started it), so
// a later card, even with the same id, never finds an earlier approver. The tool deletes it
// at every outcome except a failed push, so a retry in the same turn still finds it; the end
// of the turn deletes what is left (approverGate watches it), and prune() clears anything a
// restart left behind.

import type { Database } from "bun:sqlite";
import type { AuthorizeAnswer, TurnEvent } from "@junejs/core/agent-runtime";
import type { PrApprover } from "./config";

// The policy a pull request card names; approverGate decides each click on it.
export const APPROVER_POLICY = "pull-request-approver";

// What a card's policy carries: who asked (the attested speaker of the turn that posted it,
// or null) and that turn (its Slack message ts).
export type CardScope = { requester: string | null; turn: string };

// Whether `by` (the clicker, verified by the channel) may answer a card asked for by the
// scope's requester, under the install's rule. Nobody unidentified may; under requester or
// not-requester, a card with no known requester can't be checked, so nobody may.
export function mayApprove(rule: PrApprover, by: string | undefined, scope: unknown): boolean {
  if (!by) return false;
  if (rule === "anyone") return true;
  const requester = (scope as { requester?: unknown } | null | undefined)?.requester;
  if (typeof requester !== "string" || requester === "") return false;
  return rule === "requester" ? by === requester : by !== requester;
}

// One card in one turn of one session.
export type CardKey = { session: string; turn: string; card: string };

// How long a record may outlive a restart that kept its turn from ending.
export const APPROVAL_TTL_MS = 86_400_000;

export type ApprovalStore = {
  record(k: CardKey, approver: string, now?: Date): void;
  // At the push: the approver recorded for this card in this turn, checked against the rule,
  // in one transaction. With no record (a card parked before this deploy), only not-requester
  // refuses; requester's approver is then the requester, June's default answerer.
  decide(k: CardKey, rule: PrApprover, requester: string | null): { ok: boolean; approver?: string };
  forget(k: CardKey): void;
  forgetTurn(session: string, turn: string): void;
  prune(now?: Date): number;
  count(): number;
};

export function approvalStore(db: Database): ApprovalStore {
  const get = db.query<{ approver: string }, [string, string, string]>("SELECT approver FROM pr_approvals WHERE session = ? AND turn = ? AND card = ?");
  return {
    record(k, approver, now = new Date()) {
      db.query("INSERT OR REPLACE INTO pr_approvals (session, turn, card, approver, granted_at) VALUES (?, ?, ?, ?, ?)").run(k.session, k.turn, k.card, approver, now.toISOString());
    },
    decide(k, rule, requester) {
      return db.transaction(() => {
        const row = get.get(k.session, k.turn, k.card);
        if (row) return { ok: mayApprove(rule, row.approver, { requester }), approver: row.approver };
        if (rule === "not-requester") return { ok: false };
        return { ok: true, approver: rule === "requester" && requester ? requester : undefined };
      })();
    },
    forget(k) {
      db.query("DELETE FROM pr_approvals WHERE session = ? AND turn = ? AND card = ?").run(k.session, k.turn, k.card);
    },
    forgetTurn(session, turn) {
      db.query("DELETE FROM pr_approvals WHERE session = ? AND turn = ?").run(session, turn);
    },
    prune(now = new Date()) {
      return db.query("DELETE FROM pr_approvals WHERE granted_at < ?").run(new Date(now.getTime() - APPROVAL_TTL_MS).toISOString()).changes;
    },
    count() {
      return (db.query("SELECT count(*) AS n FROM pr_approvals").get() as { n: number }).n;
    },
  };
}

// The parts of a June session the gate uses: which turn is parked, and its events.
export type ParkedSession = {
  pending(): { turnId: string } | undefined;
  observe(cb: (e: TurnEvent) => void, opts: { turnId: string }): () => void;
};

// The install's rule as June's authorizeAnswer hook (src/app.ts wires it). A click it lets
// through is recorded as the card's approver in that turn, and the record is deleted when the
// turn ends, however it ends.
export function approverGate(rule: PrApprover, store: ApprovalStore, sessionOf: (session: string) => ParkedSession | undefined): AuthorizeAnswer {
  return ({ policy, scope, by, session, request }) => {
    if (policy !== APPROVER_POLICY || !mayApprove(rule, by, scope)) return false;
    const turn = (scope as Partial<CardScope> | undefined)?.turn;
    if (typeof turn !== "string" || turn === "") return false; // every card this version posts names its turn
    store.record({ session, turn, card: request.id }, by!);
    const s = sessionOf(session);
    const turnId = s?.pending()?.turnId;
    if (s && turnId) {
      const off = s.observe((e) => {
        if (e.type !== "turn.completed" && e.type !== "turn.failed" && e.type !== "turn.cancelled") return;
        off();
        store.forgetTurn(session, turn);
      }, { turnId });
    }
    return true;
  };
}
