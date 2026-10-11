-- Who answered a pull request card (open_pull_request): the answerer June names when it
-- applies a click the rule let through (input.resolved), so the tool can check PR_APPROVER
-- against that person at the moment it pushes, and name them in the pull request
-- (src/approvals.ts). One row per card in one turn: `turn` is the ts of the Slack message
-- that started the turn, `card` the card's input id. The tool deletes the row at once on a
-- Deny or a refusal; every other outcome keeps it until the turn ends (a retry of the tool in
-- the same turn, or a replay of it after the PR opened, uses it again), and anything older
-- than a day goes on start and daily.
CREATE TABLE pr_approvals (
  session     TEXT NOT NULL,
  turn        TEXT NOT NULL,
  card        TEXT NOT NULL,
  approver    TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  PRIMARY KEY (session, turn, card)
);
