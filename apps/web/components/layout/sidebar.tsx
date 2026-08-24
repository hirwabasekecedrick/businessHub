"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import type { NavSection } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useAuth } from "@/components/providers/auth-provider";
import { initialsOf } from "@/components/layout/app-shell";

export function BrandMark({
  collapsed,
  onClick,
}: {
  collapsed?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 rounded-md px-1 py-0.5 outline-none"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white p-1.5 shadow-lg shadow-primary/25">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
      </span>
      {!collapsed && (
        <span className="min-w-0 text-left">
          <span className="block truncate text-[15px] font-semibold leading-tight tracking-tight">
            BusinessHub
          </span>
          <span className="block truncate text-[11px] font-normal leading-tight text-sidebar-foreground/50">
            Operations console
          </span>
        </span>
      )}
    </button>
  );
}

export function SidebarNav({
  sections,
  collapsed,
}: {
  sections: NavSection[];
  collapsed?: boolean;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5 [scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]">
      {sections.map((section) => (
        <div key={section.title}>
          {!collapsed && (
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40">
              {section.title}
            </p>
          )}
          {collapsed && (
            <div
              aria-hidden
              className="mx-auto mb-3 h-px w-6 rounded-full bg-white/15"
            />
          )}
          <ul className="space-y-1">
            {section.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={`${item.href}-${item.label}`}>
                  <Link
                    href={item.href}
                    title={item.label}
                    className={cn(
                      "group relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
                      collapsed && "justify-center px-0",
                      active
                        ? "bg-white/[0.08] font-medium text-white"
                        : "text-sidebar-foreground/75 hover:bg-white/5 hover:text-white",
                    )}
                  >
                    {active && (
                      <span
                        aria-hidden
                        className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-sidebar-ring"
                      />
                    )}
                    <item.icon
                      className={cn(
                        "size-[18px] shrink-0 transition-colors",
                        active
                          ? "text-sidebar-ring"
                          : "text-sidebar-foreground/60 group-hover:text-sidebar-foreground",
                      )}
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function SidebarFooter({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { me, activeMembership } = useAuth();
  return (
    <div className="border-t border-sidebar-border/70 p-3">
      <div
        className={cn(
          "flex items-center gap-3",
          collapsed && "flex-col gap-2",
        )}
      >
        <span
          title={me ? `${me.firstName ?? ""} ${me.lastName ?? ""}`.trim() : undefined}
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/90 text-xs font-semibold text-sidebar-primary-foreground"
        >
          {me ? initialsOf(me) : "··"}
        </span>
        {!collapsed && me && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium leading-tight text-white">
              {[me.firstName, me.lastName].filter(Boolean).join(" ") || me.email}
            </span>
            <span className="block truncate text-[11px] leading-tight text-sidebar-foreground/50">
              {activeMembership?.roleName ?? ""}
            </span>
          </span>
        )}
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            collapsed && "mx-auto",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}

export function CollapsibleSidebar({
  sections,
  collapsed,
  onToggle,
}: {
  sections: NavSection[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out md:flex",
        collapsed ? "w-[4.5rem]" : "w-72",
      )}
    >
      <div
        className={cn(
          "flex h-16 shrink-0 items-center border-b border-sidebar-border/70",
          collapsed ? "justify-center px-2" : "justify-between px-4",
        )}
      >
        <BrandMark collapsed={collapsed} />
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            title="Collapse sidebar"
            className="rounded-md p-1.5 text-sidebar-foreground/50 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <PanelLeftClose className="size-4" />
          </button>
        )}
      </div>
      <SidebarNav sections={sections} collapsed={collapsed} />
      <SidebarFooter collapsed={collapsed} onToggle={onToggle} />
    </aside>
  );
}

/** Mobile slide-over version of the sidebar. */
export function MobileSidebar({
  sections,
  open,
  onClose,
}: {
  sections: NavSection[];
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        aria-label="Close menu"
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-sidebar text-sidebar-foreground shadow-2xl">
        <div className="flex h-16 shrink-0 items-center border-b border-sidebar-border/70 px-4">
          <BrandMark onClick={onClose} />
        </div>
        <div onClick={onClose} className="flex min-h-0 flex-1 flex-col">
          <SidebarNav sections={sections} />
        </div>
        <div className="border-t border-sidebar-border/70 p-3">
          <BrandMark collapsed onClick={onClose} />
        </div>
      </aside>
    </div>
  );
}

export type { NavSection };
