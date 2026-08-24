import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function initialsOf(me: {
  firstName: string | null;
  lastName: string | null;
  email: string;
}) {
  const i = `${me.firstName?.[0] ?? ""}${me.lastName?.[0] ?? ""}`.toUpperCase();
  return i || me.email.slice(0, 2).toUpperCase();
}
