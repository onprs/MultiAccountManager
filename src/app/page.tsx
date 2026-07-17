import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getRuntimeStatus } from "@/runtime/status";
import { getAuth } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const runtime = await getRuntimeStatus();
  if (runtime.state !== "creating_vault" && runtime.state !== "ready") {
    redirect("/setup");
  }
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  redirect(session ? "/accounts" : "/login");
}
