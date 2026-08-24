import {
  BarChart3,
  Bell,
  Building2,
  ClipboardCheck,
  FileStack,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ReceiptText,
  Settings2,
  Siren,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  /** Path segment relative to the role area, e.g. "" (home), "cases", "me". */
  href: string;
  label: string;
  icon: LucideIcon;
  /** Permission required to see this item (Super "*" always passes). */
  permission?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const DASHBOARD_HOME: NavItem = {
  href: "",
  label: "Overview",
  icon: LayoutDashboard,
};

export const casesNav: NavItem = {
  href: "cases",
  label: "Cases",
  icon: FolderKanban,
  permission: "case.read.org",
};

export const taskNav: NavItem = {
  href: "tasks",
  label: "My tasks",
  icon: ClipboardCheck,
  permission: "task.read",
};

export const approvalNav: NavItem = {
  href: "approvals",
  label: "Approvals",
  icon: FileText,
  permission: "approval.read",
};

export const financeNav: NavItem = {
  href: "invoices",
  label: "Finance",
  icon: ReceiptText,
  permission: "finance.read",
};

export const documentsNav: NavItem = {
  href: "documents",
  label: "Documents",
  icon: FileStack,
  permission: "document.read",
};

export const clientsNav: NavItem = {
  href: "clients",
  label: "Clients & partners",
  icon: Building2,
  permission: "crm.read",
};

export const escalationsNav: NavItem = {
  href: "escalations",
  label: "Escalations",
  icon: Siren,
  permission: "case.read.org",
};

export const adminNav: NavItem = {
  href: "admin",
  label: "Settings & admin",
  icon: Settings2,
  permission: "org.settings.manage",
};

export const reportsNav: NavItem = {
  href: "reports",
  label: "Reports",
  icon: BarChart3,
  permission: "report.read",
};

export const usersNav: NavItem = {
  href: "users",
  label: "Users & access",
  icon: Users,
  permission: "user.read",
};

export const notificationsNav: NavItem = {
  href: "notifications",
  label: "Notifications",
  icon: Bell,
  permission: "notification.read",
};
