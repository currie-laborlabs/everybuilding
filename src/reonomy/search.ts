import type { Stagehand } from "@browserbasehq/stagehand";
import { config } from "../config";
import { sleep } from "../utils";

/**
 * Confirm that property results are visible on the page.
 * Throws if nothing loads.
 */
async function waitForResults(stagehand: Stagehand, zipCode: string): Promise<void> {
  const page = stagehand.page;
  console.log("[search] Waiting for results...");
  try {
    await page.observe({
      instruction:
        "Check if property results are visible on the page — look for property cards, a results table, or a list of addresses.",
    });
    console.log("[search] Results page loaded.");
    console.log(`[search] Results page URL: ${page.url()}`);
  } catch {
    throw new Error(
      `[search] No results found for ZIP ${zipCode}. The page may require different search interaction.`
    );
  }
}

/**
 * Navigates to Reonomy's property search, enters a ZIP code,
 * and waits for the results page to render.
 */
export async function searchByZipCode(
  stagehand: Stagehand,
  zipCode: string
): Promise<void> {
  const page = stagehand.page;
  const { actionDelay } = config.run;

  // After login we're already on /!/home which has the central search bar.
  // No navigation needed — just use the search field directly.
  console.log(`[search] Entering ZIP code: ${zipCode}`);
  await page.act({
    action: `Click the search input field that says "Search by address, location, or owner" and type "${zipCode}"`,
  });
  await sleep(1000);

  // Submit — press Enter, do NOT click any autocomplete suggestion.
  console.log("[search] Pressing Enter to submit search...");
  await page.keyboard.press("Enter");
  await sleep(actionDelay);

  await waitForResults(stagehand, zipCode);
}
