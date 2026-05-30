/**
 * check-keys.ts
 * Pings every external API in the stack and reports: OK / FREE_TRIAL / ERROR
 *
 * Run with:  npx ts-node tmp/check-keys.ts
 */

import dotenv from "dotenv";
import * as https from "https";
import * as http from "http";

dotenv.config({ path: ".env" });

// ── helpers ──────────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  status: "OK" | "FREE_TRIAL" | "NO_KEY" | "ERROR" | "SKIPPED";
  plan?: string;
  credits?: string | number;
  detail?: string;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function post(url: string, payload: object, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const req = lib.request(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(data);
    req.end();
  });
}

function ok(result: Omit<CheckResult, "status">): CheckResult {
  return { status: "OK", ...result };
}
function trial(result: Omit<CheckResult, "status">): CheckResult {
  return { status: "FREE_TRIAL", ...result };
}
function err(name: string, detail: string): CheckResult {
  return { name, status: "ERROR", detail };
}
function noKey(name: string): CheckResult {
  return { name, status: "NO_KEY", detail: "Key not set in .env" };
}
function skipped(name: string, reason: string): CheckResult {
  return { name, status: "SKIPPED", detail: reason };
}

// ── individual checkers ───────────────────────────────────────────────────────

async function checkBrowserbase(): Promise<CheckResult> {
  const key = process.env.BROWSERBASE_API_KEY;
  if (!key) return noKey("Browserbase");
  try {
    // /v1/projects/:id returns plan info
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    const projRes = projectId
      ? await get(`https://www.browserbase.com/v1/projects/${projectId}`, { "x-bb-api-key": key })
      : null;
    const proj = projRes?.status === 200 ? JSON.parse(projRes.body) : null;
    const plan: string = proj?.plan ?? proj?.billingPlan ?? "";
    const isTrial = plan.toLowerCase().includes("trial") || plan.toLowerCase().includes("free") || plan.toLowerCase().includes("starter");
    // fallback: validate key via sessions endpoint
    const res = await get("https://www.browserbase.com/v1/sessions?status=RUNNING&limit=1", { "x-bb-api-key": key });
    if (res.status === 200 || projRes?.status === 200) {
      const detail = plan ? `Plan: ${plan}` : "Live key accepted";
      return isTrial ? trial({ name: "Browserbase", plan, detail }) : ok({ name: "Browserbase", plan, detail });
    }
    if (res.status === 401 || res.status === 403) return err("Browserbase", "Auth failed — key may be expired");
    return err("Browserbase", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("Browserbase", e.message);
  }
}

async function checkOpenAI(): Promise<CheckResult> {
  const key = process.env.STAGEHAND_MODEL_API_KEY;
  if (!key || !key.startsWith("sk-")) return noKey("OpenAI");
  try {
    // /v1/organizations returns org-level plan info
    const orgRes = await get("https://api.openai.com/v1/organizations", { Authorization: `Bearer ${key}` });
    if (orgRes.status === 200) {
      const json = JSON.parse(orgRes.body);
      const org = Array.isArray(json?.data) ? json.data[0] : json;
      const plan: string = org?.plan?.title ?? org?.billing_address ?? "";
      const isTrial = plan.toLowerCase().includes("free") || plan.toLowerCase().includes("trial");
      const detail = plan ? `Plan: ${plan}` : "Key accepted";
      return isTrial ? trial({ name: "OpenAI", plan, detail }) : ok({ name: "OpenAI", plan, detail });
    }
    // fallback: models list just checks key validity
    const res = await get("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
    if (res.status === 200) return ok({ name: "OpenAI", detail: "Key accepted (plan info unavailable)" });
    if (res.status === 401) return err("OpenAI", "Invalid API key");
    if (res.status === 429) return err("OpenAI", "Rate limited or quota exceeded");
    return err("OpenAI", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("OpenAI", e.message);
  }
}

async function checkAnthropic(): Promise<CheckResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return noKey("Anthropic (Claude)");
  try {
    // Anthropic has no public billing API — use response headers to infer tier.
    // x-anthropic-ratelimit-requests-limit: free=5/min, paid=50+/min
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      { "x-api-key": key, "anthropic-version": "2023-06-01" }
    );
    if (res.status === 200 || res.status === 400) {
      // 400 = bad request but auth passed — still tells us the key works
      return ok({ name: "Anthropic (Claude)", detail: "Key accepted (no public billing API — verify at console.anthropic.com)" });
    }
    if (res.status === 401) return err("Anthropic (Claude)", "Invalid API key");
    if (res.status === 403) return trial({ name: "Anthropic (Claude)", detail: "Forbidden — may be on free tier without API access" });
    if (res.status === 529) return trial({ name: "Anthropic (Claude)", detail: "Overloaded — likely free tier rate limits" });
    return err("Anthropic (Claude)", `HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  } catch (e: any) {
    return err("Anthropic (Claude)", e.message);
  }
}

async function checkAttom(): Promise<CheckResult> {
  const key = process.env.ATTOM_API_KEY;
  if (!key) return noKey("ATTOM");
  try {
    const res = await get(
      "https://api.gateway.attomdata.com/propertyapi/v1.0.0/property/basicprofile?address1=4529+Winona+Court&address2=Denver,+CO+80212",
      { apikey: key, accept: "application/json" }
    );
    if (res.status === 200) return ok({ name: "ATTOM", detail: "Subscription active" });
    if (res.status === 401 || res.status === 403) return err("ATTOM", "Auth failed — key may be expired or trial ended");
    if (res.status === 429) return err("ATTOM", "Rate limit hit");
    return err("ATTOM", `HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  } catch (e: any) {
    return err("ATTOM", e.message);
  }
}

async function checkApollo(): Promise<CheckResult> {
  const key = process.env.APOLLO_API_KEY;
  if (!key) return noKey("Apollo.io");
  if (process.env.SKIP_APOLLO === "true") return skipped("Apollo.io", "SKIP_APOLLO=true in .env");
  try {
    const res = await post(
      "https://api.apollo.io/api/v1/auth/health",
      {},
      { "x-api-key": key, "Cache-Control": "no-cache" }
    );
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      return ok({ name: "Apollo.io", plan: json?.user?.organization?.plan_type, detail: "Key accepted" });
    }
    if (res.status === 401) return err("Apollo.io", "Invalid API key");
    return err("Apollo.io", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("Apollo.io", e.message);
  }
}

async function checkHunter(): Promise<CheckResult> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return noKey("Hunter.io");
  try {
    const res = await get(`https://api.hunter.io/v2/account?api_key=${key}`);
    if (res.status === 200) {
      const json = JSON.parse(res.body);
      const data = json?.data;
      const plan = data?.plan_name ?? "unknown";
      const requests = data?.requests;
      const used = requests?.searches?.used ?? "?";
      const total = requests?.searches?.available ?? "?";
      const isTrial = plan.toLowerCase().includes("free") || plan.toLowerCase().includes("trial");
      const result = { name: "Hunter.io", plan, credits: `${used} / ${total} searches used` };
      return isTrial ? trial(result) : ok(result);
    }
    if (res.status === 401) return err("Hunter.io", "Invalid API key");
    return err("Hunter.io", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("Hunter.io", e.message);
  }
}

async function checkPDL(): Promise<CheckResult> {
  const key = process.env.PDL_API_KEY;
  if (!key) return noKey("PeopleDataLabs");
  try {
    // /v5/credits returns remaining credit balance
    const credRes = await get("https://api.peopledatalabs.com/v5/credits", { "X-Api-Key": key });
    if (credRes.status === 200) {
      const json = JSON.parse(credRes.body);
      const remaining = json?.credits ?? json?.remaining ?? "?";
      // Free tier = 500 credits/mo. Paid plans are typically 1000+.
      const isTrial = typeof remaining === "number" && remaining <= 500;
      const result = { name: "PeopleDataLabs", credits: `${remaining} credits remaining` };
      return isTrial ? trial(result) : ok(result);
    }
    // fallback: enrich test
    const res = await get("https://api.peopledatalabs.com/v5/person/enrich?email=sean%40peopledatalabs.com", { "X-Api-Key": key });
    if (res.status === 200 || res.status === 404) return ok({ name: "PeopleDataLabs", detail: "Key accepted (credit info unavailable)" });
    if (res.status === 402) return err("PeopleDataLabs", "No credits remaining");
    if (res.status === 401) return err("PeopleDataLabs", "Invalid API key");
    return err("PeopleDataLabs", `HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  } catch (e: any) {
    return err("PeopleDataLabs", e.message);
  }
}

async function checkBatchData(): Promise<CheckResult> {
  const key = process.env.BATCHDATA_API_KEY;
  if (!key) return noKey("BatchData");
  try {
    const res = await post(
      "https://api.batchdata.com/api/v1/property/skip-trace",
      { requests: [{ address: { street: "123 Main St", city: "Denver", state: "CO", zip: "80202" } }] },
      { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
    );
    if (res.status === 200) return ok({ name: "BatchData", detail: "Key accepted" });
    if (res.status === 402) return err("BatchData", "Insufficient credits — trial may be exhausted");
    if (res.status === 401 || res.status === 403) return err("BatchData", "Auth failed — key may be expired");
    return err("BatchData", `HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  } catch (e: any) {
    return err("BatchData", e.message);
  }
}

async function checkZeroBounce(): Promise<CheckResult> {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key) return noKey("ZeroBounce");
  try {
    // getcredits: returns remaining credits
    // getapiusage: returns plan info with plan_name field
    const [credRes, usageRes] = await Promise.all([
      get(`https://api.zerobounce.net/v2/getcredits?api_key=${key}`),
      get(`https://api.zerobounce.net/v2/getapiusage?api_key=${key}&start_date=2000-01-01&end_date=2099-12-31`),
    ]);
    if (credRes.status === 200) {
      const credJson = JSON.parse(credRes.body);
      const credits = credJson?.Credits ?? credJson?.credits;
      if (credits === -1 || credits === "-1") return err("ZeroBounce", "Invalid API key");
      const numCredits = parseInt(String(credits), 10);
      // Try to get plan name from usage endpoint
      let plan = "";
      if (usageRes.status === 200) {
        try { plan = JSON.parse(usageRes.body)?.plan_name ?? ""; } catch {}
      }
      const isTrial = plan.toLowerCase().includes("free") || plan.toLowerCase().includes("trial") || numCredits <= 100;
      const result = { name: "ZeroBounce", plan: plan || undefined, credits: `${numCredits} credits remaining` };
      if (numCredits === 0) return err("ZeroBounce", "0 credits remaining — top up required");
      return isTrial ? trial(result) : ok(result);
    }
    return err("ZeroBounce", `HTTP ${credRes.status}`);
  } catch (e: any) {
    return err("ZeroBounce", e.message);
  }
}

async function checkSerper(): Promise<CheckResult> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return noKey("Serper");
  try {
    // /credits returns { remainingCredits: N } — free tier = 2500 one-time credits
    const credRes = await get("https://google.serper.dev/credits", { "X-API-KEY": key });
    if (credRes.status === 200) {
      const json = JSON.parse(credRes.body);
      const remaining = json?.remainingCredits ?? json?.credits ?? "?";
      // Free plan: 2500 one-time credits, no monthly renewal
      const isTrial = typeof remaining === "number" && remaining <= 2500;
      const result = { name: "Serper", credits: `${remaining} credits remaining` };
      return isTrial
        ? trial({ ...result, detail: "Free plan — 2,500 one-time credits, no renewal" })
        : ok(result);
    }
    // fallback: run a search and check if it works
    const res = await post("https://google.serper.dev/search", { q: "test", num: 1 }, { "X-API-KEY": key });
    if (res.status === 200) return ok({ name: "Serper", detail: "Key accepted (credit info unavailable)" });
    if (res.status === 401) return err("Serper", "Invalid API key");
    if (res.status === 403) return err("Serper", "Plan limit exceeded or key inactive");
    return err("Serper", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("Serper", e.message);
  }
}

async function checkCobalt(): Promise<CheckResult> {
  const key = process.env.COBALT_API_KEY;
  const base = process.env.COBALT_BASE_URL ?? "https://apigateway.cobaltintelligence.com";
  if (!key) return noKey("Cobalt Intelligence");
  try {
    // Cobalt: test entity lookup
    const res = await get(`${base}/v1/companies?name=Acme+Corp&state=CA`, { "x-api-key": key });
    if (res.status === 200) return ok({ name: "Cobalt Intelligence", detail: "Key accepted" });
    if (res.status === 401 || res.status === 403) return err("Cobalt Intelligence", "Auth failed — key may be inactive");
    if (res.status === 404) return ok({ name: "Cobalt Intelligence", detail: "Key valid (no results, but auth passed)" });
    return err("Cobalt Intelligence", `HTTP ${res.status}: ${res.body.slice(0, 120)}`);
  } catch (e: any) {
    return err("Cobalt Intelligence", e.message);
  }
}

async function checkOpenCorporates(): Promise<CheckResult> {
  const key = process.env.OPENCORPORATES_API_KEY;
  try {
    const url = key
      ? `https://api.opencorporates.com/v0.4/companies/search?q=Acme&api_token=${key}`
      : "https://api.opencorporates.com/v0.4/companies/search?q=Acme";
    const res = await get(url);
    if (res.status === 200) {
      return key
        ? ok({ name: "OpenCorporates", detail: "Paid key accepted" })
        : trial({ name: "OpenCorporates", detail: "Using free public endpoint (no key set)" });
    }
    if (res.status === 401) return err("OpenCorporates", "Invalid API key");
    if (res.status === 429) return err("OpenCorporates", "Rate limited — free tier limit hit");
    return err("OpenCorporates", `HTTP ${res.status}`);
  } catch (e: any) {
    return err("OpenCorporates", e.message);
  }
}

// ── run all checks ────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔑  EveryBuilding — API Key Status Check\n" + "─".repeat(60));

  const checks = await Promise.all([
    checkBrowserbase(),
    checkOpenAI(),
    checkAnthropic(),
    checkAttom(),
    checkApollo(),
    checkHunter(),
    checkPDL(),
    checkBatchData(),
    checkZeroBounce(),
    checkSerper(),
    checkCobalt(),
    checkOpenCorporates(),
  ]);

  const statusIcon: Record<CheckResult["status"], string> = {
    OK:         "✅ OK          ",
    FREE_TRIAL: "⚠️  FREE TRIAL  ",
    NO_KEY:     "⬜ NO KEY       ",
    ERROR:      "❌ ERROR        ",
    SKIPPED:    "⏭️  SKIPPED     ",
  };

  for (const r of checks) {
    const icon = statusIcon[r.status];
    const extras = [r.plan, r.credits, r.detail].filter(Boolean).join(" | ");
    console.log(`${icon}  ${r.name.padEnd(22)} ${extras}`);
  }

  console.log("\n" + "─".repeat(60));
  const counts = { OK: 0, FREE_TRIAL: 0, NO_KEY: 0, ERROR: 0, SKIPPED: 0 };
  for (const r of checks) counts[r.status]++;
  console.log(`Summary: ✅ ${counts.OK} OK  ⚠️  ${counts.FREE_TRIAL} free trial  ❌ ${counts.ERROR} errors  ⬜ ${counts.NO_KEY} no key  ⏭️  ${counts.SKIPPED} skipped\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
