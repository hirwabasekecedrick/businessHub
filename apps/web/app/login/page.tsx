"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Loader2, MailCheck, ShieldAlert } from "lucide-react";
import QRCode from "qrcode";

import { isApiError, useAuth } from "@/components/providers/auth-provider";
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
import { Separator } from "@/components/ui/separator";

const DEMO_ACCOUNTS = [
  ["visitor@demo.test", "Visitor"],
  ["client@acme.test", "Client (Acme)"],
  ["partner@consulting.test", "Partner"],
  ["agent@hub.test", "Agent"],
  ["manager@hub.test", "Manager"],
  ["doghan80@gmail.com", "Admin"],
  ["super@hub.test", "Super"],
];

export default function LoginPage() {
  const {
    status,
    login,
    verifyMfa,
    enrolMfaChallenge,
    completeMfaEnrolmentChallenge,
  } = useAuth();
  const router = useRouter();

  const [step, setStep] = useState<
    "credentials" | "mfa" | "enrol" | "enrol-codes"
  >("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [provisioning, setProvisioning] = useState<{
    uri: string;
    secret: string;
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /* US-1.1: unverified accounts get a one-click "resend verification email" option. */
  const [unverified, setUnverified] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">(
    "idle",
  );

  useEffect(() => {
    /* Hold the user on the recovery-codes screen — the codes are shown
       exactly once and must not be skipped (spec US-1.2). */
    if (status === "authenticated" && step !== "enrol-codes")
      router.replace("/");
  }, [status, router, step]);

  /* Fetch provisioning data + QR when the forced-enrolment step opens. */
  useEffect(() => {
    if (step !== "enrol" || !challengeId) return;
    let cancelled = false;
    enrolMfaChallenge(challengeId)
      .then(async ({ uri, secret }) => {
        if (cancelled) return;
        setProvisioning({ uri, secret });
        setQrDataUrl(
          await QRCode.toDataURL(uri, { margin: 1, width: 192 }),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setError("This enrolment request expired. Please sign in again.");
          setStep("credentials");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [step, challengeId, enrolMfaChallenge]);

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
          router.replace("/");
        }
      } else if (step === "mfa" && challengeId) {
        await verifyMfa(challengeId, code.trim());
        router.replace("/");
      } else if (step === "enrol" && challengeId) {
        const { recoveryCodes: codes } =
          await completeMfaEnrolmentChallenge(challengeId, code.trim());
        setRecoveryCodes(codes);
        setStep("enrol-codes");
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
        case "MFA_ENROLMENT_REQUIRED":
          setChallengeId(
            typeof err.data === "object" &&
              err.data !== null &&
              "challengeId" in err.data
              ? String((err.data as { challengeId: string }).challengeId)
              : null,
          );
          setError(null);
          setStep("enrol");
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
        case "EMAIL_NOT_VERIFIED":
          setError(
            "Your email is not verified yet. Check your inbox for the link we sent when you registered.",
          );
          setUnverified(true);
          break;
        default:
          setError(err.message || "Sign-in failed. Try again.");
      }
    } finally {
      setPending(false);
    }
  }

  async function resendVerification() {
    if (!email.trim()) return;
    setResendState("sending");
    try {
      await apiFetch("/auth/resend-verification", {
        method: "POST",
        body: { email: email.trim() },
        auth: false,
      });
    } catch {
      /* the endpoint answers identically either way — treat any outcome as sent */
    }
    setResendState("sent");
  }

  return (
    <main className="flex min-h-svh flex-1">
      <aside
        className="relative hidden w-[42%] flex-col justify-between overflow-hidden bg-sidebar bg-cover bg-center p-10 text-sidebar-foreground lg:flex"
        style={{ backgroundImage: "url(/corporate.jpeg)" }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-black/75 via-black/45 to-black/75" />
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-white p-1.5 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo_no_bg.png" alt="BusinessHub" className="size-full object-contain" />
          </div>
          <span className="text-lg font-semibold tracking-tight">
            BusinessHub
          </span>
        </div>
        <div className="relative z-10 space-y-4">
          <h1 className="max-w-md text-3xl font-semibold leading-snug text-white">
            One hub for registrations, cases and compliance.
          </h1>
          <p className="max-w-sm text-sm leading-relaxed text-white/80">
            Submit company registrations, track approvals through every level,
            manage documents, invoices and SLA deadlines â€” all under one
            permission-controlled roof.
          </p>
        </div>
        <p className="relative z-10 text-xs text-white/70">
          ©{new Date().getFullYear()} BusinessHub
        </p>
      </aside>

      <section className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <Card className="w-full max-w-sm border-none shadow-lg">
          <CardHeader className="gap-1">
            <CardTitle className="text-xl font-semibold">
              {step === "credentials"
                ? "Sign in"
                : step === "mfa"
                  ? "Two-factor required"
                  : step === "enrol"
                    ? "Set up two-factor authentication"
                    : "Save your recovery codes"}
            </CardTitle>
            <CardDescription>
              {step === "credentials"
                ? "Enter your credentials to access the hub."
                : step === "mfa"
                  ? useRecovery
                    ? "Enter one of your recovery codes."
                    : "Enter the 6-digit code from your authenticator app."
                  : step === "enrol"
                    ? "Your role requires MFA. Scan the QR code with an authenticator app, then enter the 6-digit code."
                    : "These ten single-use codes are shown exactly once. Store them somewhere safe."}
            </CardDescription>
          </CardHeader>

          {error && (
            <CardContent className="pb-0">
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </CardContent>
          )}

          {unverified && step === "credentials" && (
            <CardContent className="pb-0">
              {resendState === "sent" ? (
                <Alert>
                  <MailCheck />
                  <AlertDescription>
                    If that address needs verification, a fresh email is on its
                    way.
                  </AlertDescription>
                </Alert>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={resendState === "sending"}
                  onClick={() => void resendVerification()}
                >
                  {resendState === "sending" && (
                    <Loader2 className="animate-spin" />
                  )}
                  <MailCheck />
                  Resend verification email
                </Button>
              )}
            </CardContent>
          )}

          {step === "enrol-codes" ? (
            <CardContent className="grid gap-4">
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3">
                {recoveryCodes.map((c) => (
                  <code key={c} className="text-center text-sm font-semibold tracking-wider">
                    {c}
                  </code>
                ))}
              </div>
              <Alert>
                <ShieldAlert />
                <AlertDescription>
                  Each code works once if you lose your authenticator. They will
                  never be shown again.
                </AlertDescription>
              </Alert>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(recoveryCodes.join("\n"))
                      .catch(() => {})
                  }
                >
                  <Copy />
                  Copy all
                </Button>
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => router.replace("/")}
                >
                  Continue
                </Button>
              </div>
            </CardContent>
          ) : (
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
                        placeholder="you@company.com"
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
                        placeholder="********"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                    </div>
                  </>
                ) : step === "enrol" ? (
                  <>
                    <div className="flex flex-col items-center gap-3">
                      {qrDataUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={qrDataUrl}
                          alt="TOTP provisioning QR code"
                          className="size-48 rounded-lg border bg-white p-1"
                        />
                      ) : (
                        <div className="flex size-48 items-center justify-center rounded-lg border">
                          <Loader2 className="animate-spin text-muted-foreground" />
                        </div>
                      )}
                      {provisioning && (
                        <p className="text-center text-xs break-all text-muted-foreground">
                          Can&apos;t scan? Enter this secret manually:{" "}
                          <code className="font-semibold text-foreground">
                            {provisioning.secret}
                          </code>
                        </p>
                      )}
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="code">Authenticator code</Label>
                      <Input
                        id="code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        autoFocus
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
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
                  {step === "credentials" ? "Continue" : step === "enrol" ? "Enable" : "Verify"}
                </Button>
              </CardContent>
            </form>
          )}

          <CardContent>
            {step === "credentials" && (
              <>
                <div className="relative my-1">
                  <Separator />
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs uppercase tracking-wide text-muted-foreground">
                    or
                  </span>
                </div>
                <p className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                  <Link
                    href="/forgot-password"
                    className="font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </Link>
                  <span>
                    No account yet?{" "}
                    <Link
                      href="/register"
                      className="font-medium text-primary hover:underline"
                    >
                      Create one
                    </Link>
                  </span>
                </p>
              </>
            )}
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


