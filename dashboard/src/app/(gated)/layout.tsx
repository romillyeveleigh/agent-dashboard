import { redirect } from 'next/navigation'
import { Shell } from '@/components/shell'
import { getSetupStatus } from '@/lib/setup'

export default function GatedLayout({ children }: { children: React.ReactNode }) {
  if (!getSetupStatus().complete) {
    redirect('/setup')
  }
  return <Shell>{children}</Shell>
}
