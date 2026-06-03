import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { getTaskSchedule } from '@/lib/task-dependencies'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const { searchParams } = new URL(request.url)
    const projectId = Number.parseInt(searchParams.get('project_id') || '', 10)

    const schedule = getTaskSchedule(db, {
      workspaceId,
      ...(Number.isFinite(projectId) ? { projectId } : {}),
    })

    return NextResponse.json(schedule)
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/schedule error')
    return NextResponse.json({ error: 'Failed to fetch task schedule' }, { status: 500 })
  }
}
