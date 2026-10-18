import Link from "next/link";
import {
  ArrowRight,
  Bug,
  FileText,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  HeartPulse,
  Lightbulb,
  ListChecks,
  Lock,
  Map as MapIcon,
  MessageSquare,
  Network,
  ScrollText,
  ShieldCheck,
  Target,
  Zap,
} from "lucide-react";
import { Logo } from "@/components/SiteHeader";

/**
 * The website: what ARCHON is, before you enter the app at /repos (decisions.md D-035).
 * A static page: no data, no requests; the product preview is drawn with plain elements.
 */
export default function LandingPage() {
  return (
    <div className="landing">
      <style>{CSS}</style>

      {/* ---------- hero ---------- */}
      <section className="relative overflow-hidden border-b border-line">
        <div className="hero-glow" aria-hidden />
        <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-16 sm:pt-24 pb-14 sm:pb-20 grid lg:grid-cols-[1.05fr_1fr] gap-12 items-center">
          <div className="rise">
            <span className="chip border-accent/40 text-accent">
              <Zap size={12} /> Engineering intelligence for real codebases
            </span>
            <h1 className="mt-5 text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.08]">
              See your whole codebase
              <br />
              <span className="text-accent">at once.</span>
            </h1>
            <p className="mt-5 text-lg text-muted max-w-xl leading-relaxed">
              ARCHON reads a repository and turns it into a living map: every folder, file, function and call. Explore it,
              ask it questions, audit it, and plan changes knowing exactly what they touch.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/repos" className="btn btn-primary px-5 py-2.5 text-[15px]">
                Open ARCHON <ArrowRight size={16} />
              </Link>
              <a href="#how" className="btn px-5 py-2.5 text-[15px]">See how it works</a>
            </div>
            <p className="mt-5 text-xs text-faint">
              Python · TypeScript · JavaScript · Go · Java · SQL — from a GitHub URL or a folder on your machine.
            </p>
          </div>
          <Preview />
        </div>
      </section>

      {/* ---------- what it answers ---------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 py-14 grid sm:grid-cols-3 gap-6 text-center sm:text-left">
        {[
          ["Where is it?", "Find any file, function or endpoint and fly straight to it on the map."],
          ["How does it work?", "Ask in plain language; answers cite the exact files and lines they come from."],
          ["What breaks if I change it?", "See every caller, endpoint, table and test a change can reach — before you make it."],
        ].map(([q, a]) => (
          <div key={q}>
            <div className="text-lg font-semibold">{q}</div>
            <p className="text-sm text-muted mt-1.5 leading-relaxed">{a}</p>
          </div>
        ))}
      </section>

      {/* ---------- features ---------- */}
      <section id="features" className="border-t border-line bg-elev/40">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <SectionTitle kicker="Features" title="Everything about your system, in one place" />
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={MapIcon} title="Code Map" text="Folders and files as nested boxes that open as you zoom in, with the calls and imports between them. The part you zoom into becomes clearer and clearer." />
            <Feature icon={Network} title="Graph view" text="Every node and relationship as a force-directed graph: files form stars with their functions, and relationship types appear on the lines as you get closer." />
            <Feature icon={MessageSquare} title="Chat with your code" text="Grounded answers that stream in as they are written, with every cited file one click away on the map." />
            <Feature icon={ShieldCheck} title="Audit & health" text="Security, performance and technical-debt findings, a health grade per repository, and a trend so you can see it improving." />
            <Feature icon={FileText} title="Docs, written for you" text="Architecture, API, data flow, database, setup and onboarding guides generated from the code itself." />
            <Feature icon={HeartPulse} title="Always current" text="ARCHON notices when a repository has changed since it was analyzed and refreshes it in one click — the audit runs automatically." />
          </div>
        </div>
      </section>

      {/* ---------- how it works ---------- */}
      <section id="how" className="border-t border-line">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <SectionTitle kicker="How it works" title="From repository to understanding in a minute" />
          <ol className="mt-10 grid gap-4 md:grid-cols-3">
            <Step n={1} title="Add a repository" text="Paste a GitHub URL or point at a folder. Local folders are read in place and never modified." icon={GitBranch} />
            <Step n={2} title="ARCHON builds the graph" text="Every file is parsed into folders, files, classes, functions, endpoints and tables, connected by calls, imports and queries — then audited." icon={Network} />
            <Step n={3} title="Explore, ask, change" text="Zoom through the map, chat with the code, run the tools, and check the impact of a change before you write it." icon={Target} />
          </ol>
        </div>
      </section>

      {/* ---------- tools ---------- */}
      <section id="tools" className="border-t border-line bg-elev/40">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
          <SectionTitle kicker="Tools" title="An engineering toolkit that knows your system" />
          <div className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            <Tool icon={Bug} title="Debug" text="Paste a stack trace; get the execution path, the root cause and a fix." />
            <Tool icon={Target} title="Change impact" text="Everything a change can break, with a risk score." />
            <Tool icon={Lightbulb} title="Feature simulator" text="Which files, tables and APIs a new feature touches." />
            <Tool icon={ListChecks} title="Engineering plan" text="A requirement turned into steps, tests and an estimate." />
            <Tool icon={GitPullRequest} title="Code review" text="A diff checked against the graph for regressions and side effects." />
            <Tool icon={ScrollText} title="Incidents & logs" text="Logs clustered into a timeline and linked to the code." />
            <Tool icon={FileText} title="Test generation" text="Tests for a function, mocking what it actually calls." />
            <Tool icon={HeartPulse} title="Refactoring" text="Safe restructuring for the worst debt, aware of every caller." />
          </div>
        </div>
      </section>

      {/* ---------- trust ---------- */}
      <section className="border-t border-line">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-14 grid gap-6 md:grid-cols-3">
          <Trust icon={Lock} title="Runs where your code is" text="ARCHON runs on your machine. Your repositories stay with you." />
          <Trust icon={FolderOpen} title="Read-only by design" text="Local folders are analyzed in place and never written to." />
          <Trust icon={ShieldCheck} title="Facts first" text="Structure comes from parsing the code, so maps, impact and findings are exact — AI only explains them." />
        </div>
      </section>

      {/* ---------- call to action ---------- */}
      <section className="border-t border-line relative overflow-hidden">
        <div className="hero-glow opacity-60" aria-hidden />
        <div className="relative max-w-3xl mx-auto px-5 sm:px-8 py-20 text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">Understand your codebase today.</h2>
          <p className="mt-4 text-muted text-lg">Add your first repository — the map is ready in about a minute.</p>
          <div className="mt-8 flex justify-center gap-3 flex-wrap">
            <Link href="/repos?add=1" className="btn btn-primary px-5 py-2.5 text-[15px]">
              Add a repository <ArrowRight size={16} />
            </Link>
            <Link href="/repos" className="btn px-5 py-2.5 text-[15px]">Open ARCHON</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-8 flex flex-wrap items-center gap-4 text-sm text-faint">
          <Logo />
          <span>Engineering intelligence for real codebases.</span>
          <nav className="ml-auto flex gap-5">
            <a href="#features" className="hover:text-fg">Features</a>
            <a href="#how" className="hover:text-fg">How it works</a>
            <Link href="/repos" className="hover:text-fg">Open the app</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

type Icon = typeof MapIcon;

function SectionTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="max-w-2xl">
      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">{kicker}</div>
      <h2 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight">{title}</h2>
    </div>
  );
}

function Feature({ icon: I, title, text }: { icon: Icon; title: string; text: string }) {
  return (
    <div className="card p-5 hover:border-line-strong transition-colors">
      <span className="h-9 w-9 rounded-lg bg-accent-soft text-accent flex items-center justify-center"><I size={18} /></span>
      <div className="mt-4 font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-muted leading-relaxed">{text}</p>
    </div>
  );
}

function Step({ n, title, text, icon: I }: { n: number; title: string; text: string; icon: Icon }) {
  return (
    <li className="card p-6 relative">
      <div className="flex items-center gap-3">
        <span className="h-8 w-8 rounded-full border border-accent/50 text-accent flex items-center justify-center text-sm font-semibold">{n}</span>
        <I size={18} className="text-faint" />
      </div>
      <div className="mt-4 text-lg font-semibold">{title}</div>
      <p className="mt-1.5 text-sm text-muted leading-relaxed">{text}</p>
    </li>
  );
}

function Tool({ icon: I, title, text }: { icon: Icon; title: string; text: string }) {
  return (
    <div className="flex gap-3">
      <I size={18} className="text-accent shrink-0 mt-0.5" />
      <div>
        <div className="font-medium">{title}</div>
        <p className="text-sm text-muted mt-0.5 leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

function Trust({ icon: I, title, text }: { icon: Icon; title: string; text: string }) {
  return (
    <div className="flex gap-3">
      <I size={18} className="text-ok shrink-0 mt-0.5" />
      <div>
        <div className="font-medium">{title}</div>
        <p className="text-sm text-muted mt-0.5 leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

/** A drawn preview of the app: the code map with a chat answer beside it. */
function Preview() {
  const box = (label: string, cls: string, kids: [string, string][]) => (
    <div className={`rounded-md border p-2 ${cls}`}>
      <div className="text-[10px] font-semibold opacity-90 mb-1.5">{label}</div>
      <div className="flex flex-wrap gap-1">
        {kids.map(([k, c]) => (
          <span key={k} className="rounded px-1.5 py-0.5 text-[9px] mono" style={{ background: c, color: "#14171d" }}>{k}</span>
        ))}
      </div>
    </div>
  );
  return (
    <div className="rise rise-2 relative">
      <div className="card overflow-hidden" style={{ boxShadow: "0 30px 80px -20px rgba(0,0,0,.6), 0 0 0 1px var(--border)" }}>
        {/* window bar */}
        <div className="flex items-center gap-1.5 px-3 h-8 border-b border-line bg-elev2">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff7b9c]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffb86c]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#7ee0a0]/70" />
          <span className="ml-3 text-[10px] text-faint mono">archon · shop-api · Code Map</span>
        </div>
        <div className="grid grid-cols-[1.35fr_1fr] min-h-[300px]" style={{ background: "#0f1218" }}>
          {/* map */}
          <div className="p-3 grid gap-2 content-start relative">
            <div className="grid grid-cols-2 gap-2">
              {box("api/routes", "border-[#4c6a8f] bg-[#1b2635] text-[#b9cde6]", [["orders.py", "#8bc7e5"], ["users.py", "#8bc7e5"], ["auth.py", "#8bc7e5"]])}
              {box("services", "border-[#5f7d5a] bg-[#1c271d] text-[#c3dcb9]", [["place_order", "#9ccfac"], ["validate", "#9ccfac"], ["charge", "#9ccfac"]])}
            </div>
            <div className="grid grid-cols-[1.4fr_1fr] gap-2">
              {box("models", "border-[#7a6290] bg-[#241c2c] text-[#d7c4e6]", [["Order", "#c9b3e0"], ["User", "#c9b3e0"], ["orders", "#f1a6a6"]])}
              {box("web", "border-[#8a6f4a] bg-[#2a2219] text-[#e6d2b4]", [["Checkout.tsx", "#f0c890"]])}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[10px] text-faint">
              <span className="h-2 w-2 rounded-full bg-[#ffb86c]" /> place_order → charge · 3 calls
            </div>
          </div>
          {/* chat */}
          <div className="border-l border-line p-3 flex flex-col gap-2 text-[11px]">
            <div className="self-end max-w-[90%] rounded-md bg-accent-soft border border-accent/30 px-2.5 py-1.5">What happens when an order is placed?</div>
            <div className="rounded-md border border-line bg-elev px-2.5 py-2 leading-relaxed text-fg/90">
              <span className="text-accent mono">place_order</span> validates the cart, charges the card through{" "}
              <span className="text-accent mono">charge</span> and saves an <span className="text-accent mono">Order</span>.
              <span className="caret" />
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span className="chip !text-[9px] !py-0">services/orders.py:12</span>
                <span className="chip !text-[9px] !py-0">models/order.py:4</span>
              </div>
            </div>
            <div className="mt-auto rounded-md border border-line bg-elev px-2.5 py-1.5 flex items-center gap-2">
              <ShieldCheck size={12} className="text-ok" /> Health <b className="text-ok whitespace-nowrap">B · 86</b>
              <svg width="40" height="12" className="ml-auto" aria-hidden>
                <polyline points="0,9 10,8 20,6 30,5 40,2" fill="none" stroke="var(--ok)" strokeWidth="1.5" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.landing { scroll-behavior: smooth; }
.hero-glow {
  position: absolute; inset: -40% -10% auto -10%; height: 120%;
  background:
    radial-gradient(40% 50% at 70% 30%, rgba(90,169,255,.16), transparent 70%),
    radial-gradient(30% 40% at 20% 10%, rgba(126,224,160,.08), transparent 70%);
  pointer-events: none;
}
@keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
.rise { animation: rise .7s ease-out both; }
.rise-2 { animation-delay: .15s; }
@keyframes blink { 50% { opacity: 0; } }
.caret { display: inline-block; width: 6px; height: 11px; margin-left: 3px; vertical-align: -1px; background: var(--accent); animation: blink 1s steps(1) infinite; }
@media (prefers-reduced-motion: reduce) { .rise, .caret { animation: none; } }
`;
