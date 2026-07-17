import { describe, expect, it } from "vitest";
import {
  assertPasskeyDeletionAllowed,
  PasskeyManagementError,
} from "../passkey-management";

describe("Passkey deletion policy", () => {
  it("rejects credentials that are not owned by the current user", () => {
    expect(() => assertPasskeyDeletionAllowed(false, 2)).toThrowError(
      expect.objectContaining<Partial<PasskeyManagementError>>({
        code: "PASSKEY_NOT_FOUND",
      }),
    );
  });

  it("protects the final credential", () => {
    expect(() => assertPasskeyDeletionAllowed(true, 1)).toThrowError(
      expect.objectContaining<Partial<PasskeyManagementError>>({
        code: "LAST_PASSKEY_PROTECTED",
      }),
    );
  });

  it("allows one credential to be removed when a backup remains", () => {
    expect(() => assertPasskeyDeletionAllowed(true, 2)).not.toThrow();
  });
});
