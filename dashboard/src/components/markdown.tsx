import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink } from './external-link'

export const Md = memo(function Md({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <ExternalLink href={href} className="text-[var(--accent)] hover:underline">{children}</ExternalLink>
        ),
        h1: ({ children }) => <h1 className="text-lg font-semibold mt-5 mb-2">{children}</h1>,
        h2: ({ children }) => <h2 className="text-base font-semibold mt-4 mb-2">{children}</h2>,
        h3: ({ children }) => <h3 className="text-sm font-semibold mt-3 mb-1">{children}</h3>,
        h4: ({ children }) => <h4 className="text-[13px] font-semibold mt-2 mb-1">{children}</h4>,
        p: ({ children }) => <p className="text-[13px] leading-relaxed mb-2">{children}</p>,
        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-[13px]">{children}</li>,
        code: ({ children, className }) => className
          ? <code className="block bg-[var(--bg-card)] p-3 rounded text-[12px] font-mono overflow-x-auto my-2">{children}</code>
          : <code className="bg-[var(--bg-card)] px-1 py-0.5 rounded text-[12px] font-mono">{children}</code>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-[var(--accent)] pl-3 my-2 text-[var(--text-muted)]">{children}</blockquote>,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full text-[12px] border-collapse border border-[var(--border)]">{children}</table></div>,
        th: ({ children }) => <th className="border border-[var(--border)] px-2 py-1 text-left text-[11px] font-semibold bg-[var(--bg-card)]">{children}</th>,
        td: ({ children }) => <td className="border border-[var(--border)] px-2 py-1 text-[12px]">{children}</td>,
        hr: () => <hr className="my-3 border-[var(--border)]" />,
        input: ({ checked, ...props }) => <input {...props} checked={checked ?? false} readOnly className="mr-1.5" type="checkbox" />,
      }}
    >
      {children}
    </ReactMarkdown>
  )
})
