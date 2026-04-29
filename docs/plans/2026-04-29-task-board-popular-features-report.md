# Mission Control Task Board Feature Report

Date: 2026-04-29

Scope: research the current Mission Control task board and propose 10 popular project-management features to add, starting with Advanced Task Dependencies and Gantt Chart.

Note: I did not find an existing repository plan that enumerates these 10 features. The repo currently contains a CLI/TUI platform PRD under `docs/plans/2026-03-20-mission-control-platform-cli-tui-prd.md`; this report uses the user's explicit starting feature plus codebase findings and current project-management product patterns.

## Current Task Board Snapshot

Mission Control is a Next.js 16, React 19, TypeScript 5.7, SQLite-backed application. The README positions it as a local-first agent orchestration dashboard with task flow, dispatch, quality gates, audit trails, recurring tasks, GitHub sync, and real-time SSE/WebSocket updates.

The current board is implemented mainly in `src/components/panels/task-board-panel.tsx`. It is a single large client component with local UI state, Zustand-backed tasks, project filtering, HTML5 drag/drop, task create/edit/detail modals, comments, quality review, targeted agent sessions, GNAP sync, and read-only Claude Code/Hermes task sections.

Current task shape already includes useful scheduling and planning primitives: `due_date`, `estimated_hours`, `actual_hours`, `project_id`, project ticket numbers, priority, tags, metadata, GitHub issue/PR fields, comments, quality-review state, outcome/resolution, retry/dispatch fields, and recurrence metadata.

Backend routes are mature enough for feature expansion:

- `GET /api/tasks` supports status, assignee, priority, project, limit, and offset filters.
- `POST /api/tasks` creates tasks, assigns project ticket numbers, resolves mentions, emits notifications, broadcasts SSE events, and pushes outbound GitHub/GNAP sync.
- `PUT /api/tasks` bulk-updates status for board drag/drop and enforces Aegis approval before `done`.
- `PUT /api/tasks/[id]` supports partial task updates including due date, estimates, tags, metadata, assignee, project, and outcome fields.
- `GET /api/tasks/queue` atomically claims the next agent task by priority, due date, and creation time.
- Scheduler helpers auto-route inbox tasks, dispatch assigned tasks, run Aegis quality reviews, requeue stale tasks, and spawn recurring task templates.

The main gaps for the requested roadmap are:

- No dependency model or cycle detection.
- No first-class `start_date` or duration model beyond `due_date` and `estimated_hours`.
- No timeline/Gantt layout.
- No saved task views or table layout.
- No custom field definitions; only untyped `metadata`.
- No subtasks/checklists.
- No workload/capacity calendar.
- Analytics are present in separate panels, but not yet a configurable task-board insights surface.

## External Product Patterns

The feature set below is grounded in current patterns from major project-management tools:

- Jira Advanced Roadmaps treats dependencies as work items that must happen in sequence and highlights off-track dependencies when one item puts another at risk: https://support.atlassian.com/jira-software-cloud/docs/what-are-dependencies-in-advanced-roadmaps/
- GitHub Projects supports table, board, and roadmap layouts, custom views, filtering, sorting, grouping, custom fields, configurable charts, and built-in automations: https://docs.github.com/en/issues/planning-and-tracking-with-projects
- GitHub Projects Insights offers current and historical charts, including burn-up style progress and bottleneck visibility: https://docs.github.com/en/issues/planning-and-tracking-with-projects/viewing-insights-from-your-project/about-insights-for-projects
- GitHub Projects built-in workflows update item status from events, auto-add items, and archive items: https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations
- Asana's API model shows how custom fields should be metadata-backed, typed, and scoped to workspace/project/portfolio/task use cases: https://developers.asana.com/docs/custom-fields-guide
- Linear uses timeline views for high-level chronological planning, dependencies, milestones, roadmap context, and project-level sequencing: https://linear.app/docs/timeline and https://linear.app/docs/project-milestones
- monday.com's workload/resource planning view focuses on seeing who is over or under capacity across a timeline: https://support.monday.com/hc/en-us/articles/360010166559-Resource-management-with-Workload

## Recommended 10-Feature Backlog

### 1. Advanced Task Dependencies and Gantt Chart

Why it matters: This is the strongest planning upgrade. It turns the current Kanban board into a schedule-aware control plane where operators can see blockers, sequencing, off-track work, and critical-path risk before agents waste cycles on blocked tasks.

Current fit: Mission Control already has project scoping, due dates, estimates, task status, activity logs, notifications, and agent queue dispatch. It lacks start dates, dependency edges, schedule calculation, and a timeline UI.

Core capabilities:

- Link tasks as `blocks` / `blocked_by`.
- Support dependency types in the data model, with MVP behavior defaulting to finish-to-start.
- Detect and reject cycles.
- Compute `blocked_by_count`, `blocks_count`, `is_blocked`, `dependency_risk`, and `off_track`.
- Add a project-scoped Gantt/timeline view with task bars, dependency connectors, delayed/off-track coloring, and week/month zoom.
- Prevent or warn before dispatching blocked tasks to agents.

Implementation plan:

1. Add migration `047_task_dependencies_and_schedule`.
   - Add `start_date INTEGER` to `tasks`.
   - Optionally add `duration_hours REAL` if `estimated_hours` is not sufficient.
   - Create `task_dependencies` with `id`, `workspace_id`, `predecessor_task_id`, `successor_task_id`, `type`, `lag_minutes`, `created_by`, `created_at`.
   - Add uniqueness on `(workspace_id, predecessor_task_id, successor_task_id, type)`.
   - Add indexes for predecessor, successor, project/workspace task lookups.

2. Add validation schemas.
   - `createTaskDependencySchema`
   - `updateTaskScheduleSchema`
   - `deleteTaskDependencySchema`
   - Extend task schemas to accept `start_date` and maybe `duration_hours`.

3. Add API routes.
   - `GET /api/tasks/dependencies?project_id=...`
   - `POST /api/tasks/[id]/dependencies`
   - `DELETE /api/tasks/[id]/dependencies/[dependencyId]`
   - `PATCH /api/tasks/[id]/schedule`
   - Optional: `GET /api/tasks/schedule?project_id=...` to return enriched timeline rows.

4. Add domain helpers under `src/lib/task-dependencies.ts`.
   - Validate same workspace.
   - Reject self-dependencies.
   - Reject duplicate edges.
   - Use DFS or SQLite recursive CTE to reject cycles.
   - Calculate dependency completion state.
   - Calculate earliest start / finish and off-track status.

5. Update dispatch and queue behavior.
   - Update `GET /api/tasks/queue` so incomplete blocking predecessors keep a task unclaimable unless a query flag permits warnings-only mode.
   - Update `autoRouteInboxTasks` and `dispatchAssignedTasks` with the same blocked-task predicate.
   - Log blocked dispatch skips as activity, but avoid noisy notifications.

6. Add UI incrementally.
   - Extract reusable task types and task-card/detail pieces from `task-board-panel.tsx`.
   - Add Board / Timeline segmented control in the Task Board header.
   - Add dependency badges to task cards.
   - Add a Dependency section in the task detail modal.
   - Add `TaskGanttView` as a scrollable timeline grid with CSS bars and SVG connectors. No new dependency is required for MVP; React and CSS are enough.

7. Add tests.
   - Unit tests: cycle detection, off-track calculation, enriched schedule rows.
   - API tests: create/list/delete dependency, reject cross-workspace and cyclic links, schedule update.
   - Queue tests: blocked task is not assigned until predecessor is complete.
   - Playwright tests: toggle timeline, create dependency, verify blocked badge and connector.

Risks:

- The task board file is already large; implementation should extract components before adding a timeline.
- Timezone and Unix timestamp handling must be consistent with current `due_date`.
- GitHub sync has no first-class equivalent for dependency edges; treat dependency sync as future work.
- The UI must handle more than 50 tasks without unusable horizontal/vertical scrolling.

Open product questions:

- Should dependencies hard-block agent dispatch, or only warn? Recommendation: hard-block for `finish_to_start` blockers, with an operator override.
- Are project-level dependencies enough for MVP, or should cross-project dependencies be allowed? Recommendation: allow same-workspace cross-project edges in API, but default UI to current project.
- Should `awaiting_owner` remain a computed keyword/status concept, or should dependency-blocked tasks get a separate computed badge? Recommendation: avoid adding a new status; expose computed `is_blocked`.

### 2. Saved Views, Advanced Filters, and Table Layout

Why it matters: GitHub Projects and Linear both rely on multiple views so different roles can inspect the same work in different ways. Mission Control has a board and basic project/status filters, but no saved filters or dense table.

Plan:

- Add `task_views` table: `workspace_id`, `name`, `scope`, `filters`, `sort`, `group_by`, `layout`, `created_by`, timestamps.
- Extend `GET /api/tasks` with `q`, tags, overdue, created_by, updated range, due range, has_pr, blocked, recurring, and sort parameters.
- Add table layout with visible column controls.
- Persist user defaults in local storage first; DB-backed shared views later.
- Add tests for query filtering and saved-view CRUD.

### 3. Custom Fields and Field Library

Why it matters: Current task `metadata` is flexible but ungoverned. A custom field library gives operators structured fields for team, phase, customer, risk, severity, environment, SLA, and cost center.

Plan:

- Add `custom_fields` and `task_custom_field_values`.
- Support types: text, number, enum, multi_enum, date, people, boolean, URL.
- Scope fields by workspace and optionally project.
- Render fields in task detail, table view, filters, exports, and analytics.
- Migrate selected known metadata keys into field definitions only when safe.

### 4. Subtasks, Checklists, and Acceptance Criteria

Why it matters: Agent tasks often need a definition of done. Subtasks and checklists reduce ambiguity and let the Aegis quality gate evaluate concrete acceptance criteria.

Plan:

- Add `task_checklist_items` with status, assignee, order, and optional evidence.
- Add optional parent-child task relation through `parent_task_id` or a `task_links` table.
- Add checklist UI in task detail.
- Block `done` unless required checklist items are complete, or include a reviewer override.
- Include checklist context in dispatch prompts and Aegis review prompts.

### 5. Milestones, Releases, and Project Roadmap

Why it matters: Linear and GitHub both surface milestones to group work into meaningful phases. Mission Control projects have deadlines and tickets, but not milestones.

Plan:

- Add `project_milestones` with target date, description, ordering, status, and optional color.
- Add `milestone_id` to tasks.
- Show milestone progress in project manager and task board filters.
- Add milestone markers on the Gantt view.
- Add tests for milestone CRUD and progress computation.

### 6. Workload and Agent Capacity Planning

Why it matters: Mission Control already has agents and estimated hours. The missing piece is a workload calendar that shows over-assigned agents and upcoming capacity issues.

Plan:

- Add per-agent capacity settings in agent config or a new `agent_capacity` table.
- Compute workload from `start_date`, `due_date`, `estimated_hours`, status, and assignee.
- Add a Workload view grouped by agent, with over-capacity warnings.
- Feed capacity into `autoRouteInboxTasks` and queue claim logic.
- Add tests for capacity calculations and routing.

### 7. Automation Rules, SLA Reminders, and Escalations

Why it matters: Mission Control has scheduler jobs, webhooks, alerts, and recurring tasks, but task-board automation is not operator-configurable.

Plan:

- Add task automation rules: trigger, condition, action.
- MVP triggers: task created, status changed, due soon, overdue, dependency unblocked, review rejected.
- MVP actions: assign, move status, add comment, notify subscriber, webhook, spawn agent, set priority.
- Reuse existing scheduler and alert-rule concepts where possible.
- Include dry-run preview and activity logs.

### 8. Task Insights, Flow Metrics, and Bottleneck Reports

Why it matters: Current dashboard widgets show counts, and task outcome/regression endpoints exist, but there is no configurable board-level insight surface comparable to GitHub Projects Insights.

Plan:

- Add task analytics endpoint for cycle time, lead time, WIP by status, aging WIP, completion trend, blocked time, review rejection rate, and throughput.
- Reuse Recharts already in the dependency set.
- Add current and historical charts to task board.
- Add export to JSON/CSV through existing export patterns.
- Add tests for metric correctness using seeded timestamps.

### 9. Task Templates, Intake Forms, and Bulk Import

Why it matters: Operators need repeatable task creation beyond recurring schedules. Templates and forms reduce malformed tasks and help agents receive complete context.

Plan:

- Add `task_templates` with title, description, checklist, default fields, project, tags, priority, and assignee.
- Add lightweight intake form definitions per project.
- Add CSV/JSON import endpoint with validation preview.
- Add "Create from template" entry point in task board.
- Add tests for template CRUD, form submission, and import validation.

### 10. Time Tracking, Estimate Variance, and Forecasting

Why it matters: `estimated_hours` and `actual_hours` exist, but there is no timesheet/timer or forecasting loop. This is high value for agent cost planning and workload accuracy.

Plan:

- Add `task_time_entries` with task, actor, source, started_at, ended_at, duration, note.
- Add timer controls for human operators and agent-reported work segments.
- Roll up actual hours to tasks.
- Compare estimate vs actual by project, assignee, priority, and tag.
- Use actual history to recommend better estimates and capacity buffers.

## Recommended Delivery Order

1. Dependencies data model and API.
2. Dependency-aware task detail and board badges.
3. Gantt/timeline MVP.
4. Queue/dispatch gating for blocked tasks.
5. Milestones.
6. Saved views and advanced filters.
7. Workload/capacity planning.
8. Custom fields.
9. Analytics/insights.
10. Templates/forms and time tracking.

Reasoning: dependencies and Gantt need scheduling fields. Milestones and saved views then make the timeline usable at project scale. Workload and analytics become more accurate after dependency/schedule data exists. Custom fields/templates/time tracking are valuable but less urgent for the first planning loop.

## Implementation Notes For This Codebase

- Keep SQLite as the source of truth and use migrations through `src/lib/migrations.ts`.
- Keep API shape consistent with `openapi.json` and `/api/index`; run `pnpm api:parity`.
- Add Zod schemas in `src/lib/validation.ts`.
- Preserve workspace scoping on every new table and query.
- Use SSE broadcasts for dependency and schedule changes: `task.dependency_created`, `task.dependency_deleted`, `task.schedule_updated`, and `task.unblocked`.
- Add i18n keys in all `messages/*.json`; English first is not enough for this repo.
- Avoid stuffing new structured features into `metadata` once they affect query behavior. `metadata` is acceptable for experimental UI-only fields, but dependencies, milestones, views, custom fields, and time entries need tables.
- Prefer no new charting dependency for Gantt MVP. `recharts` is good for analytics, but Gantt can start as CSS grid + SVG overlay.
- Keep Aegis approval behavior intact: a dependency system should prevent premature dispatch, while Aegis should continue to gate final completion.

## Success Metrics

- Operators can create and remove task dependencies without invalid cycles.
- Blocked tasks are visibly marked and not auto-dispatched until unblocked.
- Timeline shows at least 200 project tasks with acceptable interaction latency.
- Off-track dependencies are highlighted before successor due dates are missed.
- Task queue tests prove dependency gating works.
- No OpenAPI parity drift after adding routes.
- Existing task CRUD, queue, comments, quality review, GitHub sync, and recurring task tests still pass.
