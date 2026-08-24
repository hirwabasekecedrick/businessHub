"use client";

import { type ReactNode } from "react";
import { ShieldX } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Generic denial screen — deliberately says nothing about *which* permission
 * was required or checked (spec: users must only see an error indicating they
 * have no ability to access something).
 */
export function NoAccess() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <ShieldX className="size-10 text-destructive" />
        <div>
          <p className="font-semibold">No access</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            You don&apos;t have the ability to access this area.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

interface CanProps {
  /** Single permission or list where ANY match grants access. */
  perm: string | string[];
  fallback?: ReactNode;
  children: ReactNode;
}

export function Can({ perm, fallback = null, children }: CanProps) {
  const { can } = useAuth();
  const allowed = Array.isArray(perm)
    ? perm.some((p) => can(p))
    : can(perm);
  return <>{allowed ? children : fallback}</>;
}
