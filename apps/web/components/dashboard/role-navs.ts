import type { NavSection } from "@/lib/nav";
import {
  DASHBOARD_HOME,
  adminNav as adminNavItem,
  approvalNav,
  casesNav,
  clientsNav,
  documentsNav,
  escalationsNav,
  financeNav,
  notificationsNav,
  reportsNav,
  taskNav,
  usersNav,
} from "@/lib/nav";

/* One sidebar definition per spec role (§16 seed). Items are additionally
   permission-filtered at render time, so e.g. Agent loses "Users & access"
   if their role ever drops user.read. */

export const visitorNav: NavSection[] = [
  { title: "General", items: [DASHBOARD_HOME, casesNav, notificationsNav] },
];

export const clientNav: NavSection[] = [
  { title: "General", items: [DASHBOARD_HOME, casesNav, documentsNav, notificationsNav] },
];

export const partnerNav: NavSection[] = [
  { title: "Engagements", items: [DASHBOARD_HOME, casesNav, documentsNav, notificationsNav] },
  { title: "Insights", items: [reportsNav] },
];

export const agentNav: NavSection[] = [
  { title: "Work", items: [DASHBOARD_HOME, casesNav, taskNav, approvalNav, documentsNav] },
  { title: "Organization", items: [clientsNav, reportsNav, notificationsNav] },
];

export const managerNav: NavSection[] = [
  { title: "Work", items: [DASHBOARD_HOME, casesNav, taskNav, approvalNav, documentsNav, escalationsNav, financeNav] },
  { title: "Manage", items: [usersNav, clientsNav, adminNavItem, reportsNav, notificationsNav] },
];

export const adminNav: NavSection[] = [
  { title: "Work", items: [DASHBOARD_HOME, casesNav, taskNav, approvalNav, documentsNav, escalationsNav, financeNav] },
  { title: "Administration", items: [usersNav, clientsNav, adminNavItem, reportsNav, notificationsNav] },
];

export const superNav: NavSection[] = adminNav;
