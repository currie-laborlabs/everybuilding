/**
 * extractDetail.ts
 *
 * Multi-contact Reonomy property detail extractor.
 *
 * For each property card in the search results:
 *   1. Click the card → opens a detail panel on the right
 *   2. Click "Owner" sub-tab inside the panel (NOT the top-level Owners tab)
 *   3. Extract the primary contact + all phones/emails visible on the Owner tab
 *   4. If a "View All N Contacts" link is present → click it → navigate to
 *      the full contacts table page
 *   5. For each row in the contacts table, click the expand arrow / info icons
 *      to open a side panel → extract ALL phones + emails for that person
 *   6. Aggregate every contact into reonomy_contacts_json (JSON array)
 *   7. Promote the best contact (Principal with email) to the primary
 *      reonomy_contact_* fields for downstream enrichment
 *   8. Navigate back to the search results list
 */
import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { config } from "../config";
import type { NormalizedLead, ReonomyContact } from "../types";
import { cleanText, sleep } from "../utils";

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * What's directly visible on the Owner sub-tab of a property detail panel.
 * (Reonomy images 2 & 3: shows primary contact, their phones/emails, and
 * optionally a "View All N Contacts" link.)
 */
const OWNER_TAB_SCHEMA = z.object({
  owner_entity: z.string().optional(),
  /**
   * When there is no company/LLC/trust entity name, Reonomy sometimes shows
   * only individual owner names (e.g. "John Smith", "Jane Doe"). Capture ALL
   * of them here as an array. Leave empty when owner_entity is present.
   */
  owner_names: z.array(z.string()).optional(),
  company_website: z.string().optional(),
  last_acquisition_date: z.string().optional(),
  primary_contact_name: z.string().optional(),
  primary_contact_title: z.string().optional(),
  /** ALL phone numbers shown anywhere in the panel */
  phones: z.array(z.string()).optional(),
  /** ALL email addresses shown anywhere in the panel */
  emails: z.array(z.string()).optional(),
  /**
   * The N in "View All N Contacts" button/link.
   * Return 0 if no such link is present.
   */
  view_all_contacts_count: z.number().optional(),
});

/** Basic info for each row of the contacts table page (image 4). */
const CONTACTS_TABLE_SCHEMA = z.object({
  contacts: z.array(
    z.object({
      name: z.string(),
      relationship: z.string().optional(),
      title: z.string().optional(),
    })
  ),
});

/** Phones + emails from a single contact's expanded side panel (image 5). */
const CONTACT_PANEL_SCHEMA = z.object({
  phones: z.array(z.string()).optional(),
  emails: z.array(z.string()).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeDomain(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
}

function mergeNotes(...notes: string[]): string {
  return notes.filter(Boolean).join("; ");
}

// ── Phase: Extract Owner tab data ─────────────────────────────────────────────

async function extractOwnerTabData(
  stagehand: Stagehand
): Promise<z.infer<typeof OWNER_TAB_SCHEMA>> {
  const page = stagehand.page;

  // Scroll the property detail content area to reveal all content.
  // Reonomy opens the detail as a full page (card click navigates away from
  // the search results) — the left-side panel IS the scrollable area.
  try {
    await page.evaluate((): void => {
      const DETAIL_SELECTORS = [
        // Full-page property detail selectors
        "[class*='property-detail']", "[class*='PropertyDetail']",
        "[class*='detail-view']", "[class*='DetailView']",
        "[class*='detail-content']", "[class*='DetailContent']",
        "[class*='property-page']", "[class*='PropertyPage']",
        // Left-panel / content-pane selectors (shared with card-list layout)
        "[class*='left-panel']", "[class*='LeftPanel']",
        "[class*='results-panel']", "[class*='ResultsPanel']",
        "[class*='sidebar']", "[class*='Sidebar']",
        // Fallback generic
        "main", "[role='main']",
      ];
      for (const sel of DETAIL_SELECTORS) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
          return;
        }
      }
      // Last resort: largest scrollable non-body element
      const bodyH = document.body.scrollHeight;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => {
        if (el.scrollHeight === bodyH) return false;
        const s = window.getComputedStyle(el);
        return (
          (s.overflow === "auto" || s.overflow === "scroll" ||
           s.overflowY === "auto" || s.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        );
      });
      candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
      for (const el of candidates.slice(0, 3)) {
        el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
      }
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    });
    await sleep(800);
  } catch { /* non-critical */ }

  return page.extract({
    instruction: `
You are on a Reonomy property detail page. The detail occupies the left side of
the screen. You are on the "Owner" tab (one of the tabs shown alongside
"Building & Lot", "Occupants", "Sales", "Debt", "Tax", "Demographics", "Notes").

The Owner tab shows:
- An "Owners" section with an entity name (company/LLC/trust/person name).
  The entity is often prefixed with a network icon. Below it may say
  "Via [another entity name]".
- A "View Contacts (N)" button near the top of the Owners section, where N is
  the number of people associated with this owner.
- Portfolio stats: Properties in Portfolio, Portfolio Assessed Value,
  Last Acquisition Date, Location.
- A "Reported Owner" section further down.

Extract:
- owner_entity: the primary owner entity name in the Owners section IF it is a
  company, LLC, trust, municipality, or organization name
  (e.g. "Ziman Trucking LLC", "Township Of Long Beach", "Baker Janice 2024 Trust").
  Leave EMPTY if the only thing shown is one or more individual person names with
  no company/entity designation.
- owner_names: ONLY populate this when owner_entity is empty. List ALL individual
  person names shown as owners in the Owners section (e.g. ["John Smith", "Jane Doe"]).
  These are the property owners themselves, not contacts from a "View Contacts" button.
  Leave as an empty array when owner_entity is present.
- primary_contact_name: IF a specific person's name is shown DIRECTLY on this
  tab (without requiring any button click), extract it. Otherwise leave empty.
- primary_contact_title: that person's title if shown alongside the name.
- phones: any phone numbers directly visible on this tab (WITHOUT clicking any button).
- emails: any email addresses directly visible on this tab (WITHOUT clicking any button).
- company_website: company website URL if shown.
- last_acquisition_date: the Last Acquisition Date value (e.g. "Nov 2025", "Jan 2026").
- view_all_contacts_count: the number N from the "View Contacts (N)" button.
  Return 0 if no such button is visible.

Return empty strings / empty arrays / 0 for anything not visible. Do NOT invent values.
    `.trim(),
    schema: OWNER_TAB_SCHEMA,
  });
}

// ── Phase: Extract contacts table rows ────────────────────────────────────────

async function extractContactTableRows(
  stagehand: Stagehand
): Promise<z.infer<typeof CONTACTS_TABLE_SCHEMA>["contacts"]> {
  const page = stagehand.page;

  const result = await page.extract({
    instruction: `
You are on a Reonomy contacts page showing a table of all contacts associated
with an owner entity. The table has columns: Name, Relationship, Role/Title,
Related Company, Contact Info.

Extract EVERY row:
- name: full person name (e.g. "Michael S Ziman", "Gary Ziman", "Linda A Ritzel")
- relationship: "Principal", "Contact", etc.
- title: the role/title shown (e.g. "Vice President", "Chief Executive Officer",
  "Secretary", "Development"). If multiple titles are listed, use the first one.

Do NOT skip any row. Return all rows visible on the page.
    `.trim(),
    schema: CONTACTS_TABLE_SCHEMA,
  });

  return result.contacts ?? [];
}

// ── Phase: Extract one contact's phones + emails from their side panel ────────

async function extractContactPanelData(
  stagehand: Stagehand,
  contactName: string,
  rowIndex: number
): Promise<{ phones: string[]; emails: string[] }> {
  const page = stagehand.page;

  try {
    // Click the expand arrow (">") on the left OR the contact info icons on
    // the right of that contact's row to open their side panel.
    await page.act({
      action: `
In the contacts table, find the row for "${contactName}" (it is approximately
row number ${rowIndex + 1} in the table). Click the expand arrow ">" chevron on
the LEFT side of that row to expand it, OR click one of the contact info icons
(phone icon, email icon, or data icon) on the RIGHT side of that row.
Either action should open a panel showing their phone numbers and emails.
      `.trim(),
    });
    await sleep(config.run.actionDelay);

    // Extract all phones + emails from the now-open side panel
    const panel = await page.extract({
      instruction: `
A side panel or expanded row is now showing contact details for "${contactName}".

Extract:
- phones: ALL phone numbers listed in the panel (just the number strings,
  e.g. ["1-978-660-9622", "978-365-2794", "410-265-5855", "1-415-515-4007"]).
  Include every phone number, regardless of the label next to it.
- emails: ALL email addresses listed in the panel (lowercase,
  e.g. ["mike@globalci.com", "zimanm@hotmail.com", "hziman@globalci.com",
  "zimanm@stancounty.com", "mziman@biolog.com"]).
  Include every email address visible.

Return empty arrays if none are shown. Do NOT invent values.
      `.trim(),
      schema: CONTACT_PANEL_SCHEMA,
    });

    // Dismiss the side panel before moving to the next contact
    try {
      await page.act({
        action:
          "Close the side panel or contact detail drawer that just opened " +
          "(click the X button, press Escape, or click outside the panel).",
      });
      await sleep(600);
    } catch { /* non-critical */ }

    return {
      phones: (panel.phones ?? []).map(cleanText).filter(Boolean),
      emails: (panel.emails ?? []).map((e) => cleanText(e).toLowerCase()).filter(Boolean),
    };
  } catch (err) {
    console.warn(
      `[detail] Could not extract panel for "${contactName}": ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
    return { phones: [], emails: [] };
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function returnToResults(stagehand: Stagehand, resultsUrl: string): Promise<void> {
  const page = stagehand.page;

  // Fast path: already exactly on the results page
  if (page.url() === resultsUrl) return;

  // 1. Try the "← Property List" back-link that Reonomy shows on detail pages
  try {
    await page.act({
      action:
        'Click the "← Property List" link or "Back to results" link ' +
        "at the top of the page to return to the property search results.",
    });
    await sleep(config.run.actionDelay);
    if (page.url() === resultsUrl) return;
  } catch { /* link not found */ }

  // 2. goBack() up to 2 times (contacts page → detail page → results page)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: config.run.pageLoadTimeout });
      await sleep(config.run.actionDelay);
      if (page.url() === resultsUrl) return;
    } catch { break; }
  }

  // 3. Hard fallback: navigate directly to the captured results URL
  try {
    console.log("[detail] returnToResults: using goto fallback.");
    await page.goto(resultsUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.run.pageLoadTimeout,
    });
    await sleep(config.run.actionDelay);
  } catch (err) {
    console.warn(
      `[detail] returnToResults goto fallback failed: ` +
      `${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ── Core per-lead orchestration ───────────────────────────────────────────────

/**
 * Click one property card, extract all owner contacts from its Owner sub-tab
 * (including "View All Contacts"), then return to the results list.
 *
 * @param stagehand  Active Stagehand session on the search results page.
 * @param lead       Lead whose card we're clicking.
 * @param resultsUrl URL of the current results page — used to navigate back.
 */
export async function enrichLeadWithReonomyDetail(
  stagehand: Stagehand,
  lead: NormalizedLead,
  resultsUrl: string
): Promise<NormalizedLead> {
  const page = stagehand.page;

  try {
    // ── Step 1: Scroll results list so the target card is in view ─────────
    try {
      await page.evaluate((streetAddr: string) => {
        const firstLine = streetAddr.split(",")[0].trim();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (node.textContent?.trim() === firstLine) {
            node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
            break;
          }
        }
      }, lead.property_address);
      await sleep(800);
    } catch { /* non-critical */ }

    // ── Step 2: Navigate to property detail page ────────────────────────────
    // Strategy 1: extract the card's href directly from the DOM (fast + reliable)
    // Strategy 2: fall back to AI-based click if DOM extraction fails
    const beforeUrl = page.url();
    let navigatedViaGoto = false;

    try {
      const cardUrl = await page.evaluate((streetAddr: string): string | null => {
        const firstLine = streetAddr.split(",")[0].trim().toLowerCase();
        const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
        for (const link of allLinks) {
          const text = (link.textContent ?? "").toLowerCase();
          if (
            text.includes(firstLine) &&
            link.href &&
            !link.href.startsWith("javascript")
          ) {
            return link.href;
          }
        }
        return null;
      }, lead.property_address);

      if (cardUrl && cardUrl !== beforeUrl) {
        console.log(`[detail] DOM card URL found: ${cardUrl}`);
        await page.goto(cardUrl, {
          waitUntil: "domcontentloaded",
          timeout: config.run.pageLoadTimeout,
        });
        await sleep(config.run.actionDelay);
        navigatedViaGoto = true;
      }
    } catch { /* non-critical — fall through to act() */ }

    if (!navigatedViaGoto) {
      await page.act({
        action:
          `In the property list on the left side of the page, find the card ` +
          `for "${lead.property_address}" and click it to open the property detail.`,
      });
      await sleep(config.run.actionDelay * 2);
    }

    // Confirm detail page loaded
    if (page.url() === beforeUrl) {
      console.warn(`[detail] Detail did not open for "${lead.property_address}" — retrying.`);
      await page.act({
        action: `Click the property card for "${lead.property_address}" to view its details.`,
      });
      await sleep(config.run.actionDelay * 2);
    }

    // ── Step 3: Click the Owner tab ───────────────────────────────────────
    // The property detail has tabs: Building & Lot | Owner | Occupants |
    // Sales | Debt | Tax | Demographics | Notes.
    // Click "Owner" to see the owner entity and "View Contacts (N)" button.
    await page.act({
      action:
        `On the property detail page, find the tab row that includes ` +
        `"Building & Lot", "Owner", "Occupants", "Sales". ` +
        `Click the "Owner" tab.`,
    });
    await sleep(config.run.actionDelay);

    // ── Step 4: Extract owner tab data (primary contact + phones/emails) ──
    const ownerTabData = await extractOwnerTabData(stagehand);
    const viewAllCount = ownerTabData.view_all_contacts_count ?? 0;

    console.log(
      `[detail] "${lead.property_address}": entity="${ownerTabData.owner_entity}", ` +
      `primary="${ownerTabData.primary_contact_name}", ` +
      `phones=${ownerTabData.phones?.length ?? 0}, emails=${ownerTabData.emails?.length ?? 0}, ` +
      `viewAll=${viewAllCount}`
    );

    // Resolve owner entity name — fall back to address if none found
    const resolvedOwnerEntity =
      cleanText(ownerTabData.owner_entity) ||
      lead.owner_entity ||
      lead.property_address;

    // Build initial contacts from what's directly visible on the Owner tab.
    // Case A: owner_names[] present (individual owners, no company entity)
    //   → each name becomes its own contact entry
    // Case B: primary_contact_name present (single contact shown on tab)
    //   → one contact entry
    const ownerNames = (ownerTabData.owner_names ?? []).map(cleanText).filter(Boolean);
    const allContacts: ReonomyContact[] = [];

    if (ownerNames.length > 0) {
      // Phones/emails from the tab are shared — distribute to the first owner
      // (we can't know which phone belongs to which person without clicking through)
      const sharedPhones = (ownerTabData.phones ?? []).map(cleanText).filter(Boolean);
      const sharedEmails = (ownerTabData.emails ?? [])
        .map((e) => cleanText(e).toLowerCase())
        .filter(Boolean);
      ownerNames.forEach((name, idx) => {
        allContacts.push({
          name,
          title: "",
          relationship: "Owner",
          phones: idx === 0 ? sharedPhones : [],
          emails: idx === 0 ? sharedEmails : [],
        });
      });
    } else {
      const primaryContact: ReonomyContact = {
        name: cleanText(ownerTabData.primary_contact_name),
        title: cleanText(ownerTabData.primary_contact_title),
        relationship: "Principal",
        phones: (ownerTabData.phones ?? []).map(cleanText).filter(Boolean),
        emails: (ownerTabData.emails ?? [])
          .map((e) => cleanText(e).toLowerCase())
          .filter(Boolean),
      };
      if (primaryContact.name) allContacts.push(primaryContact);
    }

    // ── Step 5: Click "View Contacts (N)" and extract all contacts ───────────
    // The Owner tab shows a "View Contacts (N)" button. Clicking it navigates
    // to the full contacts list page. We extract every person there.
    // Note: viewAllCount may be 0 if extraction missed the button — check DOM too.
    let hasViewContactsBtn = viewAllCount > 0;
    if (!hasViewContactsBtn) {
      try {
        const btnText = await page.evaluate((): string => {
          const buttons = Array.from(document.querySelectorAll("button, a"));
          for (const btn of buttons) {
            const t = (btn.textContent ?? "").trim();
            if (/view contacts/i.test(t) || /view all.*contacts/i.test(t)) return t;
          }
          return "";
        });
        if (btnText) {
          console.log(`[detail] Found "${btnText}" button via DOM scan — will click.`);
          hasViewContactsBtn = true;
        }
      } catch { /* non-critical */ }
    }

    if (hasViewContactsBtn) {
      console.log(`[detail] Clicking "View Contacts (${viewAllCount})"...`);

      try {
        await page.act({
          action:
            `Find and click the "View Contacts (${viewAllCount})" button ` +
            `(or "View All ${viewAllCount} Contacts" link) to open the full ` +
            `contacts list for this owner.`,
        });
        await sleep(config.run.actionDelay * 2);

        // Extract all rows from the contacts table
        const tableRows = await extractContactTableRows(stagehand);
        console.log(`[detail] Contacts table: ${tableRows.length} row(s).`);

        // For each row, click their info to get all phones + emails
        for (let i = 0; i < tableRows.length; i++) {
          const row = tableRows[i];
          if (!row.name) continue;

          console.log(
            `[detail] Contact ${i + 1}/${tableRows.length}: "${row.name}" ` +
            `(${row.relationship ?? "—"}, ${row.title ?? "—"})`
          );

          const panelData = await extractContactPanelData(stagehand, row.name, i);

          // Merge into existing entry or add as new
          const existing = allContacts.find(
            (c) => c.name.toLowerCase() === row.name.toLowerCase()
          );
          if (existing) {
            existing.phones = [...new Set([...existing.phones, ...panelData.phones])];
            existing.emails = [...new Set([...existing.emails, ...panelData.emails])];
            existing.title = existing.title || cleanText(row.title ?? "");
            existing.relationship = cleanText(row.relationship ?? "") || existing.relationship;
          } else {
            allContacts.push({
              name: row.name,
              title: cleanText(row.title ?? ""),
              relationship: cleanText(row.relationship ?? ""),
              phones: panelData.phones,
              emails: panelData.emails,
            });
          }
        }

        await returnToResults(stagehand, resultsUrl);
      } catch (viewAllErr) {
        console.warn(
          `[detail] "View Contacts" flow failed: ` +
          `${viewAllErr instanceof Error ? viewAllErr.message : String(viewAllErr)} ` +
          `— falling back to primary contact only.`
        );
        await returnToResults(stagehand, resultsUrl);
      }
    } else {
      await returnToResults(stagehand, resultsUrl);
    }

    // ── Step 6: Store ALL contacts; first contact goes to reference fields ────
    const first = allContacts[0];

    const companyDomain = normalizeDomain(ownerTabData.company_website ?? "");
    const lastAcqDate = cleanText(ownerTabData.last_acquisition_date);
    const withEmail = allContacts.filter((c) => c.emails.length > 0).length;

    return {
      ...lead,
      reonomy_owner_name: resolvedOwnerEntity,
      reonomy_owner_phone: first?.phones[0] ?? "",
      reonomy_owner_email: first?.emails[0] ?? "",
      reonomy_contact_name: first?.name ?? "",
      reonomy_contact_title: first?.title ?? "",
      reonomy_contact_phone: first?.phones[0] ?? "",
      reonomy_contact_email: first?.emails[0] ?? "",
      reonomy_company_domain: companyDomain,
      reonomy_last_acquisition_date: lastAcqDate,
      reonomy_contacts_json: JSON.stringify(allContacts),
      reonomy_detail_status: allContacts.length > 0 ? "success" : "partial",
      reonomy_detail_notes:
        `contacts:${allContacts.length} with_email:${withEmail}` +
        (viewAllCount > 1 ? ` view_all:${viewAllCount}` : ""),
    };
  } catch (error) {
    await returnToResults(stagehand, resultsUrl);
    return {
      ...lead,
      reonomy_contacts_json: "[]",
      reonomy_detail_status: "failed",
      reonomy_detail_notes: mergeNotes(
        lead.reonomy_detail_notes,
        error instanceof Error ? error.message : "detail extraction failed"
      ),
    };
  }
}

/**
 * Click every property card in the list, extract owner + all contacts from
 * Reonomy's Owner tab and "View All Contacts" page, and return enriched leads.
 */
export async function enrichLeadsWithReonomyDetails(
  stagehand: Stagehand,
  leads: NormalizedLead[]
): Promise<NormalizedLead[]> {
  const resultsUrl = stagehand.page.url();
  const enriched: NormalizedLead[] = [];

  for (const lead of leads) {
    const next = await enrichLeadWithReonomyDetail(stagehand, lead, resultsUrl);
    enriched.push(next);
  }

  return enriched;
}