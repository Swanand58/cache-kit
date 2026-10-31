import { readFileSync } from "node:fs";
/** The published version. package.json is the only place it is written; src/ and dist/ both sit one level below it. */
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
