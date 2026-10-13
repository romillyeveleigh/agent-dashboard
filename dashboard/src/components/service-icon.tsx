import { SiLinear, SiGithub } from '@icons-pack/react-simple-icons'

type Service = 'linear' | 'github' | 'document'

const ICON_STYLE = { display: 'inline-block', verticalAlign: 'middle', marginRight: 4, flexShrink: 0, color: '#888' } as const

const DocumentIcon = ({ size = 14, className }: { size?: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M9 1v4h4" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5.5 8h5M5.5 10.5h3.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
  </svg>
)

export function ServiceIcon({ service, size = 14, className }: { service: Service; size?: number; className?: string }) {
  switch (service) {
    case 'linear':
      return <span style={ICON_STYLE}><SiLinear size={size} color="#888" className={className} /></span>
    case 'github':
      return <span style={ICON_STYLE}><SiGithub size={size} color="#888" className={className} /></span>
    case 'document':
      return <span style={ICON_STYLE}><DocumentIcon size={size} className={className} /></span>
  }
}
