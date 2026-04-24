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
  try {
    const response = await fetch(`${config.providers.apollo.baseUrl}/users/me`, {
      headers: { "x-api-key": config.providers.apollo.apiKey ?? "" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const user = data.user ?? {};
    console.log("\n📊 Apollo:");
    console.log(`  Plan: ${user.organization_name ?? "unknown"}`);
    console.log(`  Credits Used: ${user.credits_used ?? "unknown"}`);
    console.log(`  Credits Limit: ${user.credits_limit ?? "unknown"}`);
  } catch (error) {
    console.error("❌ Apollo check failed:", error instanceof Error ? error.message : error);
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
