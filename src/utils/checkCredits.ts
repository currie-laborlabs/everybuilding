import { config } from "../config";

async function checkAttomCredits(): Promise<void> {
  // ATTOM has no public account/credits endpoint; validate key with a lightweight usage call
  try {
    const url = new URL(`${config.providers.attom.baseUrl}/assessment/detail`);
    url.searchParams.set("address1", "1 Main St");
    url.searchParams.set("address2", "New York, NY 10001");
    const response = await fetch(url.toString(), {
      headers: { apikey: config.providers.attom.apiKey ?? "" },
    });
    // 200 or 404 both confirm the key is valid; 401/403 means invalid
    if (response.status === 401 || response.status === 403) {
      console.log("\n📊 ATTOM: ❌ Key invalid or unauthorized");
    } else {
      console.log("\n📊 ATTOM: ✅ Key is active (no public credits endpoint)");
    }
  } catch (error) {
    console.error("❌ ATTOM check failed:", error instanceof Error ? error.message : error);
  }
}

async function checkApolloCredits(): Promise<void> {
  console.log("\n📊 Apollo:");
  const apiKey = config.providers.apollo.apiKey ?? "";

  // Step 1: key validation (returns only {healthy, is_logged_in})
  try {
    const res = await fetch(`${config.providers.apollo.baseUrl}/auth/health`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    console.log(`  Key valid: ${data.is_logged_in ? "✅ yes" : "❌ no"}`);
    if (!data.is_logged_in) return;
  } catch (error) {
    console.error("  ❌ Auth check failed:", error instanceof Error ? error.message : error);
    return;
  }

  // Step 2: probe /mixed_people/api_search to confirm plan access
  try {
    const res = await fetch(`${config.providers.apollo.baseUrl}/mixed_people/api_search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ q_organization_name: "acme", page: 1, per_page: 1 }),
    });
    if (res.status === 403) {
      console.log("  People search: ⚠️  HTTP 403 — plan upgrade required for contact enrichment");
    } else if (res.ok) {
      const data = await res.json();
      const count = data.people?.length ?? 0;
      console.log(`  People search: ✅ Full access — ${count} result(s) on test query`);
    } else {
      const text = await res.text().catch(() => "");
      console.log(`  People search: ❌ HTTP ${res.status} — ${text.slice(0, 120)}`);
    }
  } catch (error) {
    console.error("  ❌ People search probe failed:", error instanceof Error ? error.message : error);
  }
}

async function checkHunterCredits(): Promise<void> {
  try {
    const url = `${config.providers.hunter.baseUrl}/account?api_key=${config.providers.hunter.apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const data = body.data ?? {};
    const requests = data.requests ?? {};
    const searches = requests.searches ?? {};
    const verifications = requests.verifications ?? {};
    console.log("\n📊 Hunter:");
    console.log(`  Plan: ${data.plan_name ?? "unknown"}`);
    console.log(`  Searches Used: ${searches.used ?? "unknown"} / ${searches.available ?? "unknown"}`);
    console.log(`  Verifications Used: ${verifications.used ?? "unknown"} / ${verifications.available ?? "unknown"}`);
  } catch (error) {
    console.error("❌ Hunter check failed:", error instanceof Error ? error.message : error);
  }
}

async function checkZeroBounceCredits(): Promise<void> {
  try {
    const url = `${config.providers.zerobounce.baseUrl}/getcredits?api_key=${config.providers.zerobounce.apiKey}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const credits = data.Credits ?? data.credits;
    console.log("\n📊 ZeroBounce:");
    if (credits === -1) {
      console.log("  ❌ Invalid API key");
    } else {
      console.log(`  Credits Remaining: ${credits ?? "unknown"}`);
    }
  } catch (error) {
    console.error("❌ ZeroBounce check failed:", error instanceof Error ? error.message : error);
  }
}

export async function checkAllCredits(): Promise<void> {
  console.log("==============================================");
  console.log("  API CREDITS CHECK");
  console.log("==============================================");

  await Promise.all([
    checkAttomCredits(),
    checkApolloCredits(),
    checkHunterCredits(),
    checkZeroBounceCredits(),
  ]);

  console.log("\n==============================================");
}

// Run if called directly
if (require.main === module) {
  checkAllCredits().catch(console.error);
}
