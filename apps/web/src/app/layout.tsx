import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ARCHON — understand any codebase",
  description: "ARCHON turns a repository into a living map you can explore, question, audit and change with confidence.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. QuillBot's data-qb-installed) add attributes to <html>
    // before React loads; this silences that one-level attribute mismatch only, not mismatches in the page
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      {/* h-full (not min-h-full): the code map needs a definite height chain down to its canvas */}
      <body className="h-full flex flex-col overflow-hidden">
        <SiteHeader />
        <main className="flex-1 flex flex-col min-h-0 overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
