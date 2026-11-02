/** Live dependency flowchart derived from the durable shared task board. */
import { useId } from 'react'
import type { TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team/client'
import css from './TeamAction.module.css'

/**
 * Render ready work in parallel columns and dependent work after its blockers.
 * @param props - current task board and localized accessible label.
 * @returns a scrollable graph; the detailed task cards remain the textual alternative.
 */
export function TaskGraph({ tasks, label }: { tasks: readonly TeamTaskView[]; label: string }) {
  const id = useId()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const levels = new Map<string, number>()
  const level = (task: TeamTaskView): number => {
    const known = levels.get(task.id)
    if (known !== undefined) return known
    const parents = task.blockedBy.map(id => byId.get(id)).filter((value): value is TeamTaskView => value !== undefined)
    const result = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(level))
    levels.set(task.id, result)
    return result
  }
  const rows = new Map<number, number>()
  const nodes = tasks.map((task) => {
    const column = level(task)
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { task, x: column * 220 + 8, y: row * 76 + 8 }
  })
  const positions = new Map(nodes.map(node => [node.task.id, node]))
  const width = Math.max(200, ...nodes.map(node => node.x + 188))
  const height = Math.max(68, ...nodes.map(node => node.y + 60))
  return <div className={css.taskGraph} role="region" aria-label={label} tabIndex={0}>
    <svg width={width} height={height} role="img" aria-label={label}>
      <defs><marker id={id} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {nodes.flatMap(node => node.task.blockedBy.map((parentId) => {
        const parent = positions.get(parentId)
        if (parent === undefined) return null
        return <path key={`${parentId}-${node.task.id}`} d={`M ${parent.x + 180} ${parent.y + 26} C ${parent.x + 200} ${parent.y + 26}, ${node.x - 20} ${node.y + 26}, ${node.x} ${node.y + 26}`} fill="none" stroke="currentColor" markerEnd={`url(#${id})`} />
      }))}
      {nodes.map(({ task, x, y }) => <g key={task.id} transform={`translate(${x},${y})`} className={css.graphNode} data-status={task.status}>
        <title>{task.subject}</title><rect width="180" height="52" rx="8" />
        <text x="10" y="21">{task.subject.length > 23 ? task.subject.slice(0, 22) + '…' : task.subject}</text>
        <text x="10" y="39" className={css.graphOwner}>{task.ownerName ?? task.id}</text>
      </g>)}
    </svg>
  </div>
}
