import path from "node:path";

import { ProfileStore } from "../profile/store.js";

export interface SamplyToolState {
  latestProfilePath: string | null;
  profileStore: ProfileStore;
}

export function resolveRequestedProfilePath(
  state: SamplyToolState,
  profilePath: string | undefined,
): string {
  if (profilePath !== undefined) {
    return path.resolve(profilePath);
  }

  if (state.latestProfilePath !== null) {
    return state.latestProfilePath;
  }

  throw new Error(
    "No profilePath was provided and there is no previously recorded profile in this MCP session.",
  );
}
