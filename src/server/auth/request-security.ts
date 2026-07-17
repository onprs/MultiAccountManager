import { readRuntimeConfig } from "@/runtime/config-store";

export async function validateApplicationOrigin(request: Request): Promise<boolean> {
  const supplied = request.headers.get("origin");
  if (!supplied) return false;
  try {
    const config = await readRuntimeConfig();
    return new URL(supplied).origin === config.application.webAuthnOrigin;
  } catch {
    return false;
  }
}
