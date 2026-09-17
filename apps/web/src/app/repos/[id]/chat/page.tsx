import { Suspense } from "react";
import { ChatPanel } from "@/components/chat/ChatPanel";

export default function ChatPage() {
  return (
    <Suspense>
      <ChatPanel />
    </Suspense>
  );
}
