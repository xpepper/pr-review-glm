// Running release version for /z-pr-review status (V1): read from plugin.json
// beside the extension at status time. Purely informational — never a gate or
// authority input — so any read/parse failure degrades to null, which
// renderStatus shows as "(unknown)", never an error.
import { readFileSync } from "node:fs";

export function readPluginVersion(manifestUrl = new URL("../../plugin.json", import.meta.url)) {
  try {
    const version = JSON.parse(readFileSync(manifestUrl, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
