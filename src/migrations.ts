// The SQL in /migrations, embedded (so a compiled binary carries it). Add new files
// here in order; never edit an applied one.
import m0001 from "../migrations/0001_knowledge.sql" with { type: "text" };
import m0002 from "../migrations/0002_documents.sql" with { type: "text" };
import m0003 from "../migrations/0003_source_version.sql" with { type: "text" };
import m0004 from "../migrations/0004_cjk_index.sql" with { type: "text" };

export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  { version: 1, name: "0001_knowledge.sql", sql: m0001 },
  { version: 2, name: "0002_documents.sql", sql: m0002 },
  { version: 3, name: "0003_source_version.sql", sql: m0003 },
  { version: 4, name: "0004_cjk_index.sql", sql: m0004 },
];
