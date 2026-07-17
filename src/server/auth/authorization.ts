import { getAuth } from "@/server/auth";

export type OwnerSession = {
  sessionId: string;
  userId: string;
  name: string;
};

export async function getOwnerSession(request: Request): Promise<OwnerSession | null> {
  const auth = await getAuth();
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result || result.user.role !== "owner") return null;
  return {
    sessionId: result.session.id,
    userId: result.user.id,
    name: result.user.name,
  };
}
