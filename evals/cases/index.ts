// Every case, in the order they are listed and run. A new file of cases is added here.

import type { Case } from "../case";
import { cases as pullRequest } from "./code-pull-request";
import { cases as repo } from "./code-repo";
import { cases as run } from "./code-run";
import { cases as knowledge } from "./knowledge";

export const CASES: Case[] = [...repo, ...run, ...pullRequest, ...knowledge];
