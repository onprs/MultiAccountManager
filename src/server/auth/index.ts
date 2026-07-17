import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { passkey } from "@better-auth/passkey";
import { drizzle } from "drizzle-orm/postgres-js";
import { authSchema } from "@/db/schema/auth";
import { readRuntimeConfig } from "@/runtime/config-store";
import type { RuntimeConfig } from "@/runtime/types";
import { createDatabaseClient } from "@/server/database/connection";
import { verifyOwnerRegistrationContext } from "./registration-context";
import { resolveRegistrationOwner } from "@/server/setup/owner";

function createConfiguredAuth(config: RuntimeConfig) {
  const sql = createDatabaseClient(config.database, { max: config.database.webPoolSize });
  const db = drizzle(sql, { schema: authSchema });
  return betterAuth({
    appName: config.application.siteName,
    baseURL: config.application.publicUrl,
    basePath: "/api/auth",
    secret: config.auth.secret,
    trustedOrigins: [config.application.webAuthnOrigin],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchema,
      usePlural: true,
    }),
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: true,
          defaultValue: "viewer",
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: "account-vault",
      useSecureCookies: new URL(config.application.publicUrl).protocol === "https:",
      ipAddress: {
        ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
        ipv6Subnet: 64,
      },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
    },
    plugins: [
      passkey({
        rpID: config.application.webAuthnRpId,
        rpName: config.application.webAuthnRpName,
        origin: config.application.webAuthnOrigin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        registration: {
          requireSession: false,
          resolveUser: async ({ context }) => {
            if (!context) throw new Error("Owner registration context is required");
            const currentConfig = await readRuntimeConfig();
            if (currentConfig.setupState !== "creating_owner") {
              throw new Error("Passkey-first registration is closed");
            }
            const payload = verifyOwnerRegistrationContext(context, currentConfig);
            const owner = await resolveRegistrationOwner(payload.userId);
            return {
              id: owner.id,
              name: owner.email,
              displayName: owner.name,
            };
          },
          afterVerification: async ({ ctx, verification, user, context }) => {
            if (!verification.registrationInfo?.userVerified) {
              throw new Error("Passkey user verification is required");
            }
            const currentConfig = await readRuntimeConfig();
            if (currentConfig.setupState === "creating_owner") {
              if (!context) throw new Error("Owner registration context is required");
              const payload = verifyOwnerRegistrationContext(context, currentConfig);
              if (payload.userId !== user.id) {
                throw new Error("Owner registration context does not match the challenge");
              }
              const owner = await resolveRegistrationOwner(payload.userId);
              return { userId: owner.id };
            }
            const session = ctx.context.session;
            if (
              currentConfig.setupState !== "ready" ||
              !session?.user ||
              session.user.id !== user.id ||
              session.user.role !== "owner"
            ) {
              throw new Error("An owner session is required to register a Passkey");
            }
            return { userId: session.user.id };
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) {
              throw new Error("Passkey user verification is required");
            }
          },
        },
      }),
    ],
  });
}

type AuthInstance = ReturnType<typeof createConfiguredAuth>;
let cachedAuth: AuthInstance | undefined;
let cachedConfigCreatedAt: string | undefined;

export async function getAuth(): Promise<AuthInstance> {
  const config = await readRuntimeConfig();
  if (
    config.setupState !== "creating_owner" &&
    config.setupState !== "creating_vault" &&
    config.setupState !== "ready"
  ) {
    throw new Error("Authentication is unavailable before database initialization");
  }
  if (cachedAuth && cachedConfigCreatedAt === config.createdAt) return cachedAuth;

  const auth = createConfiguredAuth(config);
  cachedAuth = auth;
  cachedConfigCreatedAt = config.createdAt;
  return auth;
}
