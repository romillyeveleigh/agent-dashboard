import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { dashboardCache } from '@/lib/schema'
import { setupIncompleteResponse } from '@/lib/setup'

export async function GET() {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const row = db.select().from(dashboardCache).get()
  if (!row) {
    return NextResponse.json({ data: null })
  }
  return NextResponse.json({ data: JSON.parse(row.dashboardJson), updatedAt: row.updatedAt })
}
