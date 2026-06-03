import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, createTaskDependencySchema } from '@/lib/validation'
import { createTaskDependency, TaskDependencyError } from '@/lib/task-dependencies'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const resolvedParams = await params
    const successorTaskId = Number.parseInt(resolvedParams.id, 10)
    if (!Number.isFinite(successorTaskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const validated = await validateBody(request, createTaskDependencySchema)
    if ('error' in validated) return validated.error

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const actor = auth.user.username || auth.user.display_name || 'system'

    const dependency = createTaskDependency(db, {
      workspaceId,
      predecessorTaskId: validated.data.predecessor_task_id,
      successorTaskId,
      type: validated.data.type,
      lagMinutes: validated.data.lag_minutes,
      createdBy: actor,
    })

    db_helpers.logActivity(
      'task_dependency_created',
      'task',
      successorTaskId,
      actor,
      `Added dependency: task ${dependency.predecessor_task_id} blocks task ${successorTaskId}`,
      {
        dependency_id: dependency.id,
        predecessor_task_id: dependency.predecessor_task_id,
        successor_task_id: dependency.successor_task_id,
        type: dependency.type,
        lag_minutes: dependency.lag_minutes,
      },
      workspaceId
    )

    eventBus.broadcast('task.dependency_created', dependency)

    return NextResponse.json({ dependency }, { status: 201 })
  } catch (error) {
    if (error instanceof TaskDependencyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
    }
    logger.error({ err: error }, 'POST /api/tasks/[id]/dependencies error')
    return NextResponse.json({ error: 'Failed to create task dependency' }, { status: 500 })
  }
}
