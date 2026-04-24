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
  const { pageLoadTimeout, actionDelay } = config.run;

  // --- Navigate to search page ---
  // TODO: Confirm the search URL. Reonomy may use /search, /properties, or a different path.
  console.log("[search] Navigating to search page...");
  await page.goto(`${config.reonomy.baseUrl}/search`, {
    waitUntil: "domcontentloaded",
    timeout: pageLoadTimeout,
  });
  console.log(`[search] Search page loaded: ${page.url()}`);
  await sleep(actionDelay);

  // --- Enter ZIP code ---
  // TODO: Reonomy's search interface may be a universal search bar, a map-based filter,
  // or a sidebar filter panel. Update the Stagehand action description to match.
  console.log(`[search] Entering ZIP code: ${zipCode}`);
  await page.act({
    action: `Find the search or location input field, clear it, and type "${zipCode}"`,
  });
  await sleep(1000);

  // --- Submit search / Select suggestion ---
  // TODO: Reonomy may show autocomplete suggestions for ZIP codes.
  // You may need to click a dropdown suggestion rather than pressing Enter.
  console.log("[search] Submitting search...");
  await page.act({
    action: `If a dropdown suggestion matching ZIP code "${zipCode}" appears, click it. Otherwise press Enter to submit the search.`,
  });
  await sleep(actionDelay);

  // --- Optionally apply "Commercial" building type filter ---
  // TODO: If Reonomy shows all property types by default, uncomment and adjust:
  // console.log("[search] Applying Commercial filter...");
  // await stagehand.act({
  //   action: 'Click the "Property Type" or "Building Type" filter and select "Commercial"',
  // });
  // await sleep(actionDelay);

  await waitForResults(stagehand, zipCode);
}
