import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ApiStatus } from "@/components/ApiStatus";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ARCHON",
  description: "AI Engineering Intelligence Platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      {/* h-full (not min-h-full): the code map needs a definite height chain down to its canvas */}
      <body className="h-full flex flex-col overflow-hidden">
        <header className="h-12 shrink-0 border-b border-line bg-elev/80 backdrop-blur flex items-center px-4 gap-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-wide">
            <span className="inline-block h-5 w-5 rounded-sm bg-accent" style={{ clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />
            ARCHON
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted">
            <Link href="/" className="hover:text-fg">Repositories</Link>
          </nav>
          <div className="ml-auto">
            <ApiStatus />
          </div>
        </header>
        <main className="flex-1 flex flex-col min-h-0 overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
