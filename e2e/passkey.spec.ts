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
    await page.getByLabel("初始化令牌").fill(setupToken);
    await page.getByRole("button", { name: "验证并继续" }).click();

    await expect(page.getByRole("heading", { name: "连接 PostgreSQL" })).toBeVisible();
    await page.getByLabel("数据库密码").fill(databasePassword);
    await page.getByLabel("SSL 模式").selectOption("disable");
    await page.getByRole("button", { name: "测试连接" }).click();

    await expect(page.getByRole("heading", { name: "配置站点身份" })).toBeVisible();
    await expect(page.getByLabel("公开访问地址")).toHaveValue("http://localhost:33002");
    await page.getByRole("button", { name: "初始化数据库" }).click();

    await expect(page.getByRole("heading", { name: "创建首位管理员" })).toBeVisible();
    await page.getByLabel("管理员名称").fill("E2E Owner");
    await page.getByLabel("登录邮箱").fill("owner@example.test");
    await page.getByLabel("通行密钥名称").fill("主要通行密钥");
    await page.getByRole("button", { name: "注册通行密钥并完成" }).click();

    await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    await expect(page.locator('input[autocomplete="username webauthn"]')).toBeVisible();
    await page.getByRole("button", { name: "使用通行密钥登录" }).click();
    await expect(page).toHaveURL(/\/accounts$/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "初始化保险库" }),
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
    await page.getByRole("button", { name: "下载恢复套件" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^account-vault-recovery-.*\.json$/);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认并进入保险库" }).click();
    await expect(page.getByRole("heading", { name: "账号" })).toBeVisible();

    const accountEmail = "managed@example.test";
    const accountPassword = "account-password-exact-value";
    const boundPhone = "+86 138-0013-8000";
    const emailOtpEndpoint = "https://mail-code.example.test/inbox";
    const emailOtpCdk = "email-cdk-exact-value";
    const smsEndpoint = "https://sms-code.example.test/inbox";
    const smsEndpointCdk = "sms-cdk-exact-value";
    const totpSecret = "JBSWY3DPEHPK3PXP";
    await page.getByRole("button", { name: "添加账号" }).click();
    const accountDialog = page.getByRole("dialog", { name: "添加托管账号" });
    await accountDialog.getByLabel("登录邮箱").fill(accountEmail);
    await accountDialog.getByLabel("登录密码（可选）", { exact: true }).fill(accountPassword);
    await accountDialog.getByLabel("绑定手机号").fill(boundPhone);
    await accountDialog.getByLabel("邮箱接码地址（可选）").fill(emailOtpEndpoint);
    await accountDialog.getByLabel("邮箱接码 CDK（可选）", { exact: true }).fill(emailOtpCdk);
    await accountDialog.getByLabel("手机号接码地址（可选）").fill(smsEndpoint);
    await accountDialog.getByLabel("手机号接码 CDK（可选）", { exact: true }).fill(smsEndpointCdk);
    await accountDialog
      .getByLabel("TOTP 密钥或 otpauth URI")
      .fill(totpSecret);
    await accountDialog.getByRole("button", { name: "生成测试验证码" }).click();
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
      boundPhone,
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

    await expect(page.getByText(accountEmail, { exact: true })).toBeVisible();
    const accountRow = page.locator("[data-account-id]").filter({ hasText: accountEmail });
    await expect(accountRow.getByText("未配置连接", { exact: true })).toBeVisible();
    await accountRow.getByRole("button", { name: "复制邮箱", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(accountEmail);
    await expect(accountRow.getByText("********", { exact: true })).toBeVisible();
    await accountRow.getByRole("button", { name: "显示密码" }).click();
    await expect(accountRow.getByText(accountPassword, { exact: true })).toBeVisible();
    await accountRow.getByRole("button", { name: "复制密码" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(accountPassword);
    await accountRow.getByRole("button", { name: "隐藏密码" }).click();
    await expect(accountRow.getByText("********", { exact: true })).toBeVisible();

    for (const [buttonName, value] of [
      ["复制绑定手机号", boundPhone],
      ["复制邮箱接码地址", emailOtpEndpoint],
      ["复制邮箱接码 CDK", emailOtpCdk],
      ["复制手机号接码地址", smsEndpoint],
      ["复制手机号接码 CDK", smsEndpointCdk],
    ] as const) {
      await expect(accountRow.getByText(value, { exact: true })).toBeVisible();
      await accountRow.getByRole("button", { name: buttonName, exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }

    const duplicateEmail = "managed-duplicate@example.test";
    await page.getByRole("button", { name: "添加账号" }).click();
    const duplicateDialog = page.getByRole("dialog", { name: "添加托管账号" });
    await duplicateDialog.getByLabel("登录邮箱").fill(duplicateEmail);
    await duplicateDialog.getByLabel("平台").selectOption("antigravity");
    await duplicateDialog.getByLabel("绑定手机号").fill("+86 (138) 0013 8000");
    const duplicateResponsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/accounts") &&
        response.request().method() === "POST",
    );
    await duplicateDialog.getByRole("button", { name: "保存加密账号" }).click();
    expect((await duplicateResponsePromise).status()).toBe(201);
    await expect(page.getByText("已绑定 2 个账号", { exact: true })).toHaveCount(2);

    await page.getByRole("button", { name: "邮箱按升序排列" }).click();
    await expect(page.getByRole("button", { name: "邮箱按降序排列" })).toBeVisible();
    const ascendingRows = await page.locator("[data-account-id]").allTextContents();
    const ascendingOrder = ascendingRows.map((text) =>
      text.includes(accountEmail) ? accountEmail : duplicateEmail,
    );
    expect(ascendingOrder).toEqual(
      [accountEmail, duplicateEmail].sort((left, right) =>
        left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" }),
      ),
    );
    await page.getByRole("button", { name: "邮箱按降序排列" }).click();
    await expect(page.getByRole("button", { name: "邮箱按升序排列" })).toBeVisible();
    await page.getByRole("button", { name: "平台按升序排列" }).click();
    await expect(page.getByRole("button", { name: "平台按降序排列" })).toBeVisible();
    await page.getByRole("button", { name: "Sub2API 状态按升序排列" }).click();
    await expect(page.getByRole("button", { name: "Sub2API 状态按降序排列" })).toBeVisible();

    await page.getByRole("checkbox", { name: `选择 ${accountEmail}` }).check();
    await page.getByRole("checkbox", { name: `选择 ${duplicateEmail}` }).check();
    await expect(page.getByText("已全选全部 2 个", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "清除选择" }).click();
    await expect(page.getByText("已全选全部 2 个", { exact: true })).toHaveCount(0);

    const duplicateRow = page.locator("[data-account-id]").filter({ hasText: duplicateEmail });
    await duplicateRow.getByRole("button", { name: "账号操作" }).click();
    await page.getByRole("menuitem", { name: "删除" }).click();
    const duplicateDeletePromise = page.waitForResponse(
      (response) =>
        /\/api\/v1\/accounts\/[0-9a-f-]+$/.test(response.url()) &&
        response.request().method() === "DELETE",
    );
    await page.getByRole("dialog", { name: "删除账号" })
      .getByRole("button", { name: "确认删除" })
      .click();
    expect((await duplicateDeletePromise).status()).toBe(204);
    await expect(duplicateRow).toHaveCount(0);
    await expect(accountRow.getByText("已绑定 2 个账号", { exact: true })).toBeVisible();

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
    await expect(page.getByText(accountEmail, { exact: true })).toBeVisible();

    const automaticOtp = accountRow.locator("code").filter({ hasText: /^\d{3} \d{3}$/ });
    await expect(automaticOtp).toBeVisible();
    await expect(accountRow.getByRole("button", { name: "生成验证码" })).toHaveCount(0);
    await expect(accountRow.getByRole("button", { name: "显示验证码" })).toHaveCount(0);
    const initialOtp = await automaticOtp.textContent();
    await expect.poll(
      () => automaticOtp.textContent(),
      { timeout: 35_000, intervals: [1_000] },
    ).not.toBe(initialOtp);

    await page.getByRole("button", { name: "账号操作" }).click();
    const accountMenu = page.getByRole("menu");
    await expect(accountMenu.getByRole("menuitem", { name: "编辑" })).toBeVisible();
    await expect(accountMenu.getByRole("menuitem", { name: "删除" })).toBeVisible();
    await accountMenu.getByRole("menuitem", { name: "删除" }).click();
    const deleteDialog = page.getByRole("dialog", { name: "删除账号" });
    await expect(deleteDialog.getByText("确认永久删除 1 个账号？", { exact: false })).toBeVisible();
    await deleteDialog.getByRole("button", { name: "取消" }).click();
    await page.getByRole("button", { name: "账号操作" }).click();
    await page.getByRole("menuitem", { name: "编辑" }).click();
    const detailsDialog = page.getByRole("dialog", { name: accountEmail });
    await expect(detailsDialog.getByLabel("登录密码（可选）", { exact: true })).toHaveValue(accountPassword);
    await expect(detailsDialog.getByRole("button", { name: "验证通行密钥并编辑" })).toHaveCount(0);
    await expect(detailsDialog.getByLabel("邮箱接码地址（可选）")).toHaveValue(emailOtpEndpoint);
    await expect(detailsDialog.getByLabel("邮箱接码 CDK（可选）", { exact: true })).toHaveValue(emailOtpCdk);
    await expect(detailsDialog.getByLabel("手机号接码地址（可选）")).toHaveValue(smsEndpoint);
    await expect(detailsDialog.getByLabel("手机号接码 CDK（可选）", { exact: true })).toHaveValue(smsEndpointCdk);

    await expect(detailsDialog.getByRole("heading", { name: "验证器（TOTP）" })).toBeVisible();
    await detailsDialog.getByText("更换 TOTP 配置", { exact: true }).click();
    await expect(detailsDialog.getByLabel("TOTP 密钥或 otpauth URI")).toBeVisible();
    await detailsDialog.getByText("参数设置", { exact: true }).click();
    await expect(detailsDialog.getByLabel("服务名称（Issuer）")).toHaveValue("OpenAI");
    await expect(detailsDialog.getByLabel("验证码位数")).toHaveValue("6");
    await expect(detailsDialog.getByLabel("刷新周期（秒）")).toHaveValue("30");

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
      .getByRole("button", { name: "验证通行密钥并显示" })
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
      boundPhone,
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
    await expect(page.getByText("主要通行密钥")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "不能删除最后一个通行密钥" }),
    ).toBeDisabled();
  } finally {
    try {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    } finally {
      await cdp.send("WebAuthn.disable");
    }
  }
});
