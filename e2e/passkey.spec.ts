import { expect, test } from "@playwright/test";

test("bootstraps the owner and signs in with a user-verified Passkey", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_PASSKEY_E2E !== "1",
    "requires an isolated PostgreSQL database and runtime secret files",
  );

  const setupToken = process.env.E2E_SETUP_TOKEN;
  const databasePassword = process.env.E2E_DATABASE_PASSWORD;
  if (!setupToken || !databasePassword) {
    throw new Error("Passkey E2E credentials are not configured");
  }

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:33002",
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  try {
    await page.goto("/setup");
    await page.getByLabel("Setup Token").fill(setupToken);
    await page.getByRole("button", { name: "验证并继续" }).click();

    await expect(page.getByRole("heading", { name: "连接 PostgreSQL" })).toBeVisible();
    await page.getByLabel("Password").fill(databasePassword);
    await page.getByLabel("SSL Mode").selectOption("disable");
    await page.getByRole("button", { name: "测试连接" }).click();

    await expect(page.getByRole("heading", { name: "配置站点身份" })).toBeVisible();
    await expect(page.getByLabel("Public URL")).toHaveValue("http://localhost:33002");
    await page.getByRole("button", { name: "初始化数据库" }).click();

    await expect(page.getByRole("heading", { name: "创建首位管理员" })).toBeVisible();
    await page.getByLabel("管理员名称").fill("E2E Owner");
    await page.getByLabel("登录邮箱").fill("owner@example.test");
    await page.getByLabel("Passkey 名称").fill("Primary Passkey");
    await page.getByRole("button", { name: "注册 Passkey 并完成" }).click();

    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    await expect(page.locator('input[autocomplete="username webauthn"]')).toBeVisible();
    await page.getByRole("button", { name: "使用 Passkey 登录" }).click();
    await expect(page).toHaveURL(/\/accounts$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "初始化客户端保险库" }),
    ).toBeVisible();

    let vaultRequestBody = "";
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/vault") && request.method() === "POST") {
        vaultRequestBody = request.postData() || "";
      }
    });
    const masterPassword = "E2E-only master password 2026";
    await page.getByLabel("主密码", { exact: true }).fill(masterPassword);
    await page.getByLabel("确认主密码").fill(masterPassword);
    await page.getByRole("button", { name: "创建保险库" }).click();
    await expect(
      page.getByRole("heading", { name: "保存保险库恢复资料" }),
    ).toBeVisible({ timeout: 30_000 });
    expect(vaultRequestBody).not.toContain(masterPassword);
    expect(vaultRequestBody).not.toContain("vaultRootKey");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 Recovery Kit" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^account-vault-recovery-.*\.json$/);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认并进入保险库" }).click();
    await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();

    const accountEmail = "managed@example.test";
    const accountPassword = "account-password-exact-value";
    const emailOtpEndpoint = "https://mail-code.example.test/inbox";
    const emailOtpCdk = "email-cdk-exact-value";
    const smsEndpoint = "https://sms-code.example.test/inbox";
    const smsEndpointCdk = "sms-cdk-exact-value";
    const totpSecret = "JBSWY3DPEHPK3PXP";
    await page.getByRole("button", { name: "添加账号" }).click();
    const accountDialog = page.getByRole("dialog", { name: "添加托管账号" });
    await accountDialog.getByLabel("运营别名").fill("E2E OpenAI");
    await accountDialog.getByLabel("登录邮箱").fill(accountEmail);
    await accountDialog.getByLabel("登录密码（可选）", { exact: true }).fill(accountPassword);
    await accountDialog.getByLabel("邮箱接码地址（可选）").fill(emailOtpEndpoint);
    await accountDialog.getByLabel("邮箱接码地址登录 CDK（可选）", { exact: true }).fill(emailOtpCdk);
    await accountDialog.getByLabel("手机号接码地址（可选）").fill(smsEndpoint);
    await accountDialog.getByLabel("手机号接码 CDK（可选）", { exact: true }).fill(smsEndpointCdk);
    await accountDialog
      .getByLabel("otpauth URI 或 Base32 Secret")
      .fill(totpSecret);
    await accountDialog.getByRole("button", { name: "本地验证" }).click();
    await expect(accountDialog.locator("code")).toHaveText(/^\d{3} \d{3}$/);

    const accountResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/accounts") &&
        response.request().method() === "POST",
    );
    await accountDialog.getByRole("button", { name: "保存加密账号" }).click();
    const accountResponse = await accountResponsePromise;
    expect(accountResponse.status()).toBe(201);
    const accountRequestBody = accountResponse.request().postData() || "";
    for (const plaintext of [
      accountEmail,
      accountPassword,
      emailOtpEndpoint,
      emailOtpCdk,
      smsEndpoint,
      smsEndpointCdk,
      totpSecret,
    ]) {
      expect(accountRequestBody).not.toContain(plaintext);
    }
    expect(accountRequestBody).not.toContain("secretBase32");
    expect(accountRequestBody).toContain("vault-data-v1");

    await expect(page.getByText("E2E OpenAI")).toBeVisible();
    const accountRow = page.locator("[data-account-id]").filter({ hasText: "E2E OpenAI" });
    await expect(accountRow.getByText("********", { exact: true })).toBeVisible();
    await accountRow.getByRole("button", { name: "显示密码" }).click();
    await expect(accountRow.getByText(accountPassword, { exact: true })).toBeVisible();
    await accountRow.getByRole("button", { name: "复制密码" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(accountPassword);
    await accountRow.getByRole("button", { name: "隐藏密码" }).click();
    await expect(accountRow.getByText("********", { exact: true })).toBeVisible();

    const emailSearchPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/accounts?") &&
        response.url().includes("emailBlindIndex="),
    );
    await page.getByLabel("搜索账号").fill(accountEmail);
    await page.getByLabel("搜索账号").press("Enter");
    const emailSearch = await emailSearchPromise;
    expect(decodeURIComponent(emailSearch.url())).not.toContain(accountEmail);
    expect(decodeURIComponent(page.url())).not.toContain(accountEmail);
    expect(page.url()).not.toContain("emailBlindIndex");
    await expect(page.getByText("E2E OpenAI")).toBeVisible();

    await page.getByRole("button", { name: "生成验证码" }).click();
    await expect(page.getByText("••• •••")).toBeVisible();
    await page.getByRole("button", { name: "显示验证码" }).click();
    await expect(page.locator("code").filter({ hasText: /^\d{3} \d{3}$/ })).toBeVisible();

    await page.getByRole("button", { name: "查看账号详情" }).click();
    const detailsDialog = page.getByRole("dialog", { name: "E2E OpenAI" });
    await expect(detailsDialog.getByLabel("登录密码（可选）", { exact: true })).toHaveValue(accountPassword);
    await detailsDialog.getByRole("button", { name: "Passkey 验证并编辑" }).click();
    await expect(detailsDialog.getByLabel("邮箱接码地址（可选）")).toHaveValue(emailOtpEndpoint);
    await expect(detailsDialog.getByLabel("邮箱接码地址登录 CDK（可选）", { exact: true })).toHaveValue(emailOtpCdk);
    await expect(detailsDialog.getByLabel("手机号接码地址（可选）")).toHaveValue(smsEndpoint);
    await expect(detailsDialog.getByLabel("手机号接码 CDK（可选）", { exact: true })).toHaveValue(smsEndpointCdk);

    const recoveryCodes = ["RECOVERY-ONE-2026", "RECOVERY-TWO-2026"];
    await detailsDialog.getByLabel("批量导入").fill(recoveryCodes.join("\n"));
    const recoveryImportPromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/recovery-codes") &&
        response.request().method() === "POST",
    );
    await detailsDialog.getByRole("button", { name: "加密并导入" }).click();
    const recoveryImport = await recoveryImportPromise;
    expect(recoveryImport.status()).toBe(201);
    const recoveryRequestBody = recoveryImport.request().postData() || "";
    for (const code of recoveryCodes) expect(recoveryRequestBody).not.toContain(code);

    await detailsDialog
      .getByRole("button", { name: "Passkey 验证并显示" })
      .click();
    await expect(detailsDialog.getByText(recoveryCodes[0])).toBeVisible();
    await expect(detailsDialog.getByText(recoveryCodes[1])).toBeVisible();
    await detailsDialog.getByRole("button", { name: "标记为已使用" }).first().click();
    await expect(detailsDialog.getByText("1 个未使用，共 2 个")).toBeVisible();

    const sensitiveNote = "browser-only updated note";
    await detailsDialog.getByLabel("敏感备注").fill(sensitiveNote);
    const accountUpdatePromise = page.waitForResponse(
      (response) =>
        /\/api\/v1\/accounts\/[0-9a-f-]+$/.test(response.url()) &&
        response.request().method() === "PATCH",
    );
    await detailsDialog.getByRole("button", { name: "保存更改" }).click();
    const accountUpdate = await accountUpdatePromise;
    expect(accountUpdate.status()).toBe(200);
    const updateRequestBody = accountUpdate.request().postData() || "";
    for (const plaintext of [
      sensitiveNote,
      accountEmail,
      accountPassword,
      emailOtpEndpoint,
      emailOtpCdk,
      smsEndpoint,
      smsEndpointCdk,
    ]) {
      expect(updateRequestBody).not.toContain(plaintext);
    }

    const ready = await page.request.get("/api/health/ready");
    expect(ready.status()).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ status: "ready" });

    const closedSetupStatus = await page.evaluate(async () => {
      const response = await fetch("/api/setup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return response.status;
    });
    expect(closedSetupStatus).toBe(410);

    await page.getByRole("link", { name: "登录安全" }).click();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(page.getByText("Primary Passkey")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "不能删除最后一个 Passkey" }),
    ).toBeDisabled();
  } finally {
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await cdp.send("WebAuthn.disable");
  }
});
