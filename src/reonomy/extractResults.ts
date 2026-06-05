import type { Stagehand, StagehandPage } from "@browserbasehq/stagehand";
import { z } from "zod";
import type { RawReonomyRecord } from "../types";
import { sleep } from "../utils";
import { config } from "../config";

/**
 * JSON Schema for the Stagehand extract() call.
 * Describes the shape we expect Reonomy's results page to produce.
 *
 * TODO: If Reonomy's results show different or additional fields,
 * update both this schema AND the RawReonomyRecord type.
 */
const EXTRACTION_SCHEMA = z.object({
  properties: z.array(
    z.object({
      property_address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip_code: z.string().optional(),
      land_use: z.string().optional(),
      square_feet: z.string().optional(),
      year_built: z.string().optional(),
      owner_entity: z.string().optional(),
    })
  ),
});

// TODO: Adjust this instruction if the page layout differs
// (e.g., table vs. card grid vs. map + sidebar).
const EXTRACTION_INSTRUCTION = `
Extract ALL commercial property listings visible on this results page.
For each property, extract:
- property_address: the full street address (e.g., "4300 Commerce Dr")
- city: the city name
- state: the state abbreviation (e.g., "NC")
- zip_code: the 5-digit ZIP code
- land_use: the property/building type (e.g., "Office", "Industrial", "Retail")
- square_feet: the building square footage (just the number, no commas)
- year_built: the year the building was constructed
- owner_entity: the owner or ownership entity name (e.g., "Ridgeway Holdings LLC")

If a field is not visible for a property, use an empty string.
Return every property visible on the page, not just the first one.
`.trim();

/**
 * Scroll the results list panel to the bottom and back to the top so that
 * virtualised rows are all rendered before we call page.extract().
 * Reonomy renders only the cards in the viewport — without this scroll pass
 * the AI only sees the 4-6 cards currently visible and misses the rest.
 */
async function scrollResultsListFully(page: StagehandPage): Promise<void> {
  try {
    // Identify the scrollable results panel (left sidebar / card list)
    const PANEL_SELECTORS = [
      "[class*='results-list']", "[class*='ResultsList']",
      "[class*='property-list']", "[class*='PropertyList']",
      "[class*='search-results']", "[class*='SearchResults']",
      "[class*='card-list']", "[class*='CardList']",
      "[class*='left-panel']", "[class*='LeftPanel']",
      "[class*='sidebar']", "[class*='Sidebar']",
      "[class*='list-container']", "[class*='ListContainer']",
    ];

    await page.evaluate(async (selectors: string[]) => {
      // Find the scrollable results container
      let panel: HTMLElement | null = null;
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && el.scrollHeight > el.clientHeight + 50) {
          panel = el;
          break;
        }
      }

      // Fallback: largest scrollable non-body element
      if (!panel) {
        const bodyH = document.body.scrollHeight;
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
          if (el.scrollHeight === bodyH) return false;
          const s = window.getComputedStyle(el);
          return (
            (s.overflow === "auto" || s.overflow === "scroll" ||
             s.overflowY === "auto" || s.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 50
          );
        });
        candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
        panel = candidates[0] ?? null;
      }

      if (!panel) return; // Nothing to scroll

      // Scroll to bottom in steps so the browser renders each batch of cards
      const step = panel.clientHeight;
      let pos = 0;
      while (pos < panel.scrollHeight) {
        pos += step;
        panel.scrollTo({ top: pos, behavior: "instant" });
        // Small pause to let the virtual renderer catch up
        await new Promise<void>((r) => setTimeout(r, 150));
      }

      // Scroll back to top so the AI sees cards in natural order
      panel.scrollTo({ top: 0, behavior: "instant" });
      await new Promise<void>((r) => setTimeout(r, 300));
    }, PANEL_SELECTORS);

    await sleep(800); // Final settle
  } catch {
    // Non-critical — proceed with whatever is visible
  }
}

/**
 * Extract raw property records from ONE currently-visible results page.
 */
export async function extractResultsPage(
  stagehand: Stagehand
): Promise<RawReonomyRecord[]> {
  const page = stagehand.page;
  console.log("[extract] Scrolling results list to load all cards...");
  await scrollResultsListFully(page);
  console.log("[extract] Extracting property data from current page...");

  const extracted = await page.extract({
    instruction: EXTRACTION_INSTRUCTION,
    schema: EXTRACTION_SCHEMA,
  });

  const records: RawReonomyRecord[] = extracted.properties ?? [];
  console.log(`[extract] Number of raw records extracted on page: ${records.length}`);

  if (records.length === 0) {
    console.warn(
      "[extract] WARNING: Zero records extracted. Page structure may have changed."
    );
  }

  return records;
}

/**
 * Try to advance to the next results page. Returns false if there is no next page.
 */
export async function goToNextPage(stagehand: Stagehand): Promise<boolean> {
  const page = stagehand.page;
  // TODO: Reonomy's pagination may be a "Next" button, page numbers,
  // infinite scroll, or "Load More". Adjust the action below.
  console.log("[extract] Attempting to navigate to next page...");
  try {
    await page.act({
      action:
        'Click the "Next" button or next page arrow to go to the next page of results.',
    });
    await sleep(config.run.actionDelay);
    return true;
  } catch {
    console.log("[extract] No next page found — end of results.");
    return false;
  }
}

/**
 * Extract results across up to `maxPages` pages.
 * Stops early if pagination ends.
 */
export async function extractAllPages(
  stagehand: Stagehand,
  maxPages: number
): Promise<RawReonomyRecord[]> {
  const allRecords: RawReonomyRecord[] = [];

  for (let page = 1; page <= maxPages; page++) {
    console.log(`[extract] --- Page ${page} of ${maxPages} ---`);
    console.log(`[extract] Extracting page number: ${page}`);
    const pageRecords = await extractResultsPage(stagehand);
    allRecords.push(...pageRecords);

    if (page < maxPages) {
      const hasNext = await goToNextPage(stagehand);
      console.log(`[extract] Pagination continues: ${hasNext}`);
      if (!hasNext) break;
    } else {
      console.log("[extract] Pagination continues: false");
    }
  }

  console.log(`[extract] Total raw records extracted: ${allRecords.length}`);
  return allRecords;
}
