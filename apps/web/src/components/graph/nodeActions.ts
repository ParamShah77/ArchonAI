/**
 * Next steps from a node of the code map (decisions.md D-031): shared by the right-click menu and the
 * details panel, so both offer exactly the same actions.
 */
import type { GraphNode, Repo } from "@/lib/api";
import type { NodeAction } from "./MapCanvas";

type NodeLike = Pick<GraphNode, "id" | "kind" | "name" | "path" | "start_line" | "meta">;

const isUrl = (s: string) => /^(https?:\/\/|git@)/.test(s.trim());

/** Where the code lives: a local checkout opens in VS Code, a GitHub source opens on GitHub at the indexed
 *  commit. */
export function editorHref(repo: Repo, path: string, line = 0): string | null {
  if (!path) return null;
  const src = repo.source.trim();
  if (isUrl(src)) {
    const m = src.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
    if (!m) return null;
    const ref = repo.commit_sha || repo.default_branch || "HEAD";
    return `https://github.com/${m[1]}/${m[2]}/blob/${ref}/${path}${line > 0 ? `#L${line}` : ""}`;
  }
  const root = src.replace(/\\/g, "/").replace(/\/$/, "");
  return `vscode://file/${root}/${path}${line > 0 ? `:${line}` : ""}`;
}

export const editorLabel = (repo: Repo) => (isUrl(repo.source) ? "Open on GitHub" : "Open in VS Code");

/** The page an action leads to (null for actions that do not navigate). */
export function actionHref(kind: NodeAction, repo: Repo, n: NodeLike): string | null {
  const label = n.kind === "method" && typeof n.meta.class === "string" ? `${n.meta.class}.${n.name}` : n.name;
  switch (kind) {
    case "impact":
    case "tests":
    case "refactor":
      return `/repos/${repo.id}/tools?tool=${kind}&node=${encodeURIComponent(n.id)}`;
    case "chat": {
      const q = `Explain ${label}${n.path ? ` (${n.path})` : ""}: what does it do, what uses it, and what would break if it changed?`;
      return `/repos/${repo.id}/chat?q=${encodeURIComponent(q)}`;
    }
    default:
      return null;
  }
}

/** Run an action: navigate, copy the path, or open the code. */
export function runAction(kind: NodeAction, repo: Repo, n: NodeLike, navigate: (href: string) => void): void {
  if (kind === "copy") {
    void navigator.clipboard?.writeText(n.path || n.name).catch(() => {});
    return;
  }
  if (kind === "open") {
    const href = editorHref(repo, n.path, n.start_line);
    if (!href) return;
    if (href.startsWith("vscode://")) window.location.href = href;
    else window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const href = actionHref(kind, repo, n);
  if (href) navigate(href);
}
