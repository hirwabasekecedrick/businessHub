"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

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
import { Separator } from "@/components/ui/separator";

const DEMO_ACCOUNTS = [
  ["visitor@demo.test", "Visitor"],
  ["client@acme.test", "Client (Acme)"],
  ["partner@consulting.test", "Partner"],
  ["agent@hub.test", "Agent"],
  ["manager@hub.test", "Manager"],
  ["admin@hub.test", "Admin"],
  ["super@hub.test", "Super"],
];

export default function LoginPage() {
  const { status, login, verifyMfa } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [status, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (step === "credentials") {
        const res = await login(email.trim(), password);
        if (res.mfaRequired) {
          setChallengeId(res.challengeId);
          setStep("mfa");
        } else {
          router.replace("/dashboard");
        }
      } else if (challengeId) {
        await verifyMfa(challengeId, code.trim());
        router.replace("/dashboard");
      }
    } catch (err) {
      if (!isApiError(err)) throw err;
      switch (err.code) {
        case "MFA_REQUIRED":
          setChallengeId(
            typeof err.data === "object" &&
              err.data !== null &&
              "challengeId" in err.data
              ? String((err.data as { challengeId: string }).challengeId)
              : null,
          );
          setStep("mfa");
          break;
        case "AUTH_INVALID_CREDENTIALS":
          setError("Incorrect email or password.");
          break;
        case "MFA_CODE_INVALID":
          setError(useRecovery ? "Invalid recovery code." : "Invalid or expired code.");
          break;
        case "MFA_CHALLENGE_INVALID":
          setError("This verification request expired. Please sign in again.");
          setStep("credentials");
          setPassword("");
          setCode("");
          break;
        case "ACCOUNT_LOCKED":
        case "USER_DISABLED":
          setError("Your account is locked. Contact an administrator.");
          break;
        default:
          setError(err.message || "Sign-in failed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-1">
      <aside className="hidden w-[42%] flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-sidebar-primary font-bold text-sidebar-primary-foreground">
            BH
          </div>
          <span className="text-lg font-semibold tracking-tight">
            BusinessHub
          </span>
        </div>
        <div className="space-y-4">
          <h1 className="max-w-md text-3xl font-semibold leading-snug text-white">
            One hub for registrations, cases and compliance.
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-sidebar-accent-foreground">
            Submit company registrations, track approvals through every level,
            manage documents, invoices and SLA deadlines — all under one
            permission-controlled roof.
          </p>
        </div>
        <p className="text-xs text-sidebar-accent-foreground/70">
          © {new Date().getFullYear()} Afrisoft · BusinessHub
        </p>
      </aside>

      <section className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <Card className="w-full max-w-sm border-none shadow-lg">
          <CardHeader className="gap-1">
            <CardTitle className="text-xl font-semibold">
              {step === "credentials" ? "Sign in" : "Two-factor required"}
            </CardTitle>
            <CardDescription>
              {step === "credentials"
                ? "Enter your credentials to access the hub."
                : useRecovery
                  ? "Enter one of your recovery codes."
                  : "Enter the 6-digit code from your authenticator app."}
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
              {step === "credentials" ? (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      placeholder="you@company.test"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="code">
                      {useRecovery ? "Recovery code" : "Authenticator code"}
                    </Label>
                    <Input
                      id="code"
                      inputMode={useRecovery ? "text" : "numeric"}
                      autoComplete={useRecovery ? "off" : "one-time-code"}
                      placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
                      autoFocus
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                    />
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="self-start px-0"
                    onClick={() => {
                      setUseRecovery((v) => !v);
                      setCode("");
                    }}
                  >
                    {useRecovery
                      ? "Use authenticator code instead"
                      : "Use a recovery code instead"}
                  </Button>
                </>
              )}
              <Button type="submit" size="lg" disabled={pending} className="w-full">
                {pending && <Loader2 className="animate-spin" />}
                {step === "credentials" ? "Continue" : "Verify"}
              </Button>
            </CardContent>
          </form>

          <CardContent>
            <div className="relative my-1">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs uppercase tracking-wide text-muted-foreground">
                or
              </span>
            </div>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              No account yet?{" "}
              <Link href="/register" className="font-medium text-primary hover:underline">
                Create one
              </Link>
            </p>
          </CardContent>
        </Card>
      </section>

      <details className="fixed bottom-4 right-4 z-10 max-w-xs rounded-lg border bg-card p-3 text-xs shadow-md open:pb-4">
        <summary className="cursor-pointer select-none font-medium text-foreground">
          Demo accounts
        </summary>
        <ul className="mt-2 space-y-1 text-muted-foreground">
          {DEMO_ACCOUNTS.map(([mail, role]) => (
            <li key={mail} className="flex items-center justify-between gap-2">
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 hover:text-primary"
                onClick={() => {
                  setEmail(mail);
                  setPassword("Password123!");
                  setStep("credentials");
                }}
              >
                {mail}
              </button>
              <span className="shrink-0">{role}</span>
            </li>
          ))}
          <li className="pt-1 text-muted-foreground/80">
            Password for all: <code>Password123!</code>
          </li>
        </ul>
      </details>
    </main>
  );
}
