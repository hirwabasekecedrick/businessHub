"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Building2, LogOut } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";
import { BrandMark } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export default function AppAreaLayout({ children }: { children: ReactNode }) {
  const { status, me, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <div className="flex min-h-svh items-center justify-center gap-3 bg-background">
        <BrandMark />
        <Skeleton className="h-4 w-40" />
      </div>
    );
  }

  /* FR-1.5: every screen is organisation-scoped. A verified account with no
     membership yet has nothing to show — explain it instead of dead-ending
     on an RBAC screen. */
  if (me && me.memberships.length === 0) {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-sidebar p-6 text-sidebar-foreground">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-sidebar-primary text-sidebar-primary-foreground">
            <Building2 className="size-7" />
          </div>
          <h1 className="text-xl font-semibold">No organisation yet</h1>
          <p className="max-w-md text-sm leading-relaxed text-sidebar-accent-foreground">
            Your account is active, but it is not linked to any organisation.
            Ask an administrator to send you an invitation, or submit a
            request through the public form to get started.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => logout().then(() => router.replace("/login"))}
        >
          <LogOut />
          Sign out
        </Button>
      </main>
    );
  }

  return <>{children}</>;
}
