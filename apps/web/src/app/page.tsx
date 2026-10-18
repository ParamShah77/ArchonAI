import { CommandPalette, PaletteButton } from "@/components/CommandPalette";
import { RepoList } from "@/components/RepoList";

export default function HomePage() {
  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <CommandPalette />
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Understand any codebase</h1>
          <PaletteButton className="hidden sm:inline-flex shrink-0" />
        </div>
        <p className="text-muted mt-1.5 max-w-2xl">
          ARCHON maps a repository into a code graph, so you can explore its structure, chat with it, audit it and plan
          changes with the whole system in view.
        </p>
      </header>
      <RepoList />
    </div>
  );
}
