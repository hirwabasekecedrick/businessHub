"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";

import { isApiError, useAuth } from "@/components/providers/auth-provider";
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

type Phase = "form" | "verify" | "done";

export default function RegisterPage() {
  const { status, register, verifyEmail } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [devHint, setDevHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (status === "authenticated") {
    router.replace("/dashboard");
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (phase === "form") {
        const res = await register(
          firstName.trim(),
          lastName.trim(),
          email.trim(),
          password,
        );
        if (res.devVerificationToken && !devHint) setDevHint(res.devVerificationToken);
        setPhase("verify");
      } else if (phase === "verify") {
        await verifyEmail(token.trim());
        setPhase("done");
      }
    } catch (err) {
      if (!isApiError(err)) throw err;
      switch (err.code) {
        case "EMAIL_TAKEN":
        case "CONFLICT":
          setError("An account with this email already exists.");
          break;
        case "VALIDATION_FAILED":
          setError("Check your details — password must be at least 8 characters.");
          break;
        case "INVALID_TOKEN":
          setError("That verification code is invalid or expired.");
          break;
        default:
          setError(err.message || "Something went wrong. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-sidebar p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-3 text-sidebar-foreground">
          <div className="flex size-10 items-center justify-center rounded-xl bg-sidebar-primary font-bold text-sidebar-primary-foreground">
            BH
          </div>
          <span className="text-lg font-semibold tracking-tight">BusinessHub</span>
        </div>

        <Card className="border-none shadow-lg">
          {phase === "form" && (
            <>
              <CardHeader className="gap-1">
                <CardTitle className="text-xl font-semibold">Create your account</CardTitle>
                <CardDescription>
                  Register to start submitting business registrations.
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
                <CardContent className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="firstName">First name</Label>
                    <Input
                      id="firstName"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="lastName">Last name</Label>
                    <Input
                      id="lastName"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2 sm:col-span-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2 sm:col-span-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                  <Button type="submit" size="lg" disabled={pending} className="sm:col-span-2 w-full">
                    {pending && <Loader2 className="animate-spin" />}
                    Create account
                  </Button>
                </CardContent>
              </form>
              <CardContent>
                <p className="text-center text-sm text-muted-foreground">
                  Already registered?{" "}
                  <Link href="/login" className="font-medium text-primary hover:underline">
                    Sign in
                  </Link>
                </p>
              </CardContent>
            </>
          )}

          {phase === "verify" && (
            <>
              <CardHeader className="gap-1">
                <CardTitle className="flex items-center gap-2 text-xl font-semibold">
                  <ShieldCheck className="size-5 text-primary" />
                  Verify your email
                </CardTitle>
                <CardDescription>
                  We sent a verification link to{" "}
                  <span className="font-medium text-foreground">{email}</span>. Paste the
                  token or code below to activate your account.
                </CardDescription>
              </CardHeader>
              {devHint && (
                <CardContent className="pb-0">
                  <Alert>
                    <AlertDescription className="break-all font-mono text-xs">
                      Dev mode token: {devHint}
                    </AlertDescription>
                  </Alert>
                </CardContent>
              )}
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
                    <Label htmlFor="token">Verification token</Label>
                    <Input
                      id="token"
                      autoFocus
                      placeholder="Paste the token from your email"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" size="lg" disabled={pending} className="w-full">
                    {pending && <Loader2 className="animate-spin" />}
                    Verify email
                  </Button>
                </CardContent>
              </form>
            </>
          )}

          {phase === "done" && (
            <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
              <CheckCircle2 className="size-12 text-primary" />
              <div>
                <p className="text-lg font-semibold">Email verified</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your account is active. You can sign in now.
                </p>
              </div>
              <Button size="lg" className="mt-2" onClick={() => router.push("/login")}>
                Go to sign in
              </Button>
            </CardContent>
          )}
        </Card>
      </div>
    </main>
  );
}
