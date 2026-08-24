"use client";

import { use, useEffect, useMemo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import { chromeFor, isRoleSlug, slugForRoleCode } from "@/components/dashboard/registry";
import { AppShell } from "@/components/layout/app-shell";
import { NoAccess } from "@/components/rbac/can";
import { useAuth } from "@/components/providers/auth-provider";

export default function RoleLayout({
  children,
  params,
}: LayoutProps<"/[role]">) {
  const { role } = use(params);
  const { status, activeMembership, can } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status !== "authenticated") return;
    if (!isRoleSlug(role)) {
      const own = slugForRoleCode(activeMembership?.roleCode);
      router.replace(own ? `/${own}` : "/login");
    }
  }, [status, role, activeMembership?.roleCode, router]);

  const chrome = useMemo(
    () => (isRoleSlug(role) ? chromeFor(role) : null),
    [role],
  );

  /* Resolve role-relative hrefs ("", "cases", …) to absolute paths and drop
     items the active membership cannot open — users never even see links
     they cannot use. */
  const sections = useMemo(() => {
    if (!chrome) return [];
    return chrome.nav
      .map((s) => ({
        ...s,
        items: s.items
          .filter((i) => !i.permission || can(i.permission))
          .map((i) => ({ ...i, href: i.href ? `/${role}/${i.href}` : `/${role}` })),
      }))
      .filter((s) => s.items.length > 0);
  }, [chrome, can, role]);

  const title = useMemo(() => {
    for (const s of sections) {
      const hit = s.items.find((i) => pathname === i.href);
      if (hit) return hit.label;
    }
    if (/\/me$/.test(pathname)) return "Profile";
    if (/\/cases\/[^/]+$/.test(pathname)) return "Case detail";
    const seg = pathname.split("/").filter(Boolean).pop();
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "Overview";
  }, [sections, pathname]);

  if (status !== "authenticated" || !chrome) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <span className="text-sm text-muted-foreground">Loading…</span>
      </div>
    );
  }

  /* RBAC on the folder itself: only the area matching your role opens;
     Super ("*") may inspect every area. Others get a plain no-access screen. */
  const isSuper = can("*");
  const ownSlug = slugForRoleCode(activeMembership?.roleCode);
  if (!isSuper && ownSlug !== role) return <NoAccess />;

  return (
    <AppShell
      sections={sections}
      basePath={`/${role}`}
      headerActions={<chrome.HeaderActions />}
      title={title}
    >
      {children}
    </AppShell>
  );
}
