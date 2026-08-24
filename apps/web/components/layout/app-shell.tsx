"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bell,
  BellOff,
  ChevronsUpDown,
  LogOut,
  Menu,
  VenetianMask,
} from "lucide-react";

import type { NavSection } from "@/lib/nav";
import {
  apiFetch,
  isImpersonating,
  sseUrl,
  stopImpersonation,
} from "@/lib/api";
import { useAuth } from "@/components/providers/auth-provider";
import {
  BrandMark,
  CollapsibleSidebar,
  MobileSidebar,
  SidebarNav,
} from "@/components/layout/sidebar";
import { useNotifications } from "@/components/dashboard/shared/widgets";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STORAGE_KEY = "bh.sidebar.collapsed";

function useSidebarState() {
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(STORAGE_KEY) === "true",
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const toggle = () =>
    setCollapsed((v) => {
      window.localStorage.setItem(STORAGE_KEY, String(!v));
      return !v;
    });
  return { collapsed, toggle, mobileOpen, setMobileOpen };
}

/* ------------------------------- org switcher ------------------------------ */

function OrgSwitcher() {
  const { me, activeOrgId, activeMembership, switchOrganization } = useAuth();
  if (!me || me.memberships.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="gap-2">
            <span className="max-w-[10rem] truncate">
              {activeMembership?.legalName ?? "Select organization"}
            </span>
            <ChevronsUpDown className="size-3.5 opacity-60" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {me.memberships.map((m) => (
            <DropdownMenuItem
              key={m.organizationId}
              onClick={() => switchOrganization(m.organizationId)}
              className="flex-col items-start gap-0.5"
            >
              <span className="font-medium">
                {m.legalName}
                {m.organizationId === activeOrgId ? " ✓" : ""}
              </span>
              <span className="text-xs text-muted-foreground">{m.roleName}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------- user menu -------------------------------- */

export { initialsOf } from "@/lib/utils";
import { initialsOf } from "@/lib/utils";

function UserMenu({ basePath }: { basePath: string }) {
  const { me, logout } = useAuth();
  const router = useRouter();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Avatar className="size-8">
              <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                {initialsOf(me)}
              </AvatarFallback>
            </Avatar>
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <div className="text-sm font-medium">
              {me.firstName} {me.lastName}
            </div>
            <div className="text-xs font-normal text-muted-foreground">
              {me.email}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push(`${basePath}/me`)}>
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => void logout().then(() => router.replace("/login"))}
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------ notifications ------------------------------ */

/** FR-7.7: live badge + toasts over server-sent events. */
function useNotificationStream() {
  const qc = useQueryClient();
  useEffect(() => {
    const url = sseUrl("/notifications/stream");
    if (!url) return;
    const es = new EventSource(url);
    es.addEventListener("notification", (e) => {
      try {
        const n = JSON.parse((e as MessageEvent).data) as { subject?: string; templateCode: string };
        toast.info(n.subject ?? n.templateCode);
      } catch {
        /* ignore malformed frame */
      }
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    });
    es.addEventListener("unread", () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    });
    return () => es.close();
  }, [qc]);
}

function BellMenu({ basePath }: { basePath: string }) {
  const qc = useQueryClient();
  const { data } = useNotifications(true);
  const count = data?.length ?? 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="icon" className="relative">
            <Bell />
            {count > 0 && (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
                {count > 9 ? "9+" : count}
              </span>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Unread</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {count === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Nothing unread.
            </p>
          )}
          {data?.slice(0, 5).map((n) => (
            <DropdownMenuItem
              key={n.id}
              className="flex-col items-start gap-0.5"
              onClick={() =>
                apiFetch(`/notifications/${n.id}/read`, { method: "POST", body: {} }).then(
                  () => qc.invalidateQueries({ queryKey: ["notifications"] }),
                )
              }
            >
              <span className="w-full truncate text-sm font-medium">
                {n.subject ?? n.templateCode}
              </span>
              <span className="w-full truncate text-xs font-normal text-muted-foreground">
                {n.body ?? ""}
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={count === 0}
            onClick={() =>
              apiFetch("/notifications/read-all", { method: "POST", body: {} }).then(() =>
                qc.invalidateQueries({ queryKey: ["notifications"] }),
              )
            }
          >
            <BellOff />
            Mark all read
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => (window.location.href = `${basePath}/notifications`)}>
            View all notifications
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------ impersonation ----------------------------- */

function ImpersonationBanner() {
  const { me } = useAuth();
  const [active, setActive] = useState(false);

  useEffect(() => {
    setActive(isImpersonating());
  }, [me?.id]);

  if (!active) return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
      <VenetianMask className="size-4" />
      You are impersonating a user — actions are read-only and audited.
      <button
        type="button"
        className="rounded-md bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-50 hover:bg-amber-900"
        onClick={() => {
          void apiFetch("/admin/impersonate/stop", { method: "POST", body: {} }).catch(() => {});
          stopImpersonation();
          window.location.assign("/");
        }}
      >
        Stop impersonating
      </button>
    </div>
  );
}

/* ---------------------------------- shell ---------------------------------- */

export function AppShell({
  sections,
  headerActions,
  title,
  basePath,
  children,
}: {
  sections: NavSection[];
  headerActions?: ReactNode;
  title: string;
  basePath: string;
  children: ReactNode;
}) {
  const { collapsed, toggle, mobileOpen, setMobileOpen } = useSidebarState();
  useNotificationStream();

  return (
    <div className="flex min-h-svh bg-background">
      <CollapsibleSidebar
        sections={sections}
        collapsed={collapsed}
        onToggle={toggle}
      />
      <MobileSidebar
        sections={sections}
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <ImpersonationBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card px-3 sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <Menu />
          </Button>
          <h1 className="truncate text-sm font-semibold tracking-tight sm:text-base">
            {title}
          </h1>
          <div className="ml-auto flex items-center gap-2">
            {headerActions}
            <BellMenu basePath={basePath} />
            <OrgSwitcher />
            <UserMenu basePath={basePath} />
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
