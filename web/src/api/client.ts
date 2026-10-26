import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

// Typed client generated from api/openapi.yaml (see `npm run openapi`).
// Cookies carry the session; the server validates Origin on mutations.
export const api = createClient<paths>({ baseUrl: "/", credentials: "same-origin" });

export type User = components["schemas"]["User"];
export type Org = components["schemas"]["Org"];
export type Me = components["schemas"]["Me"];
export type APIKey = components["schemas"]["APIKey"];
export type APIKeyCreated = components["schemas"]["APIKeyCreated"];
export type Role = components["schemas"]["Role"];
export type Scope = components["schemas"]["Scope"];
export type ApiError = components["schemas"]["Error"];

/** Extracts a human-readable message from an error body. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err && typeof err === "object" && "error" in err) {
    const e = (err as ApiError).error;
    if (e?.message) return e.message;
  }
  if (err instanceof Error) return err.message;
  return fallback;
}

export const ROLES: Role[] = ["admin", "member", "viewer"];
export const SCOPES: Scope[] = ["ingest", "read", "write"];
