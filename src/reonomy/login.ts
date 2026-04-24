import type { Stagehand } from "@browserbasehq/stagehand";
import { config } from "../config";
import { sleep } from "../utils";

// TODO: Adjust these if Reonomy changes their post-login landing page.
const VALID_POST_LOGIN_PATHS = ["/dashboard", "/search", "/properties", "/portfolio", "/!/home"];
const UPGRADE_PATH_MARKERS = ["/!/account/upgrade", "/account/upgrade", "/upgrade"];

function isLoggedIn(url: string): boolean {
  return VALID_POST_LOGIN_PATHS.some((p) => url.includes(p));
}

function isUpgradeRedirect(url: string): boolean {
  return UPGRADE_PATH_MARKERS.some((marker) => url.includes(marker));
}

function buildUpgradeError(url: string): Error {
  return new Error(
    [
      `[login] Login blocked by Reonomy upgrade page: ${url}`,
      "[login] This account appears to be on a plan that does not allow access to the app/search pages.",
      "[login] Fix: use an active Reonomy seat/workspace with search access, then rerun the scraper.",
    ].join("\n")
  );
}

/**
 * Logs into Reonomy via email/password.
 * Navigates to the login page, fills credentials, submits, and
 * waits until the browser lands on a known post-login path.
 */
export async function loginToReonomy(stagehand: Stagehand): Promise<void> {
  const page = stagehand.page;
  const { email, password, baseUrl } = config.reonomy;
  const { pageLoadTimeout, actionDelay } = config.run;

  console.log("[login] Navigating to Reonomy login page...");
  await page.goto(`${baseUrl}/login`, {
    waitUntil: "domcontentloaded",
    timeout: pageLoadTimeout,
  });
  console.log(`[login] Login page loaded: ${page.url()}`);
  await sleep(actionDelay);

  // --- Fill email ---
  // TODO: Update selector if Reonomy changes their login form.
  // Look for an input with name="email", type="email", or placeholder "Email".
  console.log("[login] Entering email...");
  await page.act({
    action: `Click the email input field and type "${email}"`,
  });
  console.log("[login] Email entered.");
  await sleep(800);

  // --- Fill password ---
  // TODO: Update selector if Reonomy changes their login form.
  console.log("[login] Entering password...");
  await page.act({
    action: `Click the password input field and type "${password}"`,
  });
  console.log("[login] Password entered.");
  await sleep(800);

  // --- Submit ---
  // TODO: Update if the button label changes.
  console.log("[login] Submitting login...");
  await page.act({
    action: 'Click the "Log In" or "Sign In" button to submit the login form',
  });
  console.log("[login] Login submitted.");

  // --- Verify post-login URL ---
  console.log("[login] Waiting for post-login page...");
  try {
    await page.waitForURL("**/dashboard**", { timeout: pageLoadTimeout });
  } catch {
    const currentUrl = page.url();
    if (isUpgradeRedirect(currentUrl)) {
      throw buildUpgradeError(currentUrl);
    }
    if (!isLoggedIn(currentUrl)) {
      throw new Error(`[login] Login failed — unexpected URL: ${currentUrl}`);
    }
    console.log(`[login] Final URL after login: ${currentUrl}`);
  }

  const finalUrl = page.url();
  if (isUpgradeRedirect(finalUrl)) {
    throw buildUpgradeError(finalUrl);
  }
  console.log(`[login] Final URL after login: ${finalUrl}`);
  console.log("[login] Login successful.");
}
