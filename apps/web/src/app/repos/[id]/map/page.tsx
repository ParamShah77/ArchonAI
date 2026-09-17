import { Suspense } from "react";
import { GraphExplorer } from "@/components/graph/GraphExplorer";

export default function MapPage() {
  return (
    <Suspense>
      <GraphExplorer />
    </Suspense>
  );
}
