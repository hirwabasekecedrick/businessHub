"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  apiFetch,
  clearTokens,
  getActiveOrgId,
  getTokens,
  setActiveOrgId,
  setTokens,
} from "@/lib/api";
import type { Me, Membership } from "@/lib/auth-types";

type AuthStatus = "loading" | "unauthenticated" | "authenticated";

interface LoginSuccess {
  mfaRequired?: false;
}
interface MfaChallengeResponse {
  mfaRequired: true;
  challengeId: string;
}

interface RegisterResult {
  message?: string;
  devVerificationToken?: string;
}

export interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  activeOrgId: string | null;
  activeMembership: Membership | null;
  login: (
    email: string,
    password: string,
  ) => Promise<LoginSuccess | MfaChallengeResponse>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
  register: (
    firstName: string,
    lastName: string,
    email: string,
    password: string,
  ) => Promise<RegisterResult>;
  verifyEmail: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  switchOrganization: (organizationId: string) => void;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [activeOrgId, setLocalActiveOrgId] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    const profile = await apiFetch<Me>("/auth/me");
    setMe(profile);
    setStatus("authenticated");
    const stored = getActiveOrgId();
    const valid =
      stored && profile.memberships.some((m) => m.organizationId === stored)
        ? stored
        : (profile.memberships.find((m) => m.isDefault)?.organizationId ??
          profile.memberships[0]?.organizationId ??
          null);
    setLocalActiveOrgId(valid);
    if (valid !== stored) setActiveOrgId(valid);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!getTokens()) throw new Error("no tokens");
        await loadMe();
      } catch {
        if (!cancelled) {
          clearTokens();
          setStatus("unauthenticated");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMe]);

  const adoptSession = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      setTokens(tokens);
      await loadMe();
    },
    [loadMe],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await apiFetch<
        LoginSuccess & Partial<MfaChallengeResponse>
      >("/auth/login", {
        method: "POST",
        body: { email, password },
        auth: false,
      });
      if ("mfaRequired" in res && res.mfaRequired) {
        return res as MfaChallengeResponse;
      }
      const tokens = res as unknown as {
        accessToken: string;
        refreshToken: string;
      };
      await adoptSession(tokens);
      return { mfaRequired: false as const };
    },
    [adoptSession],
  );

  const verifyMfa = useCallback(
    async (challengeId: string, code: string) => {
      const res = await apiFetch<{
        accessToken: string;
        refreshToken: string;
      }>("/auth/mfa/verify", {
        method: "POST",
        body: { challengeId, code },
        auth: false,
      });
      await adoptSession(res);
    },
    [adoptSession],
  );

  const register = useCallback(
    async (firstName: string, lastName: string, email: string, password: string) => {
      return apiFetch<RegisterResult>("/auth/register", {
        method: "POST",
        body: { firstName, lastName, email, password },
        auth: false,
      });
    },
    [],
  );

  const verifyEmail = useCallback(async (token: string) => {
    await apiFetch<{ message: string }>("/auth/verify-email", {
      method: "POST",
      body: { token },
      auth: false,
    });
  }, []);

  const logout = useCallback(async () => {
    const tokens = getTokens();
    try {
      if (tokens?.refreshToken) {
        await apiFetch<{ message: string }>("/auth/logout", {
          method: "POST",
          body: { refreshToken: tokens.refreshToken },
        });
      }
    } catch {
      // best effort — clear locally regardless
    }
    clearTokens();
    setActiveOrgId(null);
    setMe(null);
    setLocalActiveOrgId(null);
    setStatus("unauthenticated");
  }, []);

  const switchOrganization = useCallback(
    (organizationId: string) => {
      setActiveOrgId(organizationId);
      setLocalActiveOrgId(organizationId);
    },
    [],
  );

  const activeMembership = useMemo(
    () =>
      me?.memberships.find((m) => m.organizationId === activeOrgId) ?? null,
    [me, activeOrgId],
  );

  const can = useCallback(
    (permission: string) =>
      !!activeMembership?.permissions.includes(permission),
    [activeMembership],
  );

  const value = useMemo(
    () => ({
      status,
      me,
      activeOrgId,
      activeMembership,
      login,
      verifyMfa,
      register,
      verifyEmail,
      logout,
      switchOrganization,
      can,
    }),
    [
      status,
      me,
      activeOrgId,
      activeMembership,
      login,
      verifyMfa,
      register,
      verifyEmail,
      logout,
      switchOrganization,
      can,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
