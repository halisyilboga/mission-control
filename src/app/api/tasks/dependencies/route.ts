import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { logger } from '@/lib/logger'
import { listTaskDependencies } from '@/lib/task-dependencies'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const { searchParams } = new URL(request.url)
    const projectId = Number.parseInt(searchParams.get('project_id') || '', 10)
    const taskId = Number.parseInt(searchParams.get('task_id') || '', 10)

    const dependencies = listTaskDependencies(db, {
      workspaceId,
      ...(Number.isFinite(projectId) ? { projectId } : {}),
      ...(Number.isFinite(taskId) ? { taskId } : {}),
    })

    return NextResponse.json({ dependencies })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/tasks/dependencies error')
    return NextResponse.json({ error: 'Failed to fetch task dependencies' }, { status: 500 })
  }
}
