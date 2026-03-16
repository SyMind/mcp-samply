import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_SAMPLY_BIN = process.env.MCP_SAMPLY_BIN || "samply";

export async function canAccessPath(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(filePath: string): Promise<string | null> {
  if (filePath.includes("/") || filePath.includes("\\")) {
    const absolutePath = path.resolve(filePath);
    return (await canAccessPath(absolutePath)) ? absolutePath : null;
  }

  const searchPath = process.env.PATH ?? "";
  const pathEntries = searchPath.split(path.delimiter).filter(Boolean);
  const windowsExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];

  for (const pathEntry of pathEntries) {
    for (const extension of windowsExtensions) {
      const candidate = path.join(pathEntry, `${filePath}${extension}`);
      if (await canAccessPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
