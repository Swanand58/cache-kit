import { readFileSync } from "node:fs";
/** The release version. The root VERSION file is the source; the release workflow copies it into package.json. src/ and dist/ both sit one level below it. */
export const VERSION = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
