import { describe, it, expect, vi, afterEach } from "vitest";
import { CobaltSosResolver } from "../../enrichment/owner-resolution/adapters/cobalt";
import type { OwnerResolutionInput } from "../../enrichment/owner-resolution/types";

function makeInput(overrides?: Partial<OwnerResolutionInput>): OwnerResolutionInput {
  return {
    property_id: "prop-001",
    raw_owner_name: "1101 Madison LLC",
    normalized_owner_name: "1101 Madison",
    owner_type: "",
    owner_mailing_address: "",
    care_of_name: "",
    property_address: "1101 Madison St",
    city: "Hoboken",
    state: "NJ",
    zip: "07030",
    source_platform: "reonomy",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CobaltSosResolver", () => {
  it("maps a Cobalt SOS result into an AdapterResult", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "1101 Madison LLC",
            businessStatus: "Active",
            stateOfSosRegistration: "NJ",
            principalAddress: { city: "Hoboken" },
            registeredAgentName: "Ralph A Larossa",
            entityType: "Limited Liability Company",
          },
        ],
      }),
    } as Response);

    const resolver = new CobaltSosResolver({
      enabled: true,
      apiKey: "fake-cobalt-key",
    });

    const result = await resolver.resolve(makeInput());

    expect(result).toMatchObject({
      candidate_company_name: "1101 Madison LLC",
      candidate_domain: "",
      matched_city: "Hoboken",
      matched_state: "NJ",
      matched_name: "Ralph A Larossa",
      source: "cobalt",
    });
  });

  it("skips when no API key is configured", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const resolver = new CobaltSosResolver({ enabled: true });

    await expect(resolver.resolve(makeInput())).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
