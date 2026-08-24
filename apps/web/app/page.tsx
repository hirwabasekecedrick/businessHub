"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { slugForRoleCode } from "@/components/dashboard/registry";
import { useAuth } from "@/components/providers/auth-provider";

/**
 * No public landing page: "/" always redirects — to the signed-in user's
 * workspace, or to /login for everyone else. Deviates from spec §12.1
 * (which specced "/" as a public marketing entry point) per explicit
 * product direction: login is the first thing a visitor should see.
 */
export default function HomePage() {
  const { status, me } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated" && me) {
      const membership =
        me.memberships.find((m) => m.isDefault) ?? me.memberships[0];
      const slug = slugForRoleCode(membership?.roleCode) ?? "visitor";
      router.replace(`/${slug}`);
    } else if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, me, router]);

  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-3 bg-sidebar text-sidebar-primary-foreground">
      <div className="flex size-12 items-center justify-center rounded-xl bg-white p-2 shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
      </div>
      <p className="text-sm tracking-wide text-sidebar-accent-foreground">
        BusinessHub
      </p>
      <Loader2 className="size-4 animate-spin text-[#7692FF]" />
    </main>
  );
}
