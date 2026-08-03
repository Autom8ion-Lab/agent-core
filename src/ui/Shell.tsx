"use client";

import type { ReactNode } from "react";

// Shared app shell — extracted from FRIDAY's/TUESDAY's/CLARA's near-identical Shell.tsx
// (CLARA's was an explicit "direct structural port" of FRIDAY's). Composition-based: each app
// passes its own Sidebar/TopBar/MobileNav/banner components rather than the shared package
// importing app-specific components.
export interface ShellProps {
  children: ReactNode;
  sidebar: ReactNode;
  mobileNav: ReactNode;
  topBar?: ReactNode;
  /** Optional banner rendered above topBar (FRIDAY's OwnerBanner; other apps pass nothing). */
  banner?: ReactNode;
}

export default function Shell({ children, sidebar, mobileNav, topBar, banner }: ShellProps) {
  return (
    <div className="h-screen flex overflow-hidden">
      {sidebar}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[1500px] mx-auto px-6 md:px-10 pt-8 pb-24 md:pb-8">
          {banner}
          {topBar}
          {children}
        </div>
      </main>
      {mobileNav}
    </div>
  );
}
