import { RepoShell } from "@/components/RepoShell";

export default async function RepoLayout({ children, params }: LayoutProps<"/repos/[id]">) {
  const { id } = await params;
  return <RepoShell id={id}>{children}</RepoShell>;
}
