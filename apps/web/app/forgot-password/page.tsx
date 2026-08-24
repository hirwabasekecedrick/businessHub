"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Loader2, MailQuestion } from "lucide-react";

import { isApiError } from "@/components/providers/auth-provider";
import { apiFetch } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<"form" | "sent">("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      /* The endpoint answers identically whether or not the address exists —
         no enumeration (US-1.1). */
      await apiFetch("/auth/password/forgot", {
        method: "POST",
        body: { email: email.trim() },
        auth: false,
      });
      setPhase("sent");
    } catch (err) {
      if (!isApiError(err)) throw err;
      setError(err.message || "Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-sidebar p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3 text-sidebar-foreground">
          <div className="flex size-10 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            BusinessHub
          </span>
        </div>

        <Card className="border-none shadow-lg">
          {phase === "form" ? (
            <>
              <CardHeader className="gap-1">
                <div className="flex items-center gap-2">
                  <Link
                    href="/login"
                    aria-label="Back to sign in"
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <ArrowLeft className="size-4" />
                  </Link>
                  <CardTitle className="flex items-center gap-2 text-xl font-semibold">
                    <MailQuestion className="size-5 text-primary" />
                    Forgot your password?
                  </CardTitle>
                </div>
                <CardDescription>
                  Enter the your email
                </CardDescription>
              </CardHeader>
              {error && (
                <CardContent className="pb-0">
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                </CardContent>
              )}
              <form onSubmit={onSubmit}>
                <CardContent className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      autoFocus
                      placeholder="you@company.test"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={pending}
                    className="w-full"
                  >
                    {pending && <Loader2 className="animate-spin" />}
                    Send reset link
                  </Button>
                </CardContent>
              </form>
              <CardContent>
                <p className="flex items-center justify-between text-sm text-muted-foreground">
                  <Link
                    href="/login"
                    className="flex items-center gap-1 font-medium text-primary hover:underline"
                  >
                    <ArrowLeft className="size-3.5" />
                    Back to sign in
                  </Link>
                  <Link
                    href="/register"
                    className="font-medium text-primary hover:underline"
                  >
                    Create an account
                  </Link>
                </p>
              </CardContent>
            </>
          ) : (
            <>
              <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
                <CheckCircle2 className="size-12 text-primary" />
                <div>
                  <p className="text-lg font-semibold">Check your inbox</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    If an account exists for{" "}
                    <span className="font-medium text-foreground">{email}</span>
                    , a reset link is on its way. The link works once and
                    expires in one hour.
                  </p>
                </div>
                <Button
                  size="lg"
                  variant="outline"
                  className="mt-2"
                  onClick={() => window.location.assign("/login")}
                >
                  <ArrowLeft className="size-4" />
                  Back to sign in
                </Button>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
