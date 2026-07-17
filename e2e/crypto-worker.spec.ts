import { expect, test } from "@playwright/test";

test("runs the isolated vault crypto protocol without exposing key material", async ({
  page,
}) => {
  test.slow();
  await page.goto("/setup");
  const result = await page.evaluate(async () => {
    const worker = new Worker("/_workers/vault.worker.js", {
      type: "module",
      name: "crypto-e2e",
    });
    let sequence = 0;
    const call = (type: string, input: Record<string, unknown> = {}) =>
      new Promise<unknown>((resolve, reject) => {
        const id = `request-${sequence++}`;
        const timeout = window.setTimeout(
          () => reject(new Error(`Crypto Worker timed out: ${type}`)),
          30_000,
        );
        const listener = (event: MessageEvent) => {
          if (event.data?.id !== id) return;
          worker.removeEventListener("message", listener);
          clearTimeout(timeout);
          if (event.data.ok) resolve(event.data.result);
          else reject(new Error(`${type}:${event.data.error.code}:${event.data.error.message}`));
        };
        worker.addEventListener("message", listener);
        worker.addEventListener("error", (event) => reject(new Error(event.message)), {
          once: true,
        });
        worker.postMessage({ id, type, ...input });
      });

    try {
      const ownerUserId = crypto.randomUUID();
      const vaultId = crypto.randomUUID();
      const initialized = (await call("initialize", {
        ownerUserId,
        vaultId,
        password: "Browser E2E master password",
        kdfParams: {
          version: 19,
          memorySize: 65_536,
          iterations: 2,
          parallelism: 1,
          hashLength: 32,
        },
      })) as {
        vault: Record<string, unknown>;
        recoveryKey: string;
      };
      const encrypted = await call("encrypt-record", {
        ownerUserId,
        recordType: "crypto-e2e",
        recordId: "record-1",
        value: { secret: "never-on-server" },
      });
      const decrypted = await call("decrypt-record", {
        ownerUserId,
        recordType: "crypto-e2e",
        recordId: "record-1",
        envelope: encrypted,
      });
      const totp = await call("preview-totp", {
        configuration: {
          type: "totp",
          issuer: "RFC",
          label: "fixture",
          secretBase32: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
          algorithm: "SHA1",
          digits: 8,
          period: 30,
        },
        timestamp: 59_000,
      });
      let aadRejected = false;
      try {
        await call("decrypt-record", {
          ownerUserId,
          recordType: "crypto-e2e",
          recordId: "record-2",
          envelope: encrypted,
        });
      } catch {
        aadRejected = true;
      }
      await call("lock");
      const status = await call("status");
      return {
        vault: initialized.vault,
        recoveryKey: initialized.recoveryKey,
        decrypted,
        totp,
        aadRejected,
        status,
      };
    } finally {
      worker.terminate();
    }
  });

  expect(result.recoveryKey).toMatch(/^avrk1_[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(result.vault)).not.toContain("Browser E2E master password");
  expect(JSON.stringify(result.vault)).not.toContain("vaultRootKey");
  expect(result.decrypted).toEqual({ secret: "never-on-server" });
  expect(result.totp).toMatchObject({ code: "94287082", period: 30 });
  expect(result.aadRejected).toBe(true);
  expect(result.status).toEqual({ unlocked: false });
});
