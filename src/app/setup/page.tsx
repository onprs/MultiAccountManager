import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getRuntimeStatus } from "@/runtime/status";
import { SetupWizard } from "@/components/setup/SetupWizard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "系统初始化",
};

export default async function SetupPage() {
  const status = await getRuntimeStatus();
  if (status.state === "creating_vault" || status.state === "ready") {
    redirect("/login");
  }
  return <SetupWizard initialState={status.state} />;
}
