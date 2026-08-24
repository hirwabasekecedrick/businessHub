"use client";

import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  ClipboardCheck,
  FileText,
  FolderKanban,
  Gauge,
  Landmark,
  MessagesSquare,
  ShieldCheck,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const MODULES = [
  {
    icon: FolderKanban,
    title: "Requests & cases",
    text: "Company registrations, work permits and tax clearances become tracked cases with references, SLA due dates and a full status history.",
  },
  {
    icon: ClipboardCheck,
    title: "Approvals that flow",
    text: "Multi-level approval routing with delegation, escalation on deadline risk and a complete decision trail.",
  },
  {
    icon: FileText,
    title: "Document library",
    text: "Versioned uploads with antivirus gating, confidentiality veils, expiry reminders and single-use download links.",
  },
  {
    icon: Wallet,
    title: "Invoices & payments",
    text: "Draft-to-issued invoicing with gapless numbering, online payment intents, reconciliation and dunning reminders.",
  },
  {
    icon: BellRing,
    title: "Notifications",
    text: "In-app and email updates through your preferred channels, with quiet hours and digest delivery.",
  },
  {
    icon: Gauge,
    title: "Dashboards & reports",
    text: "KPI tiles, SLA queues and standard catalogue reports — exportable when you need the numbers offline.",
  },
  {
    icon: ShieldCheck,
    title: "Security by default",
    text: "Two-factor authentication for staff roles, single-use verification and reset links, session management and audit logs.",
  },
  {
    icon: MessagesSquare,
    title: "One hub for partners",
    text: "Partner organisations manage their own engagements, users and documents inside clearly scoped boundaries.",
  },
];

export default function FeaturesPage() {
  return (
    <main className="flex min-h-svh flex-1 flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-white p-1.5 shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
            </div>
            <span className="text-base font-semibold tracking-tight">
              BusinessHub
            </span>
          </Link>
          <Button size="sm">
            <Link href="/contact" className="flex items-center gap-1">
              Submit a request
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </div>
      </header>

      <section className="mx-auto w-full max-w-6xl px-6 py-16">
        <h1 className="max-w-2xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Everything a registration office runs on — in one platform.
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
          BusinessHub replaces spreadsheets, email threads and phone calls with
          tracked workflows your clients can see.
        </p>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <div
              key={m.title}
              className="flex flex-col gap-3 rounded-xl border bg-card p-6 shadow-sm"
            >
              <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <m.icon className="size-5" />
              </div>
              <p className="font-medium">{m.title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {m.text}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start gap-4 rounded-xl border bg-sidebar p-8 text-sidebar-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-lg font-semibold">Ready to get started?</p>
            <p className="mt-1 text-sm text-sidebar-accent-foreground">
              Create an account or send your first request — no commitment.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline">
              <Link href="/register">Create account</Link>
            </Button>
            <Button>
              <Link href="/contact">Contact us</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t py-8">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Landmark className="size-3.5" />
            BusinessHub · Afrisoft
          </span>
          <span>© {new Date().getFullYear()} All rights reserved.</span>
        </div>
      </footer>
    </main>
  );
}
