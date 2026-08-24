"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleDashed,
  KeyRound,
  Loader2,
  XCircle,
} from "lucide-react";

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

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phase, setPhase] = useState<"form" | "done">("form");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const tokenPickedUp = useRef(false);

  /* Reset emails link here with ?token=<token>. */
  useEffect(() => {
    if (tokenPickedUp.current) return;
    const q = new URLSearchParams(window.location.search);
    const t = q.get("token");
    if (t) {
      tokenPickedUp.current = true;
      setToken(t);
      window.history.replaceState(null, "", "/reset-password");
    }
  }, []);

  const lengthOk = password.length >= MIN_PASSWORD_LENGTH;
  const matchOk = confirmPassword.length > 0 && password === confirmPassword;
  const formValid = token.trim().length > 0 && lengthOk && matchOk;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      await apiFetch("/auth/password/reset", {
        method: "POST",
        body: { token: token.trim(), password },
        auth: false,
      });
      setPhase("done");
    } catch (err) {
      if (!isApiError(err)) throw err;
      switch (err.code) {
        case "INVALID_TOKEN":
          setError(
            "That reset link is invalid or has already been used. Request a fresh one.",
          );
          break;
        case "VALIDATION_FAILED":
          setError(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters and not a commonly breached password.`,
          );
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
          <span className="text-lg font-semibold tracking-tight">
            BusinessHub
          </span>
        </div>

        <Card className="border-none shadow-lg">
          {phase === "form" ? (
            <>
              <CardHeader className="gap-1">
                <CardTitle className="flex items-center gap-2 text-xl font-semibold">
                  <KeyRound className="size-5 text-primary" />
                  Choose a new password
                </CardTitle>
                <CardDescription>
                  Paste the code from your reset email if it was not filled in
                  automatically. Saving signs you out of every other device.
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
                    <Label htmlFor="token">Reset code</Label>
                    <Input
                      id="token"
                      autoFocus={token.length === 0}
                      placeholder="Paste the code from your email"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">New password</Label>
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
                      <PasswordRule
                        ok={matchOk}
                        label="Passwords match"
                      />
                    </ul>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="confirmPassword">Confirm new password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Repeat your new password"
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
                    className="w-full"
                  >
                    {pending && <Loader2 className="animate-spin" />}
                    Update password
                  </Button>
                </CardContent>
              </form>
              <CardContent>
                <p className="text-center text-sm text-muted-foreground">
                  Did not get an email?{" "}
                  <Link
                    href="/forgot-password"
                    className="font-medium text-primary hover:underline"
                  >
                    Request a new link
                  </Link>
                </p>
              </CardContent>
            </>
          ) : (
            <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
              <CheckCircle2 className="size-12 text-primary" />
              <div>
                <p className="text-lg font-semibold">Password updated</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  All previous sessions were signed out for safety. Sign in
                  with your new password.
                </p>
              </div>
              <Button
                size="lg"
                className="mt-2"
                onClick={() => router.push("/login")}
              >
                Go to sign in
              </Button>
            </CardContent>
          )}
        </Card>
      </div>
    </main>
  );
}
