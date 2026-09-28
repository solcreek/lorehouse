-- Which runner holds each sandbox. A sandbox's disk (the thread's checkout) lives on one
-- runner, so every later job for it goes there; see docs/sandbox-runners.md.
CREATE TABLE sandbox_placements (
  sandbox    TEXT PRIMARY KEY,
  runner     TEXT NOT NULL,
  placed_at  TEXT NOT NULL
);
