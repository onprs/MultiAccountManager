import { expect, test } from "@playwright/test";

test("renders the database-free setup entry without overflow", async ({ page }, testInfo) => {
  const response = await page.goto("/setup");
  expect(response?.status()).toBe(200);

  await expect(page.getByRole("heading", { name: "验证初始化权限" })).toBeVisible();
  await expect(page.getByLabel("Setup Token")).toBeVisible();
  await expect(page.getByRole("button", { name: "验证并继续" })).toBeEnabled();

  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.viewport);

  const csp = response?.headers()["content-security-policy"];
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/(?:^| )'unsafe-eval'(?: |;)/);

  await page.screenshot({
    path: testInfo.outputPath("setup.png"),
    fullPage: true,
  });
});

test("reports live but not ready before setup", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  expect(await live.json()).toMatchObject({ status: "live", setupRequired: true });

  const ready = await request.get("/api/health/ready");
  expect(ready.status()).toBe(503);
  expect(await ready.json()).toMatchObject({ status: "not_ready" });
});
