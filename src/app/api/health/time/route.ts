import { noStoreJson } from "@/lib/http";

export function GET() {
  const unixMilliseconds = Date.now();
  return noStoreJson(
    { unixMilliseconds },
    { headers: { Date: new Date(unixMilliseconds).toUTCString() } },
  );
}
