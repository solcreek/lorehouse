// The SQL in /migrations, embedded (so a compiled binary carries it). Add new files
// here in order; never edit an applied one.
import m0001 from "../migrations/0001_knowledge.sql" with { type: "text" };

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "0001_knowledge.sql", sql: m0001 },
];
