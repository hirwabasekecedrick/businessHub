"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleDashed, Loader2, ShieldCheck, XCircle } from "lucide-react";

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

type Phase = "form" | "verify" | "verifying" | "done";

/** Mirrors the backend rule exactly: password_min_length_12. */
const MIN_PASSWORD_LENGTH = 12;

function PasswordRule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li
      className={`flex items-center gap-1.5 text-xs ${
        ok ? "text-emerald-600" : "text-muted-foreground"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="size-3.5 shrink-0" />
      ) : (
        <CircleDashed className="size-3.5 shrink-0" />
      )}
      {label}
    </li>
  );
}

export default function RegisterPage() {
  const { status, register, verifyEmail } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("form");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const autoVerifyRan = useRef(false);

  useEffect(() => { if (status === "authenticated") router.replace("/"); }, [status, router]);

  /* Verification emails link here with ?verify=<token>. Verify immediately so
     clicking the email link completes activation; the raw token also remains
     usable via the paste box as an alternative path. */
  useEffect(() => {
    if (autoVerifyRan.current) return;
    const q = new URLSearchParams(window.location.search);
    const v = q.get("verify");
    if (!v) return;
    autoVerifyRan.current = true;
    setToken(v);
    setPhase("verifying");
    verifyEmail(v)
      .then(() => {
        window.history.replaceState(null, "", "/register");
        setPhase("done");
      })
      .catch(() => {
        window.history.replaceState(null, "", "/register");
        setError("That verification link is invalid or expired — you can paste the token below instead.");
        setPhase("verify");
      });
  }, [verifyEmail]);

  const lengthOk = password.length >= MIN_PASSWORD_LENGTH;
  const matchOk = confirmPassword.length > 0 && password === confirmPassword;
  const formValid =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    /.+@.+\..+/.test(email.trim()) &&
    lengthOk &&
    matchOk;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (phase === "form") {
        await register(
          firstName.trim(),
          lastName.trim(),
          email.trim(),
          password,
        );
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
          setError("Password must be at least 12 characters.");
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
          <div className="flex size-10 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
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
                      placeholder={`${MIN_PASSWORD_LENGTH}+ characters`}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      minLength={MIN_PASSWORD_LENGTH}
                      required
                    />
                    <ul className="space-y-1 pt-1">
                      <PasswordRule
                        ok={lengthOk}
                        label={`At least ${MIN_PASSWORD_LENGTH} characters (${password.length}/${MIN_PASSWORD_LENGTH})`}
                      />
                      <PasswordRule ok={matchOk} label="Passwords match" />
                    </ul>
                  </div>
                  <div className="grid gap-2 sm:col-span-2">
                    <Label htmlFor="confirmPassword">Confirm password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Repeat your password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                    />
                    {confirmPassword.length > 0 && !matchOk && (
                      <p className="flex items-center gap-1.5 text-xs text-destructive">
                        <XCircle className="size-3.5" />
                        Passwords do not match yet.
                      </p>
                    )}
                  </div>
                  <Button
                    type="submit"
                    size="lg"
                    disabled={pending || !formValid}
                    className="w-full sm:col-span-2"
                  >
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

          {(phase === "verify" || phase === "verifying") && (
            <>
              <CardHeader className="gap-1">
                <CardTitle className="flex items-center gap-2 text-xl font-semibold">
                  <ShieldCheck className="size-5 text-primary" />
                  Verify your email
                </CardTitle>
                <CardDescription>
                  We sent a verification link to{" "}
                  <span className="font-medium text-foreground">{email || "your inbox"}</span>.
                  Open it to finish — or paste the code below.
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
                    <Label htmlFor="token">Verification token</Label>
                    <Input
                      id="token"
                      autoFocus
                      disabled={phase === "verifying"}
                      placeholder="Paste the token from your email"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" size="lg" disabled={pending || phase === "verifying"} className="w-full">
                    {pending || phase === "verifying" ? (
                      <Loader2 className="animate-spin" />
                    ) : null}
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
