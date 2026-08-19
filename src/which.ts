/**
 * Cross-platform `which` — find executable in PATH.
 */

import { accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";
import { env } from "node:process";

export function which(cmd: string): string | null {
  const pathEnv = (env.PATH ?? "").split(delimiter).filter(Boolean);
  // On non-Windows, append standard paths
  if (env.OS !== "Windows_NT") {
    for (const p of ["/usr/local/bin", "/usr/bin", "/bin"]) {
      if (!pathEnv.includes(p)) pathEnv.push(p);
    }
  }
  for (const dir of pathEnv) {
    const full = join(dir, cmd);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      continue;
    }
  }
  return null;
}
