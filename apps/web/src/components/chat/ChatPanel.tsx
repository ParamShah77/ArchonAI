"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Database, MessageSquare, Plus, Send } from "lucide-react";
import { api, type ChatMessage, type ChatSource } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { Markdown } from "@/components/Markdown";
import { ErrorBox, KindBadge, Spinner } from "@/components/ui";

const SUGGESTIONS = [
  "How does authentication work?",
  "What happens when a request hits the main endpoint?",
  "Which files are responsible for database access?",
  "Where is error handling centralized?",
  "What are the entry points of this system?",
];

export function ChatPanel() {
  const { repo } = useRepo();
  const convs = useApi(`convs:${repo.id}`, () => api.chat.conversations(repo.id));
  const [cid, setCid] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const load = async (id: string) => {
    setCid(id);
    const c = await api.chat.conversation(repo.id, id);
    setMessages(c.messages);
  };

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    setError(null);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: question, sources: [], created_at: "" }]);
    try {
      const r = await api.chat.ask(repo.id, question, cid);
      if (!cid) {
        setCid(r.conversation_id);
        convs.refresh();
      }
      setMessages((m) => [...m, { id: `a-${Date.now()}`, role: "assistant", content: r.answer, sources: r.sources, created_at: "", answered_by: r.answered_by }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const r = await api.chat.reindex(repo.id);
      setError(null);
      setMessages((m) => [...m, { id: `sys-${Date.now()}`, role: "assistant", content: `Rebuilt the retrieval index: ${r.chunks} chunks, ${r.embedded} embedded.`, sources: [], created_at: "" }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-64 shrink-0 border-r border-line bg-elev flex flex-col">
        <div className="p-3 border-b border-line flex items-center justify-between">
          <span className="stat-label">Conversations</span>
          <button className="btn btn-ghost px-2" title="New conversation" onClick={() => { setCid(null); setMessages([]); }}><Plus size={14} /></button>
        </div>
        <div className="overflow-y-auto flex-1">
          {convs.data?.map((c) => (
            <button key={c.id} onClick={() => load(c.id)} className={`w-full text-left px-3 py-2 text-xs border-b border-line/60 hover:bg-elev2 ${cid === c.id ? "bg-elev2 text-fg" : "text-muted"}`}>
              <MessageSquare size={12} className="inline mr-1.5 -mt-0.5" />
              <span className="truncate">{c.title || "untitled"}</span>
            </button>
          ))}
          {convs.data && convs.data.length === 0 && <div className="p-3 text-xs text-faint">No conversations yet.</div>}
        </div>
        <div className="p-3 border-t border-line">
          <button className="btn btn-ghost text-xs w-full" onClick={reindex} disabled={reindexing}>
            {reindexing ? <Spinner className="h-3 w-3" /> : <Database size={13} />} Rebuild index
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {messages.length === 0 && (
            <div className="max-w-2xl mx-auto mt-10">
              <h2 className="text-lg font-semibold mb-1">Ask anything about {repo.name}</h2>
              <p className="text-muted text-sm mb-4">Answers are grounded in the code graph and retrieved source excerpts, with citations you can open on the map.</p>
              <div className="grid gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="card px-3 py-2 text-left text-sm hover:border-accent" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`max-w-3xl ${m.role === "user" ? "ml-auto" : ""}`}>
              <div className={`rounded-lg px-4 py-3 ${m.role === "user" ? "bg-accent-soft border border-accent/30" : "card"}`}>
                {m.role === "user" ? <p className="text-sm whitespace-pre-wrap">{m.content}</p> : <Markdown>{m.content}</Markdown>}
                {m.answered_by && <div className="mt-2 text-[11px] text-faint mono">answered by {m.answered_by}</div>}
              </div>
              {m.sources?.length > 0 && <Sources repoId={repo.id} sources={m.sources} />}
            </div>
          ))}
          {busy && <div className="card px-4 py-3 max-w-3xl flex items-center gap-2 text-muted text-sm"><Spinner /> Reading the code graph…</div>}
          {error && <ErrorBox>{error}</ErrorBox>}
          <div ref={bottom} />
        </div>
        <form
          className="border-t border-line p-3 flex gap-2 bg-elev/60"
          onSubmit={(e) => { e.preventDefault(); send(q); }}
        >
          <input className="input" placeholder="Ask about the codebase… (e.g. What happens when a user places an order?)" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} />
          <button className="btn btn-primary shrink-0" disabled={busy || !q.trim()}><Send size={15} /> Ask</button>
        </form>
      </div>
    </div>
  );
}

export function Sources({ repoId, sources }: { repoId: string; sources: ChatSource[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {sources.slice(0, 8).map((s, i) => (
        <Link
          key={`${s.path}:${s.start_line}:${i}`}
          href={`/repos/${repoId}/map?focus=${s.node_id}&node=${s.node_id}&depth=1`}
          className="chip hover:border-accent hover:text-accent"
          title={`${s.path}:${s.start_line}-${s.end_line} (${s.why})`}
        >
          {s.kind && s.kind !== "file" && <KindBadge kind={s.kind as never} className="!px-1 !py-0 !border-0 !bg-transparent" />}
          <span className="mono">{s.name || s.path.split("/").pop()}</span>
          <span className="text-faint">:{s.start_line}</span>
        </Link>
      ))}
    </div>
  );
}
