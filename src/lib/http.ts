import { NextResponse } from "next/server";

export type ApiErrorBody = {
  code: string;
  message: string;
  requestId: string;
};

export function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function noStoreJson<T>(body: T, init: ResponseInit = {}): NextResponse<T> {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  return NextResponse.json(body, { ...init, headers });
}

export function apiError(
  request: Request,
  status: number,
  code: string,
  message: string,
): NextResponse<ApiErrorBody> {
  return noStoreJson(
    { code, message, requestId: requestId(request) },
    { status },
  );
}
