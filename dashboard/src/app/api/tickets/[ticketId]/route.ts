import { NextResponse } from 'next/server'
import { fetchTicketById } from '@/lib/linear-data'
import { setupIncompleteResponse } from '@/lib/setup'

export async function GET(_req: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const guard = setupIncompleteResponse(); if (guard) return guard
  const { ticketId } = await params
  const ticket = await fetchTicketById(ticketId)
  if (!ticket) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(ticket)
}
