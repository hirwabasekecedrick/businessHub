"use client";

import type { ComponentType } from "react";
import type { NavSection } from "@/lib/nav";

import { visitorNav, clientNav, partnerNav, agentNav, managerNav, adminNav, superNav } from "./role-navs";
import {
  VisitorDashboard,
  VisitorHeaderActions,
} from "@/components/dashboard/visitor/dashboard";
import {
  ClientDashboard,
  ClientHeaderActions,
} from "@/components/dashboard/client/dashboard";
import {
  PartnerDashboard,
  PartnerHeaderActions,
} from "@/components/dashboard/partner/dashboard";
import {
  AgentDashboard,
  AgentHeaderActions,
} from "@/components/dashboard/agent/dashboard";
import {
  ManagerDashboard,
  ManagerHeaderActions,
} from "@/components/dashboard/manager/dashboard";
import {
  AdminDashboard,
  AdminHeaderActions,
} from "@/components/dashboard/admin/dashboard";
import {
  SuperDashboard,
  SuperHeaderActions,
} from "@/components/dashboard/super/dashboard";

export type RoleSlug =
  | "visitor"
  | "client"
  | "partner"
  | "agent"
  | "manager"
  | "admin"
  | "super";

export const ROLE_CODES: Record<RoleSlug, string> = {
  visitor: "Visitor",
  client: "Client",
  partner: "Partner",
  agent: "Agent",
  manager: "Manager",
  admin: "Admin",
  super: "Super",
};

const SLUG_BY_CODE = Object.fromEntries(
  Object.entries(ROLE_CODES).map(([slug, code]) => [code, slug]),
) as Record<string, RoleSlug>;

export function slugForRoleCode(code?: string | null): RoleSlug | null {
  return code ? (SLUG_BY_CODE[code] ?? null) : null;
}

export function isRoleSlug(v: string): v is RoleSlug {
  return v in ROLE_CODES;
}

export interface RoleChrome {
  nav: NavSection[];
  Dashboard: ComponentType;
  HeaderActions: ComponentType;
}

/* Each role folder owns its sidebar, header and dashboard components. */
const CHROME: Record<RoleSlug, RoleChrome> = {
  visitor: {
    nav: visitorNav,
    Dashboard: VisitorDashboard,
    HeaderActions: VisitorHeaderActions,
  },
  client: {
    nav: clientNav,
    Dashboard: ClientDashboard,
    HeaderActions: ClientHeaderActions,
  },
  partner: {
    nav: partnerNav,
    Dashboard: PartnerDashboard,
    HeaderActions: PartnerHeaderActions,
  },
  agent: {
    nav: agentNav,
    Dashboard: AgentDashboard,
    HeaderActions: AgentHeaderActions,
  },
  manager: {
    nav: managerNav,
    Dashboard: ManagerDashboard,
    HeaderActions: ManagerHeaderActions,
  },
  admin: {
    nav: adminNav,
    Dashboard: AdminDashboard,
    HeaderActions: AdminHeaderActions,
  },
  super: {
    nav: superNav,
    Dashboard: SuperDashboard,
    HeaderActions: SuperHeaderActions,
  },
};

export function chromeFor(slug: RoleSlug): RoleChrome {
  return CHROME[slug];
}
