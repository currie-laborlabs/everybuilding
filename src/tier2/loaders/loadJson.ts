/**
 * src/tier2/loaders/loadJson.ts
 *
 * Typed loaders for the two JSON config files that drive Tier 2.
 *
 * Both files live on disk (local file paths, not Google Drive).
 * Paths are supplied at runtime via env vars or explicit arguments.
 *
 * Validation is intentionally minimal — the types enforce structure at
 * compile time; runtime we only check the two required top-level keys
 * so that the error message is actionable.
 */

import fs from "fs/promises";
import path from "path";
import type { CtaPlaybook } from "../types/index.js";
import type { ClientVoiceProfile } from "../types/index.js";

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  const resolved = path.resolve(filePath);
  let raw: string;
  try {
    raw = await fs.readFile(resolved, "utf-8");
  } catch (err) {
    throw new Error(
      `[loadJson] Cannot read ${label} from "${resolved}": ${(err as NodeJS.ErrnoException).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[loadJson] "${resolved}" is not valid JSON.`);
  }

  return parsed as T;
}

/**
 * Load and return a CtaPlaybook from a JSON file.
 * Throws with a clear message if the file is missing or malformed.
 */
export async function loadCtaPlaybook(filePath: string): Promise<CtaPlaybook> {
  const data = await readJsonFile<CtaPlaybook>(filePath, "CTA_Playbook");

  if (!data.version || !data.ctas) {
    throw new Error(
      `[loadJson] CTA_Playbook at "${filePath}" is missing required keys (version, ctas).`
    );
  }

  return data;
}

/**
 * Load and return a ClientVoiceProfile from a JSON file.
 * Throws with a clear message if the file is missing or malformed.
 */
export async function loadVoiceProfile(filePath: string): Promise<ClientVoiceProfile> {
  const data = await readJsonFile<ClientVoiceProfile>(filePath, "Client_Voice_Profile");

  if (!data.client_id || !data.company_basics) {
    throw new Error(
      `[loadJson] Client_Voice_Profile at "${filePath}" is missing required keys (client_id, company_basics).`
    );
  }

  return data;
}
