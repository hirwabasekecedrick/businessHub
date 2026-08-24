import type { Tokens } from "@/lib/auth-types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:2020/v1";

const TOKENS_KEY = "businesshub.tokens";
const ORG_KEY = "businesshub.org";

export function getTokens(): Tokens | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function setTokens(tokens: Tokens) {
  window.localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function clearTokens() {
  window.localStorage.removeItem(TOKENS_KEY);
}

export function getActiveOrgId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ORG_KEY);
}

export function setActiveOrgId(orgId: string | null) {
  if (orgId) window.localStorage.setItem(ORG_KEY, orgId);
  else window.localStorage.removeItem(ORG_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;
  data: unknown;

  constructor(status: number, data: unknown) {
    const payload =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    super(
      typeof payload.message === "string"
        ? payload.message
        : `Request failed (${status})`,
    );
    this.name = "ApiError";
    this.status = status;
    this.code = typeof payload.code === "string" ? payload.code : undefined;
    this.data = data;
  }
}

interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const tokens = getTokens();
      if (!tokens?.refreshToken) return false;
      try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        });
        if (!res.ok) return false;
        const next = (await res.json()) as Partial<Tokens>;
        if (!next.accessToken || !next.refreshToken) return false;
        setTokens({ accessToken: next.accessToken, refreshToken: next.refreshToken });
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiFetch<T>(
  path: string,
  { method = "GET", body, auth = true }: ApiFetchOptions = {},
): Promise<T> {  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth) {
    const tokens = getTokens();
    if (tokens?.accessToken) headers.Authorization = `Bearer ${tokens.accessToken}`;
    const orgId = getActiveOrgId();
    if (orgId) headers["x-organization-id"] = orgId;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth && !path.startsWith("/auth/")) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      return apiFetch<T>(path, { method, body, auth });
    }
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** URL for an EventSource — auth travels as ?token= since SSE cannot set headers. */
export function sseUrl(path: string): string | null {
  if (typeof window === "undefined") return null;
  const tokens = getTokens();
  if (!tokens?.accessToken) return null;
  const params = new URLSearchParams({ token: tokens.accessToken });
  return `${API_URL}${path}?${params.toString()}`;
}

/* ----------------------------- impersonation ------------------------------ */

const IMP_KEY = "businesshub.impersonation";

export function beginImpersonation(impersonationToken: string) {
  const backup = getTokens();
  window.localStorage.setItem(IMP_KEY, JSON.stringify(backup));
  setTokens({ accessToken: impersonationToken, refreshToken: "" });
}

export function isImpersonating(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(IMP_KEY) !== null;
}

/** Restores the super-admin session. Call the audit endpoint BEFORE this. */
export function stopImpersonation() {
  const raw = window.localStorage.getItem(IMP_KEY);
  if (!raw) return;
  try {
    const backup = JSON.parse(raw) as Tokens | null;
    if (backup?.accessToken && backup?.refreshToken) setTokens(backup);
    else clearTokens();
  } catch {
    clearTokens();
  }
  window.localStorage.removeItem(IMP_KEY);
}
