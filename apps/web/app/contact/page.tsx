"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Send } from "lucide-react";

import { ApiError, apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REQUEST_TYPES = [
  { value: "COMPANY_REG", label: "Company registration" },
  { value: "TAX_CLEARANCE", label: "Tax clearance" },
  { value: "WORK_PERMIT", label: "Work permit" },
  { value: "OTHER", label: "Something else" },
];

export default function ContactPage() {
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    organizationName: "",
    requestType: "COMPANY_REG",
    message: "",
    website: "", // honeypot
  });
  const [reference, setReference] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<{ reference?: string }>("/public/requests", {
        method: "POST",
        auth: false,
        body: form,
      });
      setReference(res.reference ?? "—");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Submission failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Request a service</CardTitle>
          <CardDescription>
            Tell us what you need — our team gets back to you with a tracked
            case reference. No account required.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reference ? (
            <div className="space-y-3 text-sm">
              <p className="font-medium">Request received.</p>
              <p className="text-muted-foreground">
                Your reference is{" "}
                <span className="font-mono font-semibold text-foreground">
                  {reference}
                </span>
                . Keep it handy — we will email you updates.
              </p>
              <Button size="sm" variant="outline" onClick={() => setReference(null)}>
                Submit another request
              </Button>
            </div>
          ) : (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="fn">First name</Label>
                  <Input id="fn" value={form.firstName} onChange={set("firstName")} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ln">Last name</Label>
                  <Input id="ln" value={form.lastName} onChange={set("lastName")} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="em">Email</Label>
                <Input id="em" type="email" value={form.email} onChange={set("email")} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="ph">Phone (optional)</Label>
                  <Input id="ph" value={form.phone} onChange={set("phone")} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="org">Organization (optional)</Label>
                  <Input id="org" value={form.organizationName} onChange={set("organizationName")} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rt">What do you need?</Label>
                <select
                  id="rt"
                  value={form.requestType}
                  onChange={set("requestType")}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  {REQUEST_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="msg">Message</Label>
                <textarea
                  id="msg"
                  rows={4}
                  value={form.message}
                  onChange={set("message")}
                  className="rounded-md border bg-background p-3 text-sm"
                />
              </div>
              <input
                type="text"
                name="website"
                tabIndex={-1}
                autoComplete="off"
                value={form.website}
                onChange={set("website")}
                className="hidden"
                aria-hidden="true"
              />
              <Button disabled={busy} onClick={() => void submit()}>
                <Send />
                {busy ? "Sending…" : "Send request"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Already a client?{" "}
                <Link href="/login" className="underline underline-offset-2">
                  Sign in
                </Link>
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
