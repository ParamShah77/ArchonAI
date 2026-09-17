"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-archon">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-xl font-semibold mt-6 mb-3 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-base font-semibold mt-5 mb-2 border-b border-line pb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-sm font-semibold mt-4 mb-1.5">{children}</h3>,
          p: ({ children }) => <p className="text-sm leading-relaxed text-fg/90 mb-2">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 text-sm space-y-0.5 mb-2">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 text-sm space-y-0.5 mb-2">{children}</ol>,
          li: ({ children }) => <li className="text-fg/90">{children}</li>,
          a: ({ children, href }) => <a href={href} className="text-accent hover:underline">{children}</a>,
          code: ({ children, className }) => {
            const block = typeof className === "string" && className.startsWith("language-");
            if (block) return <code className="mono text-[11px]">{children}</code>;
            return <code className="mono text-[11px] bg-elev2 border border-line rounded px-1 py-0.5">{children}</code>;
          },
          pre: ({ children }) => <pre className="mono text-[11px] bg-bg border border-line rounded-md p-3 overflow-x-auto mb-3 leading-relaxed">{children}</pre>,
          table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="text-xs w-full">{children}</table></div>,
          th: ({ children }) => <th className="text-left text-faint uppercase tracking-wider text-[10px] pb-1 pr-3">{children}</th>,
          td: ({ children }) => <td className="border-t border-line py-1 pr-3 mono align-top">{children}</td>,
          blockquote: ({ children }) => <blockquote className="border-l-2 border-accent pl-3 text-muted mb-2">{children}</blockquote>,
          hr: () => <hr className="border-line my-4" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
