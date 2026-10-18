import { CommandPalette, PaletteButton } from "@/components/CommandPalette";
import { RepoList } from "@/components/RepoList";

export default function RepositoriesPage() {
  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-10">
      <CommandPalette />
      <header className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <PaletteButton className="hidden sm:inline-flex shrink-0" />
        </div>
        <p className="text-muted mt-1.5 max-w-2xl">Add a repository, or pick one to explore its map, chat with it and audit it.</p>
      </header>
      <RepoList />
    </div>
  );
}
