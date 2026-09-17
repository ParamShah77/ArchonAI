import { RepoList } from "@/components/RepoList";

export default function HomePage() {
  return (
    <div className="max-w-5xl w-full mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold">Repositories</h1>
        <p className="text-muted mt-1">
          Add a repository to build its code graph, reconstruct the architecture, and explore it as an interactive map.
        </p>
      </div>
      <RepoList />
    </div>
  );
}
