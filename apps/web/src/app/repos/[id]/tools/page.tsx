import { Suspense } from "react";
import { ToolsPanel } from "@/components/tools/ToolsPanel";

export default function ToolsPage() {
  return (
    <Suspense>
      <ToolsPanel />
    </Suspense>
  );
}
