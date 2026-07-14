"use client";

import { useState, type ReactNode } from "react";
import { Menu, X, LogOut } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { brandGradientText } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";
import { NotificationBell } from "@/components/realtime/notification-bell";
import { BrandLogo } from "@/components/brand/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

export interface DashboardShellProps {
  role: "student" | "instructor" | "admin" | "guardian";
  roleLabel: string;
  navItems: NavItem[];
  userName?: string | null;
  userEmail?: string | null;
  /** ID of user being impersonated (admin in their session) — shows banner */
  impersonatedTargetId?: string | null;
  /** Name of user being impersonated */
  impersonatedTargetName?: string | null;
  children?: ReactNode;
}

export function DashboardShell({
  role,
  roleLabel,
  navItems,
  userName,
  userEmail,
  impersonatedTargetId,
  impersonatedTargetName,
  children,
}: DashboardShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-to-bl from-muted/30 to-background">
      {/* Impersonation banner — only shown when admin is impersonating */}
      {impersonatedTargetId && impersonatedTargetName && (
        <ImpersonationBanner
          targetId={impersonatedTargetId}
          targetName={impersonatedTargetName}
        />
      )}
      {/* Top bar (mobile) */}
      <header className="lg:hidden sticky top-0 z-40 glass border-b border-border/40 px-4 h-14 flex items-center justify-between">
        <Link href={`/${role}`} className="shrink-0">
          <BrandLogo variant="sidebar" />
        </Link>
        <div className="flex items-center gap-2">
          <NotificationBell role={role} />
          <ThemeToggle />
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg hover:bg-muted/60 transition-colors"
            aria-label="القائمة"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar (desktop) */}
        <aside className="hidden lg:flex sticky top-0 h-screen w-64 flex-col border-l border-border/60 bg-card/60 backdrop-blur-sm">
          <SidebarContent
            role={role}
            roleLabel={roleLabel}
            navItems={navItems}
            userName={userName}
            userEmail={userEmail}
          />
        </aside>

        {/* Sidebar (mobile drawer) */}
        {mobileOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setMobileOpen(false)}
            />
            <aside className="relative w-72 max-w-[80%] bg-card shadow-2xl flex flex-col animate-in slide-in-from-right">
              <button
                onClick={() => setMobileOpen(false)}
                className="absolute top-3 left-3 p-2 rounded-lg hover:bg-muted"
                aria-label="إغلاق"
              >
                <X className="h-5 w-5" />
              </button>
              <SidebarContent
                role={role}
                roleLabel={roleLabel}
                navItems={navItems}
                userName={userName}
                userEmail={userEmail}
                onNavigate={() => setMobileOpen(false)}
              />
            </aside>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 min-w-0">
          <div className="p-4 lg:p-8 max-w-7xl mx-auto">{children}</div>
        </main>
      </div>
    </div>
  );
}

function SidebarContent({
  role,
  roleLabel,
  navItems,
  userName,
  userEmail,
  onNavigate,
}: DashboardShellProps & { onNavigate?: () => void }) {
  return (
    <>
      <div className="h-16 flex items-center justify-center border-b border-border/60 px-4">
        <Link href={`/${role}`}>
          <BrandLogo variant="sidebar" />
        </Link>
      </div>

      <div className="px-3 py-3 border-b border-border/40">
        <div className="flex items-center gap-3 px-2">
          <div className="h-9 w-9 rounded-full brand-gradient-soft border border-border/40 flex items-center justify-center text-xs font-semibold text-foreground">
            {(userName || "؟").charAt(0)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">
              {userName || "—"}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {userEmail || ""}
            </div>
          </div>
        </div>
        <div className="mt-2 px-2">
          <span className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium",
            role === "admin" && "bg-orange-100 text-orange-700",
            role === "instructor" && "bg-teal-100 text-teal-700",
            role === "student" && "bg-blue-100 text-blue-700",
          )}>
            {roleLabel}
          </span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto nice-scroll px-2 py-3 space-y-1">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="bg-[#D65221] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                {item.badge}
              </span>
            )}
          </Link>
        ))}
      </nav>

      <div className="p-3 border-t border-border/60 space-y-2">
        <NotificationBell role={role} sidebarMode />
        <Button
          variant="ghost"
          onClick={() => signOut({ callbackUrl: "/" })}
          className="w-full justify-start text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl"
        >
          <LogOut className="h-4 w-4 ml-2" />
          تسجيل الخروج
        </Button>
      </div>
    </>
  );
}
