import { Bug, Compass, FlaskConical, GitPullRequest, Hammer, Lightbulb, ListChecks, ScrollText, Target } from "lucide-react";

/** The Tools tab's tools (shared with the quick-jump palette). */
export const TOOLS = [
  { id: "debug", label: "Debug", icon: Bug, blurb: "Paste an error, stack trace or log line. ARCHON maps frames to code, traces the execution path and proposes a root cause and fix." },
  { id: "impact", label: "Change impact", icon: Target, blurb: "Pick a function, class, file or table. See every dependent, endpoint, table and test that could break, with a risk score." },
  { id: "feature", label: "Feature simulator", icon: Lightbulb, blurb: "Describe a feature in plain language. ARCHON identifies which components, files, tables and APIs would need to change." },
  { id: "plan", label: "Engineering plan", icon: ListChecks, blurb: "Turn a requirement into an implementation plan: files, DB/API changes, tests, security, deployment, complexity estimate." },
  { id: "advise", label: "Architecture advisor", icon: Compass, blurb: "Ask 'What should I change to support 10× more users?' and get recommendations with trade-offs grounded in this codebase." },
  { id: "refactor", label: "Refactoring", icon: Hammer, blurb: "Get safe restructuring proposals for the hottest debt spot (or a chosen file/symbol), aware of its dependents." },
  { id: "tests", label: "Test generation", icon: FlaskConical, blurb: "Generate test cases and a test file for a function, using its callers/callees to decide what to mock." },
  { id: "review", label: "Code review", icon: GitPullRequest, blurb: "Paste a unified diff. Changed symbols are mapped to the graph, checked against rules, and reviewed for regressions and side effects." },
  { id: "logs", label: "Incident & logs", icon: ScrollText, blurb: "Paste application logs. ARCHON clusters messages, builds a timeline, links errors to code and explains the probable root cause." },
] as const;
