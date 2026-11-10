import { createHash } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

const password = process.env.LDAP_USER_PASSWORD;
if (!password) throw new Error("LDAP_USER_PASSWORD is required.");

const chrome = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
await access(chrome).catch(() => {
  throw new Error(`Google Chrome was not found at ${chrome}. Set CHROME_BIN to its path.`);
});

const fingerprint = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

const profile = await mkdtemp(join(tmpdir(), "iam-browser-smoke-"));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: chrome,
  headless: true,
  ignoreHTTPSErrors: false,
  viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] ?? (await context.newPage());
const tokenReceipts = [];
let revocationRequests = 0;

page.on("response", async (response) => {
  const url = response.url();
  if (!url.endsWith("/protocol/openid-connect/token") || response.request().method() !== "POST") {
    return;
  }
  const body = await response.json().catch(() => null);
  if (body && typeof body.access_token === "string") {
    tokenReceipts.push({
      access: fingerprint(body.access_token),
      refresh: typeof body.refresh_token === "string" ? fingerprint(body.refresh_token) : null,
      status: response.status(),
    });
  }
});
page.on("request", (request) => {
  if (request.url().endsWith("/protocol/openid-connect/revoke")) revocationRequests += 1;
});

try {
  await page.goto("https://app.localhost", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with PKCE" }).waitFor();
  console.log("certificate_and_entry=passed");

  await page.getByRole("button", { name: "Sign in with PKCE" }).click();
  await page.waitForURL(/auth\.localhost\/realms\/company\/protocol\/openid-connect\/auth/);
  const authorization = new URL(page.url());
  if (authorization.searchParams.get("response_type") !== "code") {
    throw new Error("Authorization response_type was not code.");
  }
  if (authorization.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("Authorization request did not use PKCE S256.");
  }
  if (!authorization.searchParams.get("code_challenge")) {
    throw new Error("Authorization request omitted the PKCE challenge.");
  }
  console.log("pkce_authorization_request=passed");

  await page.locator("#username").fill("ali");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await page.waitForURL("https://app.localhost/", { timeout: 30_000 });
  await page.getByRole("heading", { name: "Who am I?" }).waitFor();
  if (tokenReceipts.length !== 1 || tokenReceipts[0].status !== 200) {
    throw new Error(
      `Expected one successful authorization-code exchange, got ${tokenReceipts.length}.`,
    );
  }
  const storage = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    body: document.body.textContent,
  }));
  if (storage.local !== 0 || storage.session !== 0) {
    throw new Error(
      `Persistent browser storage was not empty (${storage.local}/${storage.session}).`,
    );
  }
  if (storage.body.includes("eyJ")) throw new Error("A raw JWT appears in the rendered page.");
  console.log("callback_and_memory_only_session=passed");

  await page.getByRole("button", { name: "Documents" }).click();
  await page.getByRole("heading", { name: "Documents" }).waitFor();
  await page.getByText("Employee access guide").waitFor();
  if (await page.getByRole("button", { name: "Administration" }).count()) {
    throw new Error("Employee identity received administrator navigation.");
  }
  console.log("authenticated_api_and_admin_refusal=passed");

  const refreshDeadline = Date.now() + 285_000;
  while (tokenReceipts.length < 2 && Date.now() < refreshDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (tokenReceipts.length < 2) throw new Error("Automatic silent renewal was not observed.");
  if (tokenReceipts[0].access === tokenReceipts[1].access) {
    throw new Error("Silent renewal did not rotate the access token.");
  }
  if (tokenReceipts[0].refresh === tokenReceipts[1].refresh) {
    throw new Error("Silent renewal did not rotate the refresh token.");
  }
  await page.getByRole("heading", { name: "Documents" }).waitFor();
  console.log("silent_refresh_and_rotation=passed");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Sign in with PKCE" }).waitFor();
  console.log("reload_drops_memory_session=passed");
  await page.getByRole("button", { name: "Sign in with PKCE" }).click();
  await page.waitForURL("https://app.localhost/", { timeout: 30_000 });
  await page.getByRole("heading", { name: "Who am I?" }).waitFor();
  if (tokenReceipts.length < 3) throw new Error("SSO re-entry did not exchange a new code.");

  await page.getByRole("button", { name: "Revoke and sign out" }).click();
  await page.waitForURL("https://app.localhost/", { timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in with PKCE" }).waitFor();
  if (revocationRequests < 1) throw new Error("No browser token-revocation request was observed.");
  const finalStorage = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
  }));
  if (finalStorage.local !== 0 || finalStorage.session !== 0) {
    throw new Error("Browser storage was not empty after logout.");
  }
  console.log(`logout_and_revocation=passed requests=${revocationRequests}`);
  console.log("browser_oauth_smoke=passed");
} finally {
  await context.close();
  await rm(profile, { force: true, recursive: true });
}
