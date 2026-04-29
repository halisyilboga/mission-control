import type Database from 'better-sqlite3'

export type TaskDependencyType =
  | 'finish_to_start'
  | 'start_to_start'
  | 'finish_to_finish'
  | 'start_to_finish'

export type DependencyRisk = 'none' | 'blocked' | 'at_risk' | 'off_track'

export interface TaskDependency {
  id: number
  workspace_id: number
  predecessor_task_id: number
  successor_task_id: number
  type: TaskDependencyType
  lag_minutes: number
  created_by: string
  created_at: number
  predecessor_title?: string
  predecessor_status?: string
  predecessor_due_date?: number | null
  predecessor_ticket_ref?: string | null
  successor_title?: string
  successor_status?: string
  successor_start_date?: number | null
  successor_due_date?: number | null
  successor_ticket_ref?: string | null
}

export interface TaskDependencySummary {
  blocked_by_count: number
  blocks_count: number
  incomplete_blockers_count: number
  is_blocked: boolean
  dependency_risk: DependencyRisk
  off_track: boolean
}

export interface TaskScheduleRow extends TaskDependencySummary {
  id: number
  title: string
  description?: string | null
  status: string
  priority: string
  project_id?: number | null
  project_name?: string | null
  project_prefix?: string | null
  ticket_ref?: string | null
  assigned_to?: string | null
  created_at: number
  updated_at: number
  start_date?: number | null
  due_date?: number | null
  estimated_hours?: number | null
  duration_hours: number
  planned_start: number
  planned_finish: number
  earliest_start: number
  earliest_finish: number
}

type TaskForSummary = {
  id: number
  status?: string | null
  start_date?: number | null
  due_date?: number | null
}

type TaskForSchedule = {
  id: number
  title: string
  description?: string | null
  status: string
  priority: string
  project_id?: number | null
  project_name?: string | null
  project_prefix?: string | null
  project_ticket_no?: number | null
  assigned_to?: string | null
  created_at: number
  updated_at: number
  start_date?: number | null
  due_date?: number | null
  estimated_hours?: number | null
  duration_hours?: number | null
}

export class TaskDependencyError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'task_dependency_error') {
    super(message)
    this.name = 'TaskDependencyError'
    this.status = status
    this.code = code
  }
}

function formatTicketRef(prefix?: string | null, num?: number | null): string | null {
  if (!prefix || typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return null
  return `${prefix}-${String(num).padStart(3, '0')}`
}

function isCompleteStatus(status?: string | null): boolean {
  return status === 'done'
}

function coerceSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function durationSeconds(task: { duration_hours?: number | null; estimated_hours?: number | null }): number {
  const hours = typeof task.duration_hours === 'number' && Number.isFinite(task.duration_hours) && task.duration_hours > 0
    ? task.duration_hours
    : typeof task.estimated_hours === 'number' && Number.isFinite(task.estimated_hours) && task.estimated_hours > 0
      ? task.estimated_hours
      : 8
  return Math.max(1, Math.round(hours * 3600))
}

function plannedWindow(task: TaskForSchedule): { start: number; finish: number; durationHours: number } {
  const duration = durationSeconds(task)
  const due = coerceSeconds(task.due_date)
  const start = coerceSeconds(task.start_date) ?? (due ? Math.max(0, due - duration) : task.created_at)
  const finish = due && due >= start ? due : start + duration
  return {
    start,
    finish,
    durationHours: duration / 3600,
  }
}

export function incompleteBlockersExistsSql(taskAlias = 't'): string {
  return `
    EXISTS (
      SELECT 1
      FROM task_dependencies dep_gate
      JOIN tasks pred_gate
        ON pred_gate.id = dep_gate.predecessor_task_id
       AND pred_gate.workspace_id = dep_gate.workspace_id
      WHERE dep_gate.workspace_id = ${taskAlias}.workspace_id
        AND dep_gate.successor_task_id = ${taskAlias}.id
        AND pred_gate.status <> 'done'
    )
  `
}

export function hasIncompleteBlockingDependencies(
  db: Database.Database,
  workspaceId: number,
  taskId: number
): { blocked: boolean; blockers: Array<{ id: number; title: string; status: string }> } {
  const blockers = db.prepare(`
    SELECT p.id, p.title, p.status
    FROM task_dependencies d
    JOIN tasks p
      ON p.id = d.predecessor_task_id
     AND p.workspace_id = d.workspace_id
    WHERE d.workspace_id = ?
      AND d.successor_task_id = ?
      AND p.status <> 'done'
    ORDER BY p.created_at ASC, p.id ASC
  `).all(workspaceId, taskId) as Array<{ id: number; title: string; status: string }>

  return { blocked: blockers.length > 0, blockers }
}

function getTaskOrThrow(
  db: Database.Database,
  workspaceId: number,
  taskId: number,
  role: 'predecessor' | 'successor'
): { id: number; title: string; status: string; project_id: number | null } {
  const task = db.prepare(`
    SELECT id, title, status, project_id
    FROM tasks
    WHERE id = ? AND workspace_id = ?
    LIMIT 1
  `).get(taskId, workspaceId) as { id: number; title: string; status: string; project_id: number | null } | undefined

  if (!task) {
    throw new TaskDependencyError(`${role === 'predecessor' ? 'Predecessor' : 'Successor'} task not found`, 404, 'task_not_found')
  }
  return task
}

export function wouldCreateCycle(
  db: Database.Database,
  workspaceId: number,
  predecessorTaskId: number,
  successorTaskId: number
): boolean {
  const rows = db.prepare(`
    SELECT predecessor_task_id, successor_task_id
    FROM task_dependencies
    WHERE workspace_id = ?
  `).all(workspaceId) as Array<{ predecessor_task_id: number; successor_task_id: number }>

  rows.push({ predecessor_task_id: predecessorTaskId, successor_task_id: successorTaskId })

  const graph = new Map<number, number[]>()
  for (const row of rows) {
    const next = graph.get(row.predecessor_task_id) || []
    next.push(row.successor_task_id)
    graph.set(row.predecessor_task_id, next)
  }

  const visited = new Set<number>()
  const stack = [successorTaskId]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === predecessorTaskId) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of graph.get(current) || []) {
      stack.push(next)
    }
  }

  return false
}

export function createTaskDependency(
  db: Database.Database,
  input: {
    workspaceId: number
    predecessorTaskId: number
    successorTaskId: number
    type?: TaskDependencyType
    lagMinutes?: number
    createdBy?: string
  }
): TaskDependency {
  const type = input.type || 'finish_to_start'
  const lagMinutes = input.lagMinutes ?? 0

  if (input.predecessorTaskId === input.successorTaskId) {
    throw new TaskDependencyError('A task cannot depend on itself', 400, 'self_dependency')
  }

  getTaskOrThrow(db, input.workspaceId, input.predecessorTaskId, 'predecessor')
  getTaskOrThrow(db, input.workspaceId, input.successorTaskId, 'successor')

  const duplicate = db.prepare(`
    SELECT id
    FROM task_dependencies
    WHERE workspace_id = ?
      AND predecessor_task_id = ?
      AND successor_task_id = ?
      AND type = ?
    LIMIT 1
  `).get(input.workspaceId, input.predecessorTaskId, input.successorTaskId, type) as { id: number } | undefined

  if (duplicate) {
    throw new TaskDependencyError('Dependency already exists', 409, 'duplicate_dependency')
  }

  if (wouldCreateCycle(db, input.workspaceId, input.predecessorTaskId, input.successorTaskId)) {
    throw new TaskDependencyError('Dependency would create a cycle', 400, 'dependency_cycle')
  }

  const result = db.prepare(`
    INSERT INTO task_dependencies (
      workspace_id, predecessor_task_id, successor_task_id, type, lag_minutes, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, unixepoch())
  `).run(
    input.workspaceId,
    input.predecessorTaskId,
    input.successorTaskId,
    type,
    lagMinutes,
    input.createdBy || 'system'
  )

  return getTaskDependencyById(db, input.workspaceId, Number(result.lastInsertRowid))
}

export function getTaskDependencyById(
  db: Database.Database,
  workspaceId: number,
  dependencyId: number
): TaskDependency {
  const row = listTaskDependencies(db, { workspaceId, dependencyId })[0]
  if (!row) throw new TaskDependencyError('Dependency not found', 404, 'dependency_not_found')
  return row
}

export function deleteTaskDependency(
  db: Database.Database,
  input: { workspaceId: number; taskId: number; dependencyId: number }
): TaskDependency {
  const dependency = getTaskDependencyById(db, input.workspaceId, input.dependencyId)
  if (dependency.predecessor_task_id !== input.taskId && dependency.successor_task_id !== input.taskId) {
    throw new TaskDependencyError('Dependency does not belong to this task', 404, 'dependency_not_found')
  }

  db.prepare(`
    DELETE FROM task_dependencies
    WHERE id = ? AND workspace_id = ?
  `).run(input.dependencyId, input.workspaceId)

  return dependency
}

export function listTaskDependencies(
  db: Database.Database,
  input: { workspaceId: number; projectId?: number; taskId?: number; dependencyId?: number }
): TaskDependency[] {
  let query = `
    SELECT d.*,
      p.title as predecessor_title,
      p.status as predecessor_status,
      p.due_date as predecessor_due_date,
      pp.ticket_prefix as predecessor_project_prefix,
      p.project_ticket_no as predecessor_project_ticket_no,
      s.title as successor_title,
      s.status as successor_status,
      s.start_date as successor_start_date,
      s.due_date as successor_due_date,
      sp.ticket_prefix as successor_project_prefix,
      s.project_ticket_no as successor_project_ticket_no
    FROM task_dependencies d
    JOIN tasks p
      ON p.id = d.predecessor_task_id
     AND p.workspace_id = d.workspace_id
    JOIN tasks s
      ON s.id = d.successor_task_id
     AND s.workspace_id = d.workspace_id
    LEFT JOIN projects pp
      ON pp.id = p.project_id
     AND pp.workspace_id = p.workspace_id
    LEFT JOIN projects sp
      ON sp.id = s.project_id
     AND sp.workspace_id = s.workspace_id
    WHERE d.workspace_id = ?
  `
  const params: any[] = [input.workspaceId]

  if (input.dependencyId !== undefined) {
    query += ' AND d.id = ?'
    params.push(input.dependencyId)
  }
  if (input.taskId !== undefined) {
    query += ' AND (d.predecessor_task_id = ? OR d.successor_task_id = ?)'
    params.push(input.taskId, input.taskId)
  }
  if (input.projectId !== undefined) {
    query += ' AND (p.project_id = ? OR s.project_id = ?)'
    params.push(input.projectId, input.projectId)
  }

  query += ' ORDER BY d.created_at ASC, d.id ASC'

  const rows = db.prepare(query).all(...params) as Array<TaskDependency & {
    predecessor_project_prefix?: string | null
    predecessor_project_ticket_no?: number | null
    successor_project_prefix?: string | null
    successor_project_ticket_no?: number | null
  }>

  return rows.map((row) => ({
    ...row,
    predecessor_ticket_ref: formatTicketRef(row.predecessor_project_prefix, row.predecessor_project_ticket_no),
    successor_ticket_ref: formatTicketRef(row.successor_project_prefix, row.successor_project_ticket_no),
  }))
}

export function buildDependencySummaryForTasks(
  db: Database.Database,
  workspaceId: number,
  tasks: TaskForSummary[],
  now = Math.floor(Date.now() / 1000)
): Map<number, TaskDependencySummary> {
  const summaries = new Map<number, TaskDependencySummary>()
  const taskById = new Map<number, TaskForSummary>()
  for (const task of tasks) {
    taskById.set(task.id, task)
    summaries.set(task.id, {
      blocked_by_count: 0,
      blocks_count: 0,
      incomplete_blockers_count: 0,
      is_blocked: false,
      dependency_risk: 'none',
      off_track: !isCompleteStatus(task.status) && typeof task.due_date === 'number' && task.due_date < now,
    })
  }

  if (tasks.length === 0) return summaries

  const placeholders = tasks.map(() => '?').join(', ')
  const taskIds = tasks.map((task) => task.id)
  const rows = db.prepare(`
    SELECT d.predecessor_task_id, d.successor_task_id, d.lag_minutes,
      p.status as predecessor_status,
      p.due_date as predecessor_due_date,
      s.start_date as successor_start_date,
      s.due_date as successor_due_date,
      s.status as successor_status
    FROM task_dependencies d
    JOIN tasks p
      ON p.id = d.predecessor_task_id
     AND p.workspace_id = d.workspace_id
    JOIN tasks s
      ON s.id = d.successor_task_id
     AND s.workspace_id = d.workspace_id
    WHERE d.workspace_id = ?
      AND (
        d.predecessor_task_id IN (${placeholders})
        OR d.successor_task_id IN (${placeholders})
      )
  `).all(workspaceId, ...taskIds, ...taskIds) as Array<{
    predecessor_task_id: number
    successor_task_id: number
    lag_minutes: number
    predecessor_status: string
    predecessor_due_date?: number | null
    successor_start_date?: number | null
    successor_due_date?: number | null
    successor_status: string
  }>

  for (const row of rows) {
    const predecessorSummary = summaries.get(row.predecessor_task_id)
    if (predecessorSummary) {
      predecessorSummary.blocks_count += 1
    }

    const successorSummary = summaries.get(row.successor_task_id)
    if (!successorSummary) continue

    successorSummary.blocked_by_count += 1
    if (!isCompleteStatus(row.predecessor_status)) {
      successorSummary.incomplete_blockers_count += 1
      successorSummary.is_blocked = true

      const successorStart = coerceSeconds(row.successor_start_date)
      const successorDue = coerceSeconds(row.successor_due_date)
      const predecessorDue = coerceSeconds(row.predecessor_due_date)
      const lagSeconds = (row.lag_minutes || 0) * 60

      if (predecessorDue && successorStart && predecessorDue + lagSeconds > successorStart) {
        successorSummary.dependency_risk = 'at_risk'
      }
      if (predecessorDue && successorDue && predecessorDue + lagSeconds > successorDue) {
        successorSummary.off_track = true
      }
    }
  }

  for (const [taskId, summary] of summaries) {
    const task = taskById.get(taskId)
    if (!task) continue
    if (!isCompleteStatus(task.status) && typeof task.due_date === 'number' && task.due_date < now) {
      summary.off_track = true
    }
    if (summary.off_track) summary.dependency_risk = 'off_track'
    else if (summary.is_blocked) summary.dependency_risk = summary.dependency_risk === 'at_risk' ? 'at_risk' : 'blocked'
  }

  return summaries
}

export function applyDependencySummaryToTasks<T extends TaskForSummary>(
  db: Database.Database,
  workspaceId: number,
  tasks: T[],
  now = Math.floor(Date.now() / 1000)
): Array<T & TaskDependencySummary> {
  const summaries = buildDependencySummaryForTasks(db, workspaceId, tasks, now)
  return tasks.map((task) => ({
    ...task,
    ...(summaries.get(task.id) || {
      blocked_by_count: 0,
      blocks_count: 0,
      incomplete_blockers_count: 0,
      is_blocked: false,
      dependency_risk: 'none' as const,
      off_track: false,
    }),
  }))
}

export function getTaskSchedule(
  db: Database.Database,
  input: { workspaceId: number; projectId?: number; now?: number }
): { rows: TaskScheduleRow[]; dependencies: TaskDependency[]; range_start: number | null; range_end: number | null } {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const tasks = db.prepare(`
    SELECT t.*, p.name as project_name, p.ticket_prefix as project_prefix
    FROM tasks t
    LEFT JOIN projects p
      ON p.id = t.project_id
     AND p.workspace_id = t.workspace_id
    WHERE t.workspace_id = ?
    ORDER BY COALESCE(t.start_date, t.due_date, t.created_at) ASC, t.created_at ASC, t.id ASC
  `).all(input.workspaceId) as TaskForSchedule[]

  const dependencies = listTaskDependencies(db, { workspaceId: input.workspaceId })
  const dependencyBySuccessor = new Map<number, TaskDependency[]>()
  for (const dependency of dependencies) {
    const list = dependencyBySuccessor.get(dependency.successor_task_id) || []
    list.push(dependency)
    dependencyBySuccessor.set(dependency.successor_task_id, list)
  }

  const baseRows = new Map<number, TaskScheduleRow>()
  for (const task of tasks) {
    const window = plannedWindow(task)
    baseRows.set(task.id, {
      ...task,
      ticket_ref: formatTicketRef(task.project_prefix, task.project_ticket_no),
      duration_hours: window.durationHours,
      planned_start: window.start,
      planned_finish: window.finish,
      earliest_start: window.start,
      earliest_finish: window.finish,
      blocked_by_count: 0,
      blocks_count: 0,
      incomplete_blockers_count: 0,
      is_blocked: false,
      dependency_risk: 'none',
      off_track: false,
    })
  }

  const memo = new Map<number, { start: number; finish: number }>()
  const visiting = new Set<number>()

  const compute = (taskId: number): { start: number; finish: number } => {
    const memoized = memo.get(taskId)
    if (memoized) return memoized

    const row = baseRows.get(taskId)
    if (!row) return { start: now, finish: now }
    if (visiting.has(taskId)) return { start: row.planned_start, finish: row.planned_finish }
    visiting.add(taskId)

    let earliestStart = row.planned_start
    const duration = Math.max(1, Math.round(row.duration_hours * 3600))

    for (const dependency of dependencyBySuccessor.get(taskId) || []) {
      const predecessor = baseRows.get(dependency.predecessor_task_id)
      if (!predecessor) continue
      const predecessorWindow = compute(dependency.predecessor_task_id)
      const lagSeconds = (dependency.lag_minutes || 0) * 60

      if (dependency.type === 'start_to_start') {
        earliestStart = Math.max(earliestStart, predecessorWindow.start + lagSeconds)
      } else if (dependency.type === 'finish_to_finish') {
        earliestStart = Math.max(earliestStart, predecessorWindow.finish + lagSeconds - duration)
      } else if (dependency.type === 'start_to_finish') {
        earliestStart = Math.max(earliestStart, predecessorWindow.start + lagSeconds - duration)
      } else {
        earliestStart = Math.max(earliestStart, predecessorWindow.finish + lagSeconds)
      }
    }

    const result = { start: earliestStart, finish: earliestStart + duration }
    memo.set(taskId, result)
    visiting.delete(taskId)
    return result
  }

  for (const row of baseRows.values()) {
    const computed = compute(row.id)
    row.earliest_start = computed.start
    row.earliest_finish = computed.finish
  }

  const summary = buildDependencySummaryForTasks(db, input.workspaceId, tasks, now)
  for (const row of baseRows.values()) {
    Object.assign(row, summary.get(row.id))
    if (!isCompleteStatus(row.status)) {
      if (row.earliest_finish > row.planned_finish || (row.due_date && row.earliest_finish > row.due_date)) {
        row.dependency_risk = row.is_blocked ? 'at_risk' : 'at_risk'
      }
      if ((row.due_date && now > row.due_date) || (row.due_date && row.earliest_finish > row.due_date)) {
        row.off_track = true
        row.dependency_risk = 'off_track'
      } else if (row.is_blocked && row.dependency_risk === 'none') {
        row.dependency_risk = 'blocked'
      }
    }
  }

  const outputRows = [...baseRows.values()]
    .filter((row) => input.projectId === undefined || row.project_id === input.projectId)
    .sort((a, b) => a.earliest_start - b.earliest_start || a.id - b.id)

  const visibleIds = new Set(outputRows.map((row) => row.id))
  const visibleDependencies = dependencies.filter((dependency) =>
    visibleIds.has(dependency.predecessor_task_id) || visibleIds.has(dependency.successor_task_id)
  )

  const starts = outputRows.map((row) => row.earliest_start)
  const finishes = outputRows.map((row) => row.earliest_finish)

  return {
    rows: outputRows,
    dependencies: visibleDependencies,
    range_start: starts.length > 0 ? Math.min(...starts) : null,
    range_end: finishes.length > 0 ? Math.max(...finishes) : null,
  }
}
