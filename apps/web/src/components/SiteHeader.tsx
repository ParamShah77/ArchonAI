"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ApiStatus } from "@/components/ApiStatus";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-wide">
      <span className="inline-block h-5 w-5 rounded-sm bg-accent" style={{ clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />
      ARCHON
    </Link>
  );
}

/**
 * One header for the whole site: on the landing page it is the website's navigation; inside the app it is the
 * app bar (decisions.md D-035).
 */
export function SiteHeader() {
  const pathname = usePathname();
  const landing = pathname === "/";
  return (
    <header className="h-12 shrink-0 border-b border-line bg-elev/80 backdrop-blur flex items-center px-4 gap-6">
      <Logo />
      {landing ? (
        <>
          <nav className="hidden sm:flex items-center gap-5 text-sm text-muted">
            <a href="#features" className="hover:text-fg">Features</a>
            <a href="#how" className="hover:text-fg">How it works</a>
            <a href="#tools" className="hover:text-fg">Tools</a>
          </nav>
          <Link href="/repos" className="btn btn-primary ml-auto py-1 text-xs">
            Open ARCHON <ArrowRight size={13} />
          </Link>
        </>
      ) : (
        <>
          <nav className="flex items-center gap-4 text-sm text-muted">
            <Link href="/repos" className="hover:text-fg">Repositories</Link>
          </nav>
          <div className="ml-auto">
            <ApiStatus />
          </div>
        </>
      )}
    </header>
  );
}
