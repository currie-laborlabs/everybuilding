import type { EnrichedPropertyLead, EnrichmentStatus, NormalizedLead } from "../types";
import { CircuitBreaker } from "../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../infra/rateLimiter";
import { withRetry } from "../infra/retry";
import { cleanText, makePropertyKey } from "../utils";

export interface AttomClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

export class AttomClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: AttomClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  async enrichLead(lead: NormalizedLead): Promise<EnrichedPropertyLead> {
    if (!this.config.apiKey) {
      return {
        ...lead,
        last_sale_date: "",
        last_sale_price: "",
        permit_summary: "",
        roof_permit_date: "",
        hvac_permit_date: "",
        plumbing_permit_date: "",
        electrical_permit_date: "",
        restoration_permit_date: "",
        fire_water_permit_date: "",
        last_permit_date: "",
        permit_contractor: "",
        ownership_transfer_flag: "",
        tax_or_distress_notes: "",
        hazard_notes: "",
        crime_notes: "",
        demographics_notes: "",
        air_quality_notes: "",
        climate_notes: "",
        enrichment_status: "skipped",
      };
    }

    try {
      // Step 1: property/detail first — we need geoIdV4 from it to call the Community API.
      const detailResponse = await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchAttomPayload(lead), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );

      // Extract ZI (zip-level) geoIdV4 for the Community API call.
      const geoIdV4 = (detailResponse as any)?.property?.[0]?.location?.geoIdV4?.ZI ?? "";

      // Step 2: permits, assessment, community — all in parallel.
      const [permitResponse, assessmentResponse, communityResponse] = await Promise.all([
        this.limiter.schedule(() =>
          this.breaker.execute(() =>
            withRetry(() => this.fetchPermitPayload(lead), {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
            })
          )
        ).catch(() => null), // permit endpoint may be restricted on some plans
        this.limiter.schedule(() =>
          this.breaker.execute(() =>
            withRetry(() => this.fetchAssessmentPayload(lead), {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
            })
          )
        ).catch(() => null), // degrade gracefully if not on plan
        geoIdV4
          ? this.limiter.schedule(() =>
              this.breaker.execute(() =>
                withRetry(() => this.fetchCommunityPayload(geoIdV4), {
                  maxAttempts: this.config.maxAttempts,
                  baseDelayMs: this.config.baseDelayMs,
                  maxDelayMs: this.config.maxDelayMs,
                })
              )
            ).catch(() => null) // community API may not be included in plan
          : Promise.resolve(null),
      ]);

      return this.mapPayload(lead, detailResponse, permitResponse, assessmentResponse, communityResponse);
    } catch (error) {
      return {
        ...lead,
        last_sale_date: "",
        last_sale_price: "",
        permit_summary: "",
        roof_permit_date: "",
        hvac_permit_date: "",
        plumbing_permit_date: "",
        electrical_permit_date: "",
        restoration_permit_date: "",
        fire_water_permit_date: "",
        last_permit_date: "",
        permit_contractor: "",
        ownership_transfer_flag: "",
        tax_or_distress_notes: "",
        hazard_notes: "",
        crime_notes: "",
        demographics_notes: "",
        air_quality_notes: "",
        climate_notes: "",
        enrichment_status: "failed",
      };
    }
  }

  private async fetchAttomPayload(lead: NormalizedLead): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/property/detail`);
    // ATTOM requires address1 (street) + address2 (city state zip).
    // address1+postalcode alone is an invalid parameter combination (-4).
    url.searchParams.set("address1", lead.property_address);
    url.searchParams.set(
      "address2",
      `${lead.city} ${lead.state} ${lead.zip_code}`.trim()
    );

    const response = await fetch(url, {
      headers: {
        apikey: this.config.apiKey ?? "",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`ATTOM ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async fetchPermitPayload(lead: NormalizedLead): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/property/buildingpermits`);
    url.searchParams.set("address1", lead.property_address);
    url.searchParams.set(
      "address2",
      `${lead.city} ${lead.state} ${lead.zip_code}`.trim()
    );

    const response = await fetch(url, {
      headers: {
        apikey: this.config.apiKey ?? "",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`ATTOM permits ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async fetchAssessmentPayload(lead: NormalizedLead): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/assessment/detail`);
    url.searchParams.set("address1", lead.property_address);
    url.searchParams.set(
      "address2",
      `${lead.city} ${lead.state} ${lead.zip_code}`.trim()
    );

    const response = await fetch(url, {
      headers: {
        apikey: this.config.apiKey ?? "",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`ATTOM assessment ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private async fetchCommunityPayload(geoIdV4: string): Promise<unknown> {
    // Community API lives at /v4, not /propertyapi/v1.0.0
    const origin = new URL(this.config.baseUrl).origin;
    const url = new URL(`${origin}/v4/neighborhood/community`);
    url.searchParams.set("geoIdV4", geoIdV4);

    const response = await fetch(url, {
      headers: {
        apikey: this.config.apiKey ?? "",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`ATTOM community ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private mapPayload(
    lead: NormalizedLead,
    payload: unknown,
    permitPayload: unknown | null,
    assessmentPayload: unknown | null,
    communityPayload: unknown | null
  ): EnrichedPropertyLead {
    // ── property/detail ──────────────────────────────────────────────────────
    const data = payload as {
      property?: Array<{
        sale?: { amount?: number; saleTransDate?: string };
        building?: { size?: { universalsize?: number }; construction?: { yearBuilt?: number } };
        owner?: { name?: string };
        assessment?: { tax?: { taxAmt?: number } };
      }>;
    };

    const first = data.property?.[0];
    const saleAmount = first?.sale?.amount;
    const saleDate = first?.sale?.saleTransDate; // e.g. "2023-04-12"
    const taxAmount = first?.assessment?.tax?.taxAmt;

    // Ownership transfer flag: flag if last sale was within the past 24 months.
    let ownershipTransferFlag = "";
    if (saleDate) {
      const msIn24Months = 24 * 30 * 24 * 60 * 60 * 1000;
      const saleTs = new Date(saleDate).getTime();
      if (!isNaN(saleTs) && Date.now() - saleTs <= msIn24Months) {
        ownershipTransferFlag = `Recent transfer: ${saleDate}`;
      }
    }

    // ── property/buildingpermits ─────────────────────────────────────────────
    let permitSummary = "";
    let roofPermitDate = "";
    let hvacPermitDate = "";
    let plumbingPermitDate = "";
    let electricalPermitDate = "";
    let restorationPermitDate = "";
    let fireWaterPermitDate = "";
    let lastPermitDate = "";
    let permitContractor = "";

    if (permitPayload) {
      const permitData = permitPayload as {
        property?: Array<{
          buildingPermits?: Array<{
            type?: string;
            subType?: string;
            description?: string;
            classifiers?: string[];
            effectiveDate?: string;
            status?: string;
            companyName?: string;
            homeOwnerName?: string;
            permitNumber?: string;
          }>;
        }>;
      };

      const permits = permitData.property?.[0]?.buildingPermits ?? [];

      if (permits.length > 0) {
        // Summary: "Type — description (YYYY-MM-DD)" joined by "; "
        permitSummary = permits
          .map((p) => {
            const type = (p.type ?? "").trim();
            const desc = (p.description ?? "").trim();
            const label = type && desc ? `${type} — ${desc}` : type || desc || "permit";
            const date = p.effectiveDate ? p.effectiveDate.slice(0, 10) : "";
            return date ? `${label} (${date})` : label;
          })
          .join("; ");

        // Scan descriptions for roof and HVAC permits — keep the most recent date for each.
        const roofKeywords = /roof|shingle|membrane|flashing/i;
        const hvacKeywords = /hvac|mechanical|heating|cooling|furnace|boiler|air.?condition/i;
        const plumbingKeywords = /plumb|sewer|drain|water.?line|pipe/i;
        const electricalKeywords = /electric|wiring|panel|circuit/i;
        const restorationKeywords = /restor|remedi|abatement|mold|asbestos/i;
        const fireWaterKeywords = /fire.?damage|water.?damage|flood|sprinkler|suppression/i;

        for (const permit of permits) {
          // Combine type + description + classifiers into one string for keyword matching
          const desc = [
            permit.type ?? "",
            permit.subType ?? "",
            permit.description ?? "",
            ...(permit.classifiers ?? []),
          ].join(" ");
          const date = permit.effectiveDate ?? "";

          // Track most recent permit of any kind.
          if (date && (!lastPermitDate || date > lastPermitDate)) {
            lastPermitDate = date;
          }

          if (!date) continue;

          if (roofKeywords.test(desc)) {
            if (!roofPermitDate || date > roofPermitDate) {
              roofPermitDate = date;
              // Capture contractor on the most recent roof/HVAC permit.
              permitContractor = permit.companyName ?? permitContractor;
            }
          }
          if (hvacKeywords.test(desc)) {
            if (!hvacPermitDate || date > hvacPermitDate) {
              hvacPermitDate = date;
              if (!permitContractor) permitContractor = permit.companyName ?? "";
            }
          }
          if (plumbingKeywords.test(desc)) {
            if (!plumbingPermitDate || date > plumbingPermitDate) plumbingPermitDate = date;
          }
          if (electricalKeywords.test(desc)) {
            if (!electricalPermitDate || date > electricalPermitDate) electricalPermitDate = date;
          }
          if (restorationKeywords.test(desc)) {
            if (!restorationPermitDate || date > restorationPermitDate) restorationPermitDate = date;
          }
          if (fireWaterKeywords.test(desc)) {
            if (!fireWaterPermitDate || date > fireWaterPermitDate) fireWaterPermitDate = date;
          }
        }
      }
    }

    // ── assessment/detail ────────────────────────────────────────────────────
    // Dedicated assessment endpoint has much better coverage than the
    // assessment sub-object inside property/detail — nearly every ATTOM
    // property record has an assessed/market value even without sale history.
    let assessedValue = "";
    let marketValue = "";
    let assessmentTaxAmount: number | undefined;

    if (assessmentPayload) {
      const aData = assessmentPayload as {
        property?: Array<{
          assessment?: {
            assessed?: { assdTtlValue?: number };
            market?: { mktTtlValue?: number };
            tax?: { taxAmt?: number; taxYear?: number };
          };
        }>;
      };
      const aFirst = aData.property?.[0]?.assessment;
      if (aFirst?.assessed?.assdTtlValue) {
        assessedValue = `$${aFirst.assessed.assdTtlValue.toLocaleString()}`;
      }
      if (aFirst?.market?.mktTtlValue) {
        marketValue = `$${aFirst.market.mktTtlValue.toLocaleString()}`;
      }
      assessmentTaxAmount = aFirst?.tax?.taxAmt;
    }

    // Compose tax_or_distress_notes — prefer assessment endpoint data (better coverage)
    // then fall back to the assessment sub-object in property/detail.
    const effectiveTaxAmount = assessmentTaxAmount ?? taxAmount;
    const taxNotesParts: string[] = [];
    if (assessedValue) taxNotesParts.push(`assessed: ${assessedValue}`);
    if (marketValue) taxNotesParts.push(`market: ${marketValue}`);
    if (effectiveTaxAmount) taxNotesParts.push(`tax: $${effectiveTaxAmount.toLocaleString()}`);
    const taxDistressNotes = taxNotesParts.join("; ");

    // ── Community API (natural hazard, crime, demographics, air quality, climate) ──
    // Indexes where 100 = national average; >100 = higher than avg risk.
    // FEMA flood zone comes from property/detail location data.
    let hazardNotes = "";
    let crimeNotes = "";
    let demographicsNotes = "";
    let airQualityNotes = "";
    let climateNotes = "";
    if (communityPayload) {
      const cData = communityPayload as {
        community?: {
          naturalDisasters?: {
            hail_Index?: number;
            wind_Index?: number;
            tornado_Index?: number;
            hurricane_Index?: number;
            earthquake_Index?: number;
            weather_Index?: number;
          };
          crime?: {
            crime_Index?: number;
            aggravated_Assault_Index?: number;
            burglary_Index?: number;
            larceny_Index?: number;
            motor_Vehicle_Theft_Index?: number;
            murder_Index?: number;
            forcible_Rape_Index?: number;
            forcible_Robbery_Index?: number;
          };
          demographics?: {
            population?: number;
            median_Age?: number;
            median_Household_Income?: number;
            housing_Units_Owner_Occupied_Pct?: number;
            population_In_Poverty_Pct?: number;
          };
          airQuality?: {
            air_Pollution_Index?: number;
            ozone_Index?: number;
            particulate_Matter_Index?: number;
          };
          climate?: {
            annual_Avg_Temp?: number;
            annual_Precip_In?: number;
            annual_Snowfall_In?: number;
            rainy_Day_Mean?: number;
            snow_Day_Mean?: number;
          };
        };
      };

      const comm = cData.community;
      if (comm) {
        // Natural disasters (indexes: 100 = national avg; higher = more risk)
        const nd = comm.naturalDisasters;
        if (nd) {
          const parts: string[] = [];
          if (nd.hail_Index != null)       parts.push(`hail: ${nd.hail_Index}`);
          if (nd.wind_Index != null)       parts.push(`wind: ${nd.wind_Index}`);
          if (nd.tornado_Index != null)    parts.push(`tornado: ${nd.tornado_Index}`);
          if (nd.hurricane_Index != null)  parts.push(`hurricane: ${nd.hurricane_Index}`);
          if (nd.earthquake_Index != null) parts.push(`earthquake: ${nd.earthquake_Index}`);
          if (nd.weather_Index != null)    parts.push(`weather: ${nd.weather_Index}`);
          hazardNotes = parts.join("; ");
        }

        // Crime indexes (100 = national avg)
        const crime = comm.crime;
        if (crime) {
          const parts: string[] = [];
          if (crime.crime_Index != null)             parts.push(`overall: ${crime.crime_Index}`);
          if (crime.aggravated_Assault_Index != null) parts.push(`assault: ${crime.aggravated_Assault_Index}`);
          if (crime.burglary_Index != null)           parts.push(`burglary: ${crime.burglary_Index}`);
          if (crime.larceny_Index != null)            parts.push(`larceny: ${crime.larceny_Index}`);
          if (crime.motor_Vehicle_Theft_Index != null) parts.push(`auto theft: ${crime.motor_Vehicle_Theft_Index}`);
          crimeNotes = parts.join("; ");
        }

        // Demographics
        const demo = comm.demographics;
        if (demo) {
          const parts: string[] = [];
          if (demo.population != null)                   parts.push(`pop: ${demo.population.toLocaleString()}`);
          if (demo.median_Age != null)                   parts.push(`median age: ${demo.median_Age}`);
          if (demo.median_Household_Income != null)      parts.push(`median income: $${demo.median_Household_Income.toLocaleString()}`);
          if (demo.housing_Units_Owner_Occupied_Pct != null) parts.push(`owner occupied: ${demo.housing_Units_Owner_Occupied_Pct}%`);
          if (demo.population_In_Poverty_Pct != null)    parts.push(`poverty: ${demo.population_In_Poverty_Pct}%`);
          demographicsNotes = parts.join("; ");
        }

        // Air quality (indexes: lower = better)
        const aq = comm.airQuality;
        if (aq) {
          const parts: string[] = [];
          if (aq.air_Pollution_Index != null)     parts.push(`air pollution: ${aq.air_Pollution_Index}`);
          if (aq.ozone_Index != null)             parts.push(`ozone: ${aq.ozone_Index}`);
          if (aq.particulate_Matter_Index != null) parts.push(`PM2.5: ${aq.particulate_Matter_Index}`);
          airQualityNotes = parts.join("; ");
        }

        // Climate
        const cl = comm.climate;
        if (cl) {
          const parts: string[] = [];
          if (cl.annual_Avg_Temp != null)    parts.push(`avg temp: ${cl.annual_Avg_Temp}°F`);
          if (cl.annual_Precip_In != null)   parts.push(`annual precip: ${cl.annual_Precip_In} in`);
          if (cl.annual_Snowfall_In != null) parts.push(`annual snowfall: ${cl.annual_Snowfall_In} in`);
          if (cl.rainy_Day_Mean != null)     parts.push(`rainy days/yr: ${cl.rainy_Day_Mean}`);
          if (cl.snow_Day_Mean != null)      parts.push(`snow days/yr: ${cl.snow_Day_Mean}`);
          climateNotes = parts.join("; ");
        }
      }
    }
    // Append FEMA flood zone from property/detail if present.
    const floodZone =
      (payload as any)?.property?.[0]?.lot?.femaFloodZone ??
      (payload as any)?.property?.[0]?.location?.floodZone ?? "";
    if (floodZone && hazardNotes) {
      hazardNotes += `; flood zone: ${floodZone}`;
    } else if (floodZone) {
      hazardNotes = `flood zone: ${floodZone}`;
    }

    // enrichment_status: reflect whether any meaningful data was actually found,
    // not just whether the API calls succeeded.
    const hasAnyData = Boolean(saleDate || saleAmount || permitSummary || assessedValue || marketValue || effectiveTaxAmount);
    const enrichmentStatus: EnrichmentStatus = !first
      ? "partial"
      : hasAnyData
        ? "success"
        : "partial";

    return {
      ...lead,
      last_sale_date: saleDate ?? "",
      last_sale_price: saleAmount ? String(saleAmount) : "",
      permit_summary: permitSummary,
      roof_permit_date: roofPermitDate,
      hvac_permit_date: hvacPermitDate,
      plumbing_permit_date: plumbingPermitDate,
      electrical_permit_date: electricalPermitDate,
      restoration_permit_date: restorationPermitDate,
      fire_water_permit_date: fireWaterPermitDate,
      last_permit_date: lastPermitDate,
      permit_contractor: permitContractor,
      ownership_transfer_flag: ownershipTransferFlag,
      tax_or_distress_notes: taxDistressNotes,
      hazard_notes: hazardNotes,
      crime_notes: crimeNotes,
      demographics_notes: demographicsNotes,
      air_quality_notes: airQualityNotes,
      climate_notes: climateNotes,
      enrichment_status: enrichmentStatus,
    };
  }

  /**
   * Discover commercial properties within a ZIP code using ATTOM's /property/snapshot endpoint.
   * Returns a NormalizedLead[] ready for the enrichment pipeline — no Reonomy required.
   *
   * Verify exact propertyType codes for your plan tier via:
   *   GET /propertyapi/v1.0.0/enumerations/detail
   */
  async searchByPostalCode(
    postalCode: string,
    propertyTypes: readonly string[]
  ): Promise<NormalizedLead[]> {
    if (!this.config.apiKey) {
      console.warn("[attom] ATTOM_API_KEY not set — skipping discovery.");
      return [];
    }

    const propertyTypeParam = propertyTypes.join("|");
    const pageSize = 100;
    const leads: NormalizedLead[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = new URL(`${this.config.baseUrl}/property/snapshot`);
      url.searchParams.set("postalcode", postalCode);
      url.searchParams.set("propertytype", propertyTypeParam);
      url.searchParams.set("pagesize", String(pageSize));
      url.searchParams.set("page", String(page));

      const raw = await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(
            async () => {
              const res = await fetch(url, {
                headers: {
                  apikey: this.config.apiKey ?? "",
                  accept: "application/json",
                },
              });
              if (!res.ok) {
                throw new Error(`ATTOM discover ${res.status} ${res.statusText}`);
              }
              return res.json();
            },
            {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
            }
          )
        )
      );

      const data = raw as {
        status?: { total?: number; page?: number; pagesize?: number };
        property?: Array<{
          identifier?: { attomId?: string | number };
          address?: {
            line1?: string;
            locality?: string;
            countrySubd?: string;
            postal1?: string;
          };
          summary?: { proptype?: string; yearBuilt?: number };
          building?: { size?: { universalsize?: number } };
          owner?: { name?: string };
        }>;
      };

      const total = data.status?.total ?? 0;
      totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

      for (const prop of data.property ?? []) {
        const address = cleanText(prop.address?.line1);
        if (!address) continue;

        const zip = cleanText(prop.address?.postal1) || postalCode;
        const city = cleanText(prop.address?.locality);
        const state = cleanText(prop.address?.countrySubd).toUpperCase().slice(0, 2);
        const landUse = cleanText(prop.summary?.proptype);
        const sqft = prop.building?.size?.universalsize ?? null;
        const yearBuilt = prop.summary?.yearBuilt ?? null;
        const ownerName = cleanText(prop.owner?.name ?? "");
        const attomId = prop.identifier?.attomId;

        const propertyId = attomId
          ? String(attomId)
          : makePropertyKey(address, zip);

        leads.push({
          property_id: propertyId,
          property_address: address,
          city,
          state,
          zip_code: zip,
          land_use: landUse,
          square_feet: typeof sqft === "number" ? sqft : null,
          year_built: typeof yearBuilt === "number" ? yearBuilt : null,
          owner_entity: ownerName,
          source_platform: "attom",
          source_search_area: postalCode,
          source_run_date: new Date().toISOString(),
          source_notes: "",
          extraction_status: address && zip ? "extracted" : "partial",
          reonomy_owner_name: "",
          reonomy_owner_phone: "",
          reonomy_owner_email: "",
          reonomy_contact_name: "",
          reonomy_contact_title: "",
          reonomy_contact_phone: "",
          reonomy_contact_email: "",
          reonomy_company_domain: "",
          reonomy_last_acquisition_date: "",
          reonomy_detail_status: "not_attempted",
          reonomy_detail_notes: "",
          reonomy_contacts_json: "[]",
          review_status: "pending",
          notes: "",
        });
      }

      page += 1;
    } while (page <= totalPages);

    console.log(`[attom] searchByPostalCode(${postalCode}): ${leads.length} properties across ${totalPages} page(s).`);
    return leads;
  }
}
