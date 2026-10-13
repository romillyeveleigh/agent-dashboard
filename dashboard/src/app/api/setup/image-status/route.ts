import { NextResponse } from 'next/server'
import { checkImageExists, getImageName } from '@/lib/docker'

export const dynamic = 'force-dynamic'

// GET /api/setup/image-status — lightweight check whether the agent worker
// Docker image exists locally. Cached inside docker.ts for 30s. Not gated by
// setupIncompleteResponse so it works even before required vars are set.
export async function GET() {
  const imageExists = await checkImageExists()
  return NextResponse.json({ imageExists, imageName: getImageName() })
}
