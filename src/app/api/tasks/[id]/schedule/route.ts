import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, db_helpers } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { validateBody, updateTaskScheduleSchema } from '@/lib/validation'
import { applyDependencySummaryToTasks } from '@/lib/task-dependencies'

function formatTicketRef(prefix?: string | null, num?: number | null): string | undefined {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return undefined
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function mapTaskRow(task: any) {
  return {
    ...task,
    tags: task.tags ? JSON.parse(task.tags) : [],
    metadata: task.metadata ? JSON.parse(task.metadata) : {},
    ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const rateCheck = mutationLimiter(request)
  if (rateCheck) return rateCheck

  try {
    const resolvedParams = await params
    const taskId = Number.parseInt(resolvedParams.id, 10)
    if (!Number.isFinite(taskId)) {
      return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
    }

    const validated = await validateBody(request, updateTaskScheduleSchema)
    if ('error' in validated) return validated.error

    const db = getDatabase()
    const workspaceId = auth.user.workspace_id
    const existing = db.prepare(`
      SELECT id, title, start_date, due_date, estimated_hours, duration_hours
      FROM tasks
      WHERE id = ? AND workspace_id = ?
      LIMIT 1
    `).get(taskId, workspaceId) as {
      id: number
      title: string
      start_date?: number | null
      due_date?: number | null
      estimated_hours?: number | null
      duration_hours?: number | null
    } | undefined

    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    const fields: string[] = []
    const values: any[] = []
    for (const field of ['start_date', 'due_date', 'estimated_hours', 'duration_hours'] as const) {
      if (field in validated.data) {
        fields.push(`${field} = ?`)
        values.push(validated.data[field] ?? null)
      }
    }

    if (fields.length === 0) {
      return NextResponse.json({ error: 'At least one schedule field is required' }, { status: 400 })
    }

    const now = Math.floor(Date.now() / 1000)
    values.push(now, taskId, workspaceId)
    db.prepare(`
      UPDATE tasks
      SET ${fields.join(', ')}, updated_at = ?
      WHERE id = ? AND workspace_id = ?
    `).run(...values)

    db_helpers.logActivity(
      'task_schedule_updated',
      'task',
      taskId,
      auth.user.username,
      `Updated schedule for task "${existing.title}"`,
      {
        old: {
          start_date: existing.start_date,
          due_date: existing.due_date,
          estimated_hours: existing.estimated_hours,
          duration_hours: existing.duration_hours,
        },
        updates: validated.data,
      },
      workspaceId
    )

    const updated = db.prepare(`
      SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
      FROM tasks t
      LEFT JOIN projects p
        ON p.id = t.project_id
       AND p.workspace_id = t.workspace_id
      WHERE t.id = ? AND t.workspace_id = ?
    `).get(taskId, workspaceId)

    const task = applyDependencySummaryToTasks(db, workspaceId, [mapTaskRow(updated)])[0]
    eventBus.broadcast('task.schedule_updated', task)
    eventBus.broadcast('task.updated', task)

    return NextResponse.json({ task })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/tasks/[id]/schedule error')
    return NextResponse.json({ error: 'Failed to update task schedule' }, { status: 500 })
  }
}
