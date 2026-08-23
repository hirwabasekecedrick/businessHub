"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useAuth } from "@/components/providers/auth-provider";

export default function HomePage() {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    } else if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-3 bg-sidebar text-sidebar-primary-foreground">
      <div className="flex size-12 items-center justify-center rounded-xl bg-sidebar-primary font-bold">
        BH
      </div>
      <p className="text-sm tracking-wide text-sidebar-accent-foreground">
        BusinessHub
      </p>
      <Loader2 className="size-4 animate-spin text-sky-300" />
    </main>
  );
}
