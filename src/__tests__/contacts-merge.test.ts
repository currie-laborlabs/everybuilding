import { describe, expect, it } from "vitest";
import { mergeContactCandidates } from "../enrichment/contacts/merge";
import type { ContactCandidate, ContactProviderSource } from "../types";

function candidate(
  source: ContactProviderSource,
  overrides: Partial<ContactCandidate>
): ContactCandidate {
  return {
    property_id: "property-1",
    owner_entity: "Acme Properties LLC",
    contact_name: "Jane Owner",
    contact_title: "Owner",
    contact_phone: "",
    contact_email: "",
    contact_source: source,
    confidence: 0.7,
    ...overrides,
  };
}

describe("mergeContactCandidates", () => {
  it("keeps full source attribution when Hunter fills a Reonomy contact email", () => {
    const [row] = mergeContactCandidates(
      [candidate("reonomy", { contact_phone: "555-111-2222", confidence: 0.75 })],
      [candidate("hunter", { contact_email: "jane@acme.com", confidence: 0.82 })]
    );

    expect(row.contact_source).toBe("hybrid");
    expect(row.contact_sources).toEqual(["hunter", "reonomy"]);
    expect(row.email_source).toBe("hunter");
    expect(row.phone_source).toBe("reonomy");
    expect(row.contact_email).toBe("jane@acme.com");
    expect(row.contact_phone).toBe("555-111-2222");
  });

  it("dedupes matching provider emails while retaining every source", () => {
    const [row] = mergeContactCandidates(
      [candidate("apollo", { contact_email: "ops@acme.com", confidence: 0.85 })],
      [candidate("hunter", { contact_email: "ops@acme.com", confidence: 0.8 })],
      [candidate("pdl", { contact_email: "ops@acme.com", confidence: 0.75 })]
    );

    expect(row.contact_source).toBe("hybrid");
    expect(row.contact_sources).toEqual(["apollo", "hunter", "pdl"]);
    expect(row.email_source).toBe("apollo");
    expect(row.contact_email).toBe("ops@acme.com");
  });

  it("merges a no-email Reonomy person into a provider email row by name and owner", () => {
    const [row] = mergeContactCandidates(
      [candidate("reonomy", { contact_title: "Principal" })],
      [candidate("apollo", { contact_email: "jane@acme.com", contact_title: "CEO" })]
    );

    expect(row.contact_source).toBe("hybrid");
    expect(row.contact_sources).toEqual(["apollo", "reonomy"]);
    expect(row.email_source).toBe("apollo");
    expect(row.contact_title).toBe("CEO");
  });

  it("keeps legacy single-source rows compatible", () => {
    const [row] = mergeContactCandidates([
      candidate("apollo", {
        contact_name: "Mark Manager",
        contact_title: "Property Manager",
        contact_email: "mark@acme.com",
      }),
    ]);

    expect(row.contact_source).toBe("apollo");
    expect(row.contact_sources).toEqual(["apollo"]);
    expect(row.email_source).toBe("apollo");
  });
});
