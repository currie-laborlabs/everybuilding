import type { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import { config } from "../config";
import type { NormalizedLead } from "../types";
import { cleanText, sleep } from "../utils";

const DETAIL_SCHEMA = z.object({
  owner_name: z.string().optional(),
  owner_phone: z.string().optional(),
  owner_email: z.string().optional(),
  contact_name: z.string().optional(),
  contact_title: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().optional(),
  company_domain: z.string().optional(),
  last_acquisition_date: z.string().optional(),
});

const OWNER_EXTRACTION_INSTRUCTION = `
You are on the Owner tab of a Reonomy property detail panel.

The panel typically shows TWO things:
1. An INDIVIDUAL person's name (e.g. "Nicholas E Werner") — a real human name, not an LLC or company.
2. A REPORTED OWNER entity name (e.g. "W29 Owner Llc") — a company or LLC name.

Extract:
- contact_name: the INDIVIDUAL person's full name if one is shown (a real human, not a company/LLC)
- contact_title: their title if shown (e.g. "Owner", "Manager")
- contact_phone: any direct phone number shown for the individual
- contact_email: any email shown for the individual
- owner_name: the reported owner entity name (LLC, Corp, Trust, etc.)
- owner_phone: any phone shown for the entity
- owner_email: any email shown for the entity
- company_domain: company website or email domain if visible
- last_acquisition_date: the property acquisition or sale date shown (e.g. "01/15/2019", "January 2019")

Return empty string for any field not visible. Do NOT invent values.
`.trim();

const OWNER_SCHEMA = z.object({
  contact_name: z.string().optional(),
  contact_title: z.string().optional(),
  contact_phone: z.string().optional(),
  contact_email: z.string().optional(),
  owner_name: z.string().optional(),
  owner_phone: z.string().optional(),
  owner_email: z.string().optional(),
  company_domain: z.string().optional(),
  last_acquisition_date: z.string().optional(),
});

function normalizeDomain(value: string): string {
  const cleaned = cleanText(value)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
  return cleaned;
}

function mergeNotes(...notes: string[]): string {
  return notes.filter(Boolean).join("; ");
}

function applyDetailPayload(
  lead: NormalizedLead,
  payload: z.infer<typeof DETAIL_SCHEMA>
): NormalizedLead {
  const ownerName = cleanText(payload.owner_name);
  const ownerPhone = cleanText(payload.owner_phone);
  const ownerEmail = cleanText(payload.owner_email).toLowerCase();
  const contactName = cleanText(payload.contact_name);
  const contactTitle = cleanText(payload.contact_title);
  const contactPhone = cleanText(payload.contact_phone);
  const contactEmail = cleanText(payload.contact_email).toLowerCase();
  const companyDomain = normalizeDomain(payload.company_domain ?? "");
  const lastAcquisitionDate = cleanText(payload.last_acquisition_date);

  const populatedCount = [
    ownerName,
    ownerPhone,
    ownerEmail,
    contactName,
    contactTitle,
    contactPhone,
    contactEmail,
    companyDomain,
    lastAcquisitionDate,
  ].filter(Boolean).length;

  return {
    ...lead,
    reonomy_owner_name: ownerName,
    reonomy_owner_phone: ownerPhone,
    reonomy_owner_email: ownerEmail,
    reonomy_contact_name: contactName,
    reonomy_contact_title: contactTitle,
    reonomy_contact_phone: contactPhone,
    reonomy_contact_email: contactEmail,
    reonomy_company_domain: companyDomain,
    reonomy_last_acquisition_date: lastAcquisitionDate,
    reonomy_detail_status: populatedCount > 0 ? "success" : "partial",
    reonomy_detail_notes:
      populatedCount > 0
        ? `detail fields populated: ${populatedCount}`
        : "detail view opened but no contact fields were visibly extractable",
  };
}

async function returnToResults(stagehand: Stagehand, resultsUrl: string): Promise<void> {
  const page = stagehand.page;

  try {
    await page.act({
      action:
        'If a property detail side panel or modal is open, close it to return to the search results. If there is a Back button in the app, click it.',
    });
    await sleep(config.run.actionDelay);
  } catch {
    // Ignore and fall back to browser navigation below.
  }

  if (!page.url().includes("/search") && page.url() !== resultsUrl) {
    try {
      await page.goBack({
        waitUntil: "domcontentloaded",
        timeout: config.run.pageLoadTimeout,
      });
      await sleep(config.run.actionDelay);
    } catch {
      await page.goto(resultsUrl, {
        waitUntil: "domcontentloaded",
        timeout: config.run.pageLoadTimeout,
      });
      await sleep(config.run.actionDelay);
    }
  }
}

async function enrichLeadWithReonomyDetail(
  stagehand: Stagehand,
  lead: NormalizedLead,
  resultsUrl: string
): Promise<NormalizedLead> {
  const page = stagehand.page;

  try {
    await page.act({
      action: `From the current Reonomy results page, open the property detail view for the listing with address "${lead.property_address}" in ${lead.city}, ${lead.state} ${lead.zip_code}. Click the matching property card or row.` ,
    });
    await sleep(config.run.actionDelay);

    // Click the Owner tab to get owner name/phone/email
    await page.act({ action: 'Click the "Owner" tab in the property detail panel.' });
    await sleep(config.run.actionDelay);

    // Scroll the detail panel down and wait until content stabilizes
    try {
      let previousHeight = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        const currentHeight = await page.evaluate((): number => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>("*")
          ).filter((el) => {
            const style = window.getComputedStyle(el);
            return (
              (style.overflow === "auto" || style.overflow === "scroll" ||
               style.overflowY === "auto" || style.overflowY === "scroll") &&
              el.scrollHeight > el.clientHeight
            );
          });
          let maxHeight = 0;
          for (const el of candidates) {
            el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
            if (el.scrollHeight > maxHeight) maxHeight = el.scrollHeight;
          }
          return maxHeight;
        });
        await sleep(1000);
        // Stop early once height stops growing (content fully loaded)
        if (currentHeight === previousHeight && attempt > 0) break;
        previousHeight = currentHeight;
      }
    } catch {
      // Scroll failure is non-critical
      await sleep(config.run.actionDelay);
    }

    const ownerData = await page.extract({
      instruction: OWNER_EXTRACTION_INSTRUCTION,
      schema: OWNER_SCHEMA,
    });

    const merged: z.infer<typeof DETAIL_SCHEMA> = {
      owner_name: ownerData.owner_name,
      owner_phone: ownerData.owner_phone,
      owner_email: ownerData.owner_email,
      company_domain: ownerData.company_domain,
      contact_name: ownerData.contact_name,
      contact_title: ownerData.contact_title,
      contact_phone: ownerData.contact_phone,
      contact_email: ownerData.contact_email,
      last_acquisition_date: ownerData.last_acquisition_date,
    };

    const enriched = applyDetailPayload(lead, merged);
    await returnToResults(stagehand, resultsUrl);
    return enriched;
  } catch (error) {
    await returnToResults(stagehand, resultsUrl);
    return {
      ...lead,
      reonomy_detail_status: "failed",
      reonomy_detail_notes: mergeNotes(
        lead.reonomy_detail_notes,
        error instanceof Error ? error.message : "detail extraction failed"
      ),
    };
  }
}

/**
 * Reonomy detail-page scaffold.
 *
 * The current scraper only extracts property rows from the results page.
 * This hook exists so we can later click into each selected property and pull
 * owner/contact details directly from Reonomy detail views without reshaping
 * the rest of the pipeline.
 */
export async function enrichLeadsWithReonomyDetails(
  stagehand: Stagehand,
  leads: NormalizedLead[]
): Promise<NormalizedLead[]> {
  const resultsUrl = stagehand.page.url();
  const enriched: NormalizedLead[] = [];

  for (const lead of leads) {
    const nextLead = await enrichLeadWithReonomyDetail(stagehand, lead, resultsUrl);
    enriched.push(nextLead);
  }

  return enriched;
}