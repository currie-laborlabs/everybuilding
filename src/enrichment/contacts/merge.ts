import type { ContactCandidate, ContactProviderSource, ContactSource } from "../../types";

function titleScore(title: string): number {
  const normalized = title.toLowerCase();
  if (normalized.includes("vp") || normalized.includes("director") || normalized.includes("chief")) {
    return 3;
  }
  if (normalized.includes("manager") || normalized.includes("head")) {
    return 2;
  }
  return 1;
}

function nameKey(contact: ContactCandidate): string {
  return `${contact.contact_name.trim().toLowerCase()}|${contact.owner_entity.trim().toLowerCase()}`;
}

function providerSources(contact: ContactCandidate): ContactProviderSource[] {
  const sources = contact.contact_sources?.length
    ? contact.contact_sources
    : contact.contact_source === "hybrid"
      ? []
      : [contact.contact_source];
  return [...new Set(sources)].sort();
}

function joinSources(
  existing: ContactCandidate,
  incoming: ContactCandidate
): ContactProviderSource[] {
  return [...new Set([...providerSources(existing), ...providerSources(incoming)])].sort();
}

function displaySource(sources: ContactProviderSource[], fallback: ContactSource): ContactSource {
  if (sources.length === 0) return fallback;
  return sources.length === 1 ? sources[0] : "hybrid";
}

function valueSource(
  contact: ContactCandidate,
  field: "contact_email" | "contact_phone"
): ContactSource {
  if (field === "contact_email" && contact.email_source) return contact.email_source;
  if (field === "contact_phone" && contact.phone_source) return contact.phone_source;
  return contact.contact_source;
}

function mergeNotes(existing: ContactCandidate, incoming: ContactCandidate): string {
  return [...new Set([
    existing.contact_enrichment_notes,
    incoming.contact_enrichment_notes,
  ].filter(Boolean) as string[])].join("; ");
}

function mergePair(existing: ContactCandidate, incoming: ContactCandidate): ContactCandidate {
  const contact_sources = joinSources(existing, incoming);
  const contact_source = displaySource(contact_sources, existing.contact_source);
  const contact_email = existing.contact_email || incoming.contact_email;
  const contact_phone = existing.contact_phone || incoming.contact_phone;
  return {
    ...existing,
    contact_name: existing.contact_name || incoming.contact_name,
    contact_title: existing.contact_title || incoming.contact_title,
    contact_phone,
    contact_email,
    email_source: existing.contact_email
      ? valueSource(existing, "contact_email")
      : incoming.contact_email
        ? valueSource(incoming, "contact_email")
        : existing.email_source ?? incoming.email_source,
    phone_source: existing.contact_phone
      ? valueSource(existing, "contact_phone")
      : incoming.contact_phone
        ? valueSource(incoming, "contact_phone")
        : existing.phone_source ?? incoming.phone_source,
    contact_linkedin: existing.contact_linkedin || incoming.contact_linkedin,
    confidence: Math.max(existing.confidence, incoming.confidence),
    contact_source,
    contact_sources,
    contact_enrichment_notes: mergeNotes(existing, incoming),
  };
}

function normalizeCandidate(candidate: ContactCandidate): ContactCandidate {
  const contact_sources = providerSources(candidate);
  return {
    ...candidate,
    contact_sources,
    email_source:
      candidate.email_source ??
      (candidate.contact_email ? candidate.contact_source : undefined),
    phone_source:
      candidate.phone_source ??
      (candidate.contact_phone ? candidate.contact_source : undefined),
  };
}

export function mergeContactCandidates(
  ...contactGroups: ContactCandidate[][]
): ContactCandidate[] {
  // Pass 1: bucket all email-bearing candidates by email (authoritative key).
  const byEmail = new Map<string, ContactCandidate>();
  // Pass 1 also: index email candidates by name+org so we can match no-email
  // candidates to them in pass 2.
  const emailCandidatesByName = new Map<string, string>(); // nameKey -> email

  for (const rawCandidate of contactGroups.flat()) {
    const candidate = normalizeCandidate(rawCandidate);
    const email = candidate.contact_email.trim().toLowerCase();
    if (!email) continue;

    const existing = byEmail.get(email);
    byEmail.set(email, existing ? mergePair(existing, candidate) : candidate);

    const nk = nameKey(candidate);
    if (nk && !emailCandidatesByName.has(nk)) {
      emailCandidatesByName.set(nk, email);
    }
  }

  // Pass 2: handle no-email candidates.
  // If the same person already has an email entry (e.g. Reonomy gave us the
  // name and Hunter found the email), merge into that entry instead of
  // creating a duplicate no-email row.
  const byName = new Map<string, ContactCandidate>(); // fallback for truly unknown emails

  for (const rawCandidate of contactGroups.flat()) {
    const candidate = normalizeCandidate(rawCandidate);
    const email = candidate.contact_email.trim().toLowerCase();
    if (email) continue; // already handled in pass 1

    const nk = nameKey(candidate);
    const matchedEmail = nk ? emailCandidatesByName.get(nk) : undefined;

    if (matchedEmail) {
      // Same person — enrich the existing email entry with name/title/phone.
      const existing = byEmail.get(matchedEmail)!;
      byEmail.set(matchedEmail, mergePair(existing, candidate));
    } else if (nk) {
      // Genuinely new person with no email yet.
      const existing = byName.get(nk);
      byName.set(nk, existing ? mergePair(existing, candidate) : candidate);
    }
  }

  return [...byEmail.values(), ...byName.values()].sort((a, b) => {
    const scoreDiff = titleScore(b.contact_title) - titleScore(a.contact_title);
    if (scoreDiff !== 0) return scoreDiff;
    return b.confidence - a.confidence;
  });
}

export function sequenceForIndex(index: number): "Primary" | "Secondary" | "Tertiary" {
  if (index === 0) return "Primary";
  if (index === 1) return "Secondary";
  return "Tertiary";
}
