/**
 * src/reonomy/extractOwners.ts
 *
 * Bulk owner extraction using Reonomy's top-level "Owners" tab.
 *
 * Strategy:
 *   Instead of clicking every individual property card (fragile and slow),
 *   switch to the Owners tab which shows ALL owners for the current search
 *   in a paginated table. One table row = one owner entity with its primary
 *   contact person, property count, and acquisition date.
 *
 * This is the preferred approach for high-volume ZIP code batches.
 * Use REONOMY_USE_OWNERS_TAB=true in .env to enable it.
 *
 * Output: an array of OwnerRecord — one per owner entity. The calling code
 * in index.ts correlates these back to NormalizedLeads by owner_entity name.
 */

import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { config } from "../config";
import { sleep } from "../utils";

// ── Schema ────────────────────────────────────────────────────────────────────

const OWNER_ROW_SCHEMA = z.object({
  owners: z.array(
    z.object({
      /** The owner entity name — LLC, Corp, individual, municipality, etc. */
      owner_entity: z.string().optional(),
      /**
       * Primary contact person shown under the owner entity in the table.
       * Reonomy shows one person + title, e.g. "Joni Bakum (Parks And Rec Director)".
       * The "+N" suffix (e.g. "+54") indicates additional contacts — captured in
       * additional_contacts_count.
       */
      contact_name: z.string().optional(),
      contact_title: z.string().optional(),
      /** Number of additional contacts beyond the primary one shown in the table. */
      additional_contacts_count: z.number().optional(),
      properties_in_search: z.number().optional(),
      last_acquisition_date: z.string().optional(),
    })
  ),
});

export type OwnerRecord = z.infer<typeof OWNER_ROW_SCHEMA>["owners"][number];

// ── Extraction instruction ────────────────────────────────────────────────────

const EXTRACT_INSTRUCTION = `
You are looking at the Owners tab of Reonomy's search results page.
The page shows a table of property owners, one per row.

For each row, extract:
- owner_entity: the owner's full name or company name (e.g. "Township Of Long Beach", "Mark Davies", "Ziman Development Inc")
- contact_name: the first contact person's name shown beneath or beside the owner entity (e.g. "Joni Bakum", "Richard Crane")
- contact_title: that person's title if shown in parentheses (e.g. "Parks And Rec Director", "Borough Manager")
- additional_contacts_count: the number after the "+" sign if one is shown (e.g. "+54" means 54, "+18" means 18). Use 0 if no "+" is shown.
- properties_in_search: the number in the "Properties In Search" column
- last_acquisition_date: the date shown in the "Last Acquisition Date" column (e.g. "Mar 2026", "Nov 2020")

Extract ALL rows visible on the page. Do NOT skip any row.
`.trim();

// ── Page navigation helpers ───────────────────────────────────────────────────

/**
 * Switch to the top-level Owners tab in the search results.
 * This is the tab row containing "Properties | Owners" near the top,
 * NOT the Owner sub-tab inside a property detail panel.
 */
export async function switchToOwnersTab(stagehand: Stagehand): Promise<void> {
  const page = stagehand.page;
  console.log("[owners] Switching to Owners tab...");

  await page.act({
    action:
      'At the top of the search results area, find the tab bar that contains both a "Properties" tab and an "Owners" tab. Click the "Owners" tab to switch to the owners list view.',
  });
  await sleep(config.run.actionDelay);

  // Confirm the switch worked
  const confirmed = await page
    .observe({
      instruction:
        'Is there now a table visible that has columns like "Owner", "Properties In Search", "Properties In Portfolio", or "Last Acquisition Date"?',
    })
    .then((r) => r.length > 0)
    .catch(() => false);

  if (!confirmed) {
    console.warn("[owners] Owners tab may not have loaded — continuing anyway.");
  } else {
    console.log("[owners] Owners tab loaded.");
  }
}

/**
 * Extract all owner rows from the currently-visible page of the Owners tab.
 */
async function extractOwnersPage(stagehand: Stagehand): Promise<OwnerRecord[]> {
  const page = stagehand.page;

  // Scroll to the bottom of the table to ensure all rows are rendered
  try {
    await page.evaluate(() => {
      const TABLE_SELECTORS = [
        "table",
        "[class*='table']",
        "[class*='Table']",
        "[class*='list']",
        "[class*='List']",
        "[role='grid']",
        "[role='table']",
      ];
      for (const sel of TABLE_SELECTORS) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
          return;
        }
      }
      // Fallback: scroll the window
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    });
    await sleep(800);
  } catch {
    // Non-critical
  }

  const result = await page.extract({
    instruction: EXTRACT_INSTRUCTION,
    schema: OWNER_ROW_SCHEMA,
  });

  return result.owners ?? [];
}

/**
 * Try to navigate to the next page of the Owners table.
 * Returns false when there is no next page.
 */
async function goToNextOwnersPage(stagehand: Stagehand): Promise<boolean> {
  const page = stagehand.page;
  console.log("[owners] Advancing to next owners page...");

  try {
    await page.act({
      action:
        'Find the pagination controls at the bottom of the owners table. Click the next page arrow, the "Next" button, or the next page number to go to the next page.',
    });
    await sleep(config.run.actionDelay);
    return true;
  } catch {
    console.log("[owners] No next owners page found — reached the end.");
    return false;
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Extract all owner records from the Owners tab, paginating through all pages.
 *
 * @param stagehand   Active Stagehand session already on the search results page.
 * @param maxPages    Max pages to scrape (0 = unlimited).
 * @returns           Flat array of OwnerRecord — one per owner entity.
 */
export async function extractAllOwners(
  stagehand: Stagehand,
  maxPages = 0
): Promise<OwnerRecord[]> {
  await switchToOwnersTab(stagehand);

  const allOwners: OwnerRecord[] = [];
  let pageNum = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(`[owners] --- Owners page ${pageNum} ---`);
    const pageOwners = await extractOwnersPage(stagehand);
    console.log(`[owners] Extracted ${pageOwners.length} owner(s) from page ${pageNum}.`);
    allOwners.push(...pageOwners);

    const reachedMax = maxPages > 0 && pageNum >= maxPages;
    if (reachedMax) {
      console.log(`[owners] Reached maxPages (${maxPages}). Stopping.`);
      break;
    }

    const hasNext = await goToNextOwnersPage(stagehand);
    if (!hasNext) break;
    pageNum++;
  }

  console.log(`[owners] Total owners extracted: ${allOwners.length}`);
  return allOwners;
}

/**
 * Merge owner-tab data back into normalized leads.
 *
 * Matches on owner_entity (case-insensitive). When a lead's owner_entity
 * matches an OwnerRecord, the contact name/title from the Owners tab
 * is written into the lead's reonomy_contact_* fields.
 *
 * Leads with no match are returned unchanged.
 */
export function mergeOwnerRecordsIntoLeads(
  leads: import("../types").NormalizedLead[],
  ownerRecords: OwnerRecord[]
): import("../types").NormalizedLead[] {
  // Build a lookup: normalised owner_entity → OwnerRecord
  const ownerMap = new Map<string, OwnerRecord>();
  for (const rec of ownerRecords) {
    const key = (rec.owner_entity ?? "").trim().toLowerCase();
    if (key) ownerMap.set(key, rec);
  }

  return leads.map((lead) => {
    const key = (lead.owner_entity ?? "").trim().toLowerCase();
    const match = ownerMap.get(key);
    if (!match) return lead;

    return {
      ...lead,
      reonomy_contact_name: match.contact_name ?? lead.reonomy_contact_name,
      reonomy_contact_title: match.contact_title ?? lead.reonomy_contact_title,
      reonomy_detail_status: "success" as const,
      reonomy_detail_notes: `owners-tab: ${match.properties_in_search ?? "?"} props in search${match.additional_contacts_count ? `; +${match.additional_contacts_count} more contacts` : ""}`,
    };
  });
}
