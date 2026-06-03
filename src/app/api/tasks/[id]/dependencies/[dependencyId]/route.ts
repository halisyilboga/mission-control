import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { deleteTaskDependency, TaskDependencyError } from '@/lib/task-dependencies'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dependencyId: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const resolvedParams = await params
    const taskId = Number.parseInt(resolvedParams.id, 10)
    const dependencyId = Number.parseInt(resolvedParams.dependencyId, 10)
    if (!Number.isFinite(taskId) || !Number.isFinite(dependencyId)) {
      return NextResponse.json({ error: 'Invalid dependency ID' }, { status: 400 })
    }

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const actor = auth.user.username || auth.user.display_name || 'system'

    const dependency = deleteTaskDependency(db, { workspaceId, taskId, dependencyId })

    db_helpers.logActivity(
      'task_dependency_deleted',
      'task',
      taskId,
      actor,
      `Removed dependency: task ${dependency.predecessor_task_id} blocks task ${dependency.successor_task_id}`,
      {
        dependency_id: dependency.id,
        predecessor_task_id: dependency.predecessor_task_id,
        successor_task_id: dependency.successor_task_id,
      },
      workspaceId
    )

    eventBus.broadcast('task.dependency_deleted', dependency)

    return NextResponse.json({ success: true, dependency })
  } catch (error) {
    if (error instanceof TaskDependencyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    logger.error({ err: error }, 'DELETE /api/tasks/[id]/dependencies/[dependencyId] error')
    return NextResponse.json({ error: 'Failed to delete task dependency' }, { status: 500 })
  }
}
