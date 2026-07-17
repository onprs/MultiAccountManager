import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getRuntimeStatus } from "@/runtime/status";
import { getAuth } from "@/server/auth";
import { PasskeyLogin } from "@/components/auth/PasskeyLogin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "登录" };

export default async function LoginPage() {
  const runtime = await getRuntimeStatus();
  if (runtime.state !== "creating_vault" && runtime.state !== "ready") {
    redirect("/setup");
  }
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect("/accounts");
  return <PasskeyLogin />;
}
