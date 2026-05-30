/**
 * Cobalt Intelligence Secretary of State Resolver
 *
 * Uses Cobalt's SOS API to verify LLC / corporation registry records.
 * Cobalt does not generally return company domains, so this adapter contributes
 * legal-entity confidence and registry person/address signals only.
 */

import type {
  OwnerResolutionInput,
  AdapterResult,
  OwnerResolutionAdapterConfig,
} from "../types";

type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://apigateway.cobaltintelligence.com";

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function nestedString(source: JsonObject, ...paths: string[][]): string {
  for (const path of paths) {
    let current: unknown = source;
    for (const part of path) {
      const obj = asObject(current);
      if (!obj) {
        current = undefined;
        break;
      }
      current = obj[part];
    }
    const value = firstString(current);
    if (value) return value;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectResults(payload: JsonObject): JsonObject[] {
  return [
    ...asArray(payload["results"]),
    ...asArray(payload["businesses"]),
    ...asArray(payload["data"]),
  ]
    .map((result) => asObject(result))
    .filter((result): result is JsonObject => result !== null);
}

function resultName(result: JsonObject): string {
  return firstString(
    result["title"],
    result["businessName"],
    result["business_name"],
    result["name"],
    result["entityName"],
    result["entity_name"],
    result["companyName"]
  );
}

function resultStatus(result: JsonObject): string {
  return firstString(
    result["businessStatus"],
    result["status"],
    result["entityStatus"],
    result["entity_status"]
  );
}

function resultState(result: JsonObject): string {
  return firstString(
    result["stateOfSosRegistration"],
    result["stateOfFormation"],
    result["state"],
    result["jurisdiction"],
    result["jurisdictionState"]
  );
}

function resultCity(result: JsonObject): string {
  return firstString(
    result["city"],
    nestedString(result, ["principalAddress", "city"], ["businessAddress", "city"], ["address", "city"])
  );
}

function resultPerson(result: JsonObject): string {
  const peopleSources = [
    ...asArray(result["officers"]),
    ...asArray(result["principals"]),
    ...asArray(result["registeredAgents"]),
    ...asArray(result["registeredAgent"]),
  ];

  for (const person of peopleSources) {
    const obj = asObject(person);
    if (!obj) continue;
    const name = firstString(
      obj["name"],
      obj["fullName"],
      obj["officerName"],
      obj["registeredAgentName"]
    );
    if (name) return name;
  }

  return firstString(
    result["registeredAgent"],
    result["registeredAgentName"],
    result["agentName"],
    nestedString(result, ["agent", "name"], ["registered_agent", "name"])
  );
}

function isLikelyActive(status: string): boolean {
  if (!status) return true;
  const normalized = status.toLowerCase();
  return !["inactive", "dissolved", "revoked", "terminated", "withdrawn"].some((word) =>
    normalized.includes(word)
  );
}

function chooseBestResult(results: JsonObject[]): JsonObject | null {
  const named = results.filter((result) => resultName(result));
  if (named.length === 0) return null;
  return named.find((result) => isLikelyActive(resultStatus(result))) ?? named[0];
}

export class CobaltSosResolver {
  constructor(private readonly config: OwnerResolutionAdapterConfig) {}

  async resolve(input: OwnerResolutionInput): Promise<AdapterResult | null> {
    if (!this.config.enabled || !this.config.apiKey) return null;

    const companyName = (input.normalized_owner_name || input.raw_owner_name).trim();
    if (!companyName || !input.state) return null;

    try {
      const payload = await this.search({
        searchQuery: companyName,
        state: input.state.toUpperCase(),
        liveData: "true",
        findRelatedBusinesses: "true",
      });

      const result = chooseBestResult(collectResults(payload));
      if (!result) return null;

      const name = resultName(result);
      if (!name) return null;

      const status = resultStatus(result);
      const entityType = firstString(
        result["entityType"],
        result["businessType"],
        result["type"],
        result["companyType"]
      );

      return {
        candidate_company_name: name,
        candidate_domain: "",
        matched_city: resultCity(result),
        matched_state: resultState(result) || input.state,
        matched_name: resultPerson(result),
        industry: [entityType, status].filter(Boolean).join(" ").trim() || "secretary of state registry",
        source: "cobalt",
      };
    } catch {
      return null;
    }
  }

  private async search(params: Record<string, string>): Promise<JsonObject> {
    const first = await this.fetchSearch(params);
    const retryId = firstString(first["retryId"], first["retryID"], first["id"]);
    if (collectResults(first).length > 0 || !retryId) return first;

    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(1500);
      const retry = await this.fetchSearch({ retryId, state: params["state"] });
      if (collectResults(retry).length > 0) return retry;
    }

    return first;
  }

  private async fetchSearch(params: Record<string, string>): Promise<JsonObject> {
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const url = new URL("/v1/search", baseUrl);

    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "x-api-key": this.config.apiKey ?? "",
      },
    });

    if (!response.ok) {
      if ([401, 403, 404, 429].includes(response.status)) return {};
      throw new Error(`Cobalt SOS HTTP ${response.status}`);
    }

    const payload = await response.json();
    return asObject(payload) ?? {};
  }
}
