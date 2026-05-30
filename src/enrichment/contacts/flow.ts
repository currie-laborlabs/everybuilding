import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
import { ApolloClient } from "./apollo";
import { HunterClient } from "./hunter";
import { PdlClient } from "./pdl";
import { BatchDataSkipTraceClient } from "./batchdata";
import { mergeContactCandidates } from "./merge";

export interface ContactEnrichmentClients {
  apolloClient: ApolloClient;
  hunterClient: HunterClient;
  pdlClient: PdlClient;
  batchdataSkipTraceClient: BatchDataSkipTraceClient;
}

export interface ContactEnrichmentFlowResult {
  effectiveLead: EnrichedPropertyLead;
  candidates: ContactCandidate[];
  expansionDomains: string[];
  batchdataBusinessDomain: string;
}

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
  "icloud.com",
  "live.com",
  "msn.com",
  "me.com",
  "proton.me",
  "protonmail.com",
]);

function extractEmailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  return at >= 0 ? trimmed.slice(at + 1) : "";
}

function findBusinessEmailDomain(candidates: ContactCandidate[]): string {
  for (const candidate of candidates) {
    const domain = extractEmailDomain(candidate.contact_email);
    if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) return domain;
  }
  return "";
}

function collectExpansionDomains(
  candidates: ContactCandidate[],
  searchedDomain: string
): string[] {
  const domains = new Set<string>();
  for (const candidate of candidates) {
    const domain = extractEmailDomain(candidate.contact_email);
    if (!domain) continue;
    if (domain === searchedDomain) continue;
    if (GENERIC_EMAIL_DOMAINS.has(domain)) continue;
    domains.add(domain);
  }
  return [...domains].sort();
}

export async function enrichContactsForLead(
  lead: EnrichedPropertyLead,
  reonomyCandidates: ContactCandidate[],
  clients: ContactEnrichmentClients,
  log?: (message: string) => void
): Promise<ContactEnrichmentFlowResult> {
  let effectiveLead = lead;

  const batchdataCandidates = await clients.batchdataSkipTraceClient.findContacts(effectiveLead);
  const batchdataBusinessDomain = findBusinessEmailDomain(batchdataCandidates);
  if (!effectiveLead.reonomy_company_domain?.trim() && batchdataBusinessDomain) {
    effectiveLead = {
      ...effectiveLead,
      reonomy_company_domain: batchdataBusinessDomain,
    };
    log?.(`Domain from BatchData: ${batchdataBusinessDomain}`);
  }

  const skipApollo = process.env.SKIP_APOLLO === "true";
  const [apolloCandidates, hunterCandidates, pdlCandidates] = await Promise.all([
    skipApollo ? Promise.resolve([]) : clients.apolloClient.findContacts(effectiveLead),
    clients.hunterClient.findContacts(effectiveLead),
    clients.pdlClient.findContacts(effectiveLead),
  ]);

  const searchedDomain = effectiveLead.reonomy_company_domain.trim().toLowerCase();
  const effectiveReonomyCandidates = reonomyCandidates.map((candidate) => ({
    ...candidate,
    owner_entity: effectiveLead.owner_entity || candidate.owner_entity,
  }));

  const allCandidates = [
    ...effectiveReonomyCandidates,
    ...apolloCandidates,
    ...hunterCandidates,
    ...pdlCandidates,
    ...batchdataCandidates,
  ];

  const expansionDomains = collectExpansionDomains(allCandidates, searchedDomain);
  if (expansionDomains.length > 0) {
    log?.(`domain expand: ${expansionDomains.join(", ")}`);
    const expansionResults = await Promise.all(
      expansionDomains.map((domain) =>
        Promise.all([
          skipApollo ? Promise.resolve([]) : clients.apolloClient.findContactsByDomain(effectiveLead, domain),
          clients.hunterClient.findContactsByDomain(effectiveLead, domain),
          clients.pdlClient.findContactsByDomain(effectiveLead, domain),
        ]).then(([apollo, hunter, pdl]) => [...apollo, ...hunter, ...pdl])
      )
    );
    allCandidates.push(...expansionResults.flat());
  }

  return {
    effectiveLead,
    candidates: mergeContactCandidates(allCandidates),
    expansionDomains,
    batchdataBusinessDomain,
  };
}
