import { redirect } from 'next/navigation'
import { getSetupStatus } from '@/lib/setup'
import { SetupWizard } from './wizard'

export const dynamic = 'force-dynamic'

export default function SetupPage() {
  // Once setup is complete, settings lives inside the dashboard shell at
  // /settings. /setup is only the first-run wizard (where the gate redirects
  // when setup is incomplete).
  if (getSetupStatus().complete) redirect('/settings')
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SetupWizard />
    </div>
  )
}
