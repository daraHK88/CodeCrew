#!/usr/bin/env node
/** Offline timing analysis of explicitly selected CodeCrew v4 sessions and their recorded children. */
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { createHash } from 'node:crypto'

/** Union duration: concurrent operations count once on the owning wall clock. */
export function intervalMs(intervals) {
  const sorted = intervals.filter(([a, b]) => Number.isFinite(a) && b >= a).sort((a, b) => a[0] - b[0])
  let total = 0, start, end
  for (const [a, b] of sorted) {
    if (start === undefined) { start = a; end = b }
    else if (a <= end) end = Math.max(end, b)
    else { total += end - start; start = a; end = b }
  }
  return total + (start === undefined ? 0 : end - start)
}

/** Compact stream dt values are adjacent gaps, not offsets from time0. */
export function streamBounds(record) {
  if (record.type === 'chunk') {
    if (!Number.isSafeInteger(record.time)) throw new Error('Invalid assistant stream timing')
    return [record.time, record.time]
  }
  if (!['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(record.type)) throw new Error('Unsupported assistant stream record')
  if (!Array.isArray(record.dt) || record.dt.some(delta => !Number.isSafeInteger(delta) || delta < 0)) throw new Error('Invalid or non-monotonic assistant stream timing')
  const end = record.time0 + record.dt.reduce((sum, delta) => sum + delta, 0)
  if (![record.time0, end].every(Number.isSafeInteger) || end < record.time0) throw new Error('Invalid assistant stream timing')
  return [record.time0, end]
}

function shellLabel(args) {
  const text = `${args.description ?? ''} ${args.command ?? ''}`
  if (/contrast/i.test(text)) return 'Text contrast audit'
  if (/visual concept|visual reference|reference\.(?:svg|png)/i.test(text)) return 'Visual reference render'
  if (/command -v|--help|require\.resolve|locate.*(?:browser|playwright)/i.test(text)) return 'Runtime discovery'
  if (/^\s*python\S*\s+-m\s+http\.server/.test(args.command ?? '')) return 'Local static server'
  if (/playwright|chromium|puppeteer|tests\/dashboard/i.test(text)) return 'Browser checks or capture'
  if (/git diff|git status|node --check|--input-type=module --check/i.test(text)) return 'Source or syntax checks'
  return 'Shell action'
}

function toolLabel(name, args) {
  if (name === 'bash') return `bash · ${shellLabel(args)}`
  if (typeof args.file_path === 'string') return `${name} · ${basename(args.file_path)}`
  if (name === 'select_model_profile' && typeof args.profile === 'string') return `${name} · ${args.profile.slice(0, 48)}`
  return name
}

function category(calls) {
  if (calls.some(c => /visual reference|reference\.(?:svg|png|webp)\b/i.test(c.label))) return 'Visual reference'
  if (calls.some(c => ['write', 'edit', 'edit_lines'].includes(c.tool) && /README|\.md\b/.test(c.label))) return 'Delivery documentation'
  if (calls.some(c => ['write', 'edit', 'edit_lines'].includes(c.tool) && /dashboard\.mjs|test|spec/.test(c.label))) return 'Test authoring'
  if (calls.some(c => ['write', 'edit', 'edit_lines'].includes(c.tool))) return 'Implementation or repair'
  if (calls.some(c => c.tool === 'read_image')) return 'Visual review'
  if (calls.some(c => c.tool === 'bash' && /Browser|contrast|Source|syntax/.test(c.label))) return 'Verification'
  if (calls.length && calls.every(c => /^(team_|todo_|select_model_profile|get_goal|list_agents|send_message|wait_agent)/.test(c.tool))) return 'Coordination'
  if (calls.some(c => /^(read|glob|grep|working_directory|bash)$/.test(c.tool))) return 'Context and setup'
  return calls.length ? 'Mixed or other' : 'Reply or interrupted request'
}

function addUsage(target, usage = {}) {
  for (const [key, value] of Object.entries(usage)) if (typeof value === 'number') target[key] = (target[key] ?? 0) + value
}

/** Derive timings without exposing prompts, reasoning text, tool bodies or shell commands. */
export function profileEvents(input, role = 'Lead') {
  const header = input.find(row => row.type === 'session')
  let cut = -1
  input.forEach((row, index) => { if (row.type === 'session/end-seed' && row.data.inherited === true) cut = index })
  if (header?.isSeeded && cut < 0) throw new Error('Fork recording lacks its inherited-history boundary')
  const rows = input.slice(cut + 1)
  const results = new Map(rows.filter(r => r.type === 'tool/result').map(r => [r.data.message.toolCallId, r]))
  const steps = [], turns = [], jobs = [], children = new Set(), warnings = [], assignments = new Map()
  let step, turn, previousModel
  for (const row of rows) {
    const d = row.data ?? {}
    if (row.type === 'team/member' && d.member.phase === 'active') children.add(d.member.id)
    if (row.type === 'subagent/catalog') children.add(d.childId)
    if (row.type === 'team/dispatch') {
      const assignment = d.dispatch, key = assignment.taskId + '\0' + assignment.name + '\0' + assignment.taskRevision
      if (!assignments.has(key)) assignments.set(key, { index: assignments.size + 1 })
      const record = assignments.get(key)
      record[assignment.phase] ??= row.time
    }
    if (row.type === 'turn/start') turn = { start: row.time, turn: d.turn }
    if (row.type === 'turn/end' && turn) { turns.push({ ...turn, end: row.time, outcome: d.reason.kind, cause: d.reason.reason?.kind }); turn = undefined }
    if (row.type === 'step/start') step = { turn: d.turn, step: d.step, start: row.time, attempts: [], calls: [] }
    if (row.type === 'job/registered') jobs.push({ start: d.startedAt, kind: d.kind, id: d.jobId })
    if (row.type === 'job/settled') {
      const job = jobs.find(j => j.id === d.jobId)
      if (job) { job.end = d.finishedAt; job.status = d.status; job.exitCode = /exit code: (-?\d+)/.exec(d.detail ?? '')?.[1] }
    }
    if (!step) continue
    if (row.type === 'assistant/message' || row.type === 'assistant/attempt') step.attempts.push(row)
    if (row.type === 'tool/call') {
      let args = {}
      try {
        const value = JSON.parse(d.arguments)
        if (value && typeof value === 'object' && !Array.isArray(value)) args = value
      } catch (error) { /* Invalid model-generated JSON remains useful failure evidence. */ }
      const result = results.get(d.callId)
      step.calls.push({ tool: d.name, label: toolLabel(d.name, args), start: row.time, end: result?.time,
        error: result?.data.message.isError ?? false, argumentBytes: Buffer.byteLength(d.arguments),
        generatedBytes: Buffer.byteLength(typeof args.content === 'string' ? args.content : typeof args.new_string === 'string' ? args.new_string : ''),
        fingerprint: createHash('sha256').update(d.name + '\0' + d.arguments).digest('hex').slice(0, 12) })
    }
    if (row.type !== 'step/end') continue
    step.end = row.time
    step.durationMs = step.end - step.start
    if (step.durationMs < 0) throw new Error('Non-monotonic session clock prevents valid timing')
    let cursor = step.start, waitMs = 0
    const streams = [], argStreams = []
    step.usage = {}
    for (const attempt of step.attempts) {
      if (!Array.isArray(attempt.data.stream)) {
        warnings.push('Assistant stream timings are missing; the model-phase breakdown is incomplete.')
        addUsage(step.usage, attempt.data.usage)
        cursor = attempt.time
        continue
      }
      const records = attempt.data.stream, bounds = records.map(streamBounds)
      const first = bounds.length ? Math.min(...bounds.map(b => b[0])) : attempt.time
      const last = bounds.length ? Math.max(...bounds.map(b => b[1])) : first
      waitMs += Math.max(0, first - cursor)
      streams.push([first, last])
      argStreams.push(...records.filter(r => r.type === 'tool-call-chunks').map(streamBounds))
      cursor = attempt.time
      addUsage(step.usage, attempt.data.usage)
    }
    step.model = step.attempts.find(a => a.type === 'assistant/message')?.data.message.source.model ?? 'interrupted'
    step.modelChanged = Boolean(previousModel && step.model !== 'interrupted' && step.model !== previousModel)
    if (step.model !== 'interrupted') previousModel = step.model
    step.waitMs = waitMs
    step.streamMs = intervalMs(streams)
    step.argumentStreamMs = intervalMs(argStreams)
    step.toolMs = intervalMs(step.calls.map(c => [Math.max(c.start, step.start), Math.min(c.end ?? step.end, step.end)]))
    step.otherMs = step.durationMs - step.waitMs - step.streamMs - step.toolMs
    if (step.otherMs < 0) warnings.push('Overlapping or non-monotonic phases; phase sums are not additive for every step.')
    step.category = category(step.calls)
    delete step.attempts
    steps.push(step)
    step = undefined
  }
  if (step || turn) warnings.push('Recording contains unfinished work; completed active time is a lower bound.')
  const totals = { activeMs: turns.reduce((sum, t) => sum + t.end - t.start, 0), waitMs: 0, streamMs: 0, toolMs: 0, otherMs: 0, argumentStreamMs: 0, usage: {} }
  for (const s of steps) {
    for (const key of ['waitMs', 'streamMs', 'toolMs', 'otherMs', 'argumentStreamMs']) totals[key] += s[key]
    addUsage(totals.usage, s.usage)
  }
  totals.betweenStepsMs = totals.activeMs - steps.reduce((sum, s) => sum + s.durationMs, 0)
  totals.wallMs = turns.length ? turns.at(-1).end - turns[0].start : 0
  totals.interruptionMs = totals.wallMs - totals.activeMs
  totals.toolCalls = steps.reduce((sum, s) => sum + s.calls.length, 0)
  totals.toolErrors = steps.flatMap(s => s.calls).filter(c => c.error).length
  return { role, turns, steps, assignments: [...assignments.values()], jobs: jobs.map(({ id, ...job }) => job), totals, warnings: [...new Set(warnings)], children: [...children] }
}

async function readSession(home, id) {
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('Session ID must be a single directory name')
  const root = join(home, 'sessions')
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue
    const dir = join(root, bucket.name, id)
    let entries
    try { if (!(await lstat(dir)).isDirectory()) continue; entries = await readdir(dir) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const candidates = entries.flatMap(name => {
      const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)
      return match ? [{ name, version: Number(match[1]) }] : []
    }).sort((a, b) => b.version - a.version || Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')))
    if (!candidates.length) throw new Error('Selected session has no versioned recording')
    const file = candidates[0]
    if (candidates.filter(c => c.version === file.version).length > 1) throw new Error('Ambiguous packed and unpacked recording; use a settled snapshot')
    if (file.version !== 4) throw new Error('Only the current v4 session format is supported')
    if (!(await lstat(join(dir, file.name))).isFile()) throw new Error('Session recording must be a regular file')
    let bytes = await readFile(join(dir, file.name))
    if (file.name.endsWith('.zstd')) bytes = zstdDecompressSync(bytes)
    const rows = bytes.toString('utf8').trim().split('\n').map(JSON.parse)
    if (rows[0]?.type !== 'session' || rows[0]?.version !== 4 || rows[0]?.id !== id) throw new Error('Session header does not match the selected recording')
    return rows
  }
  throw new Error('Selected session recording was not found')
}

/** Analyze only the selected session and children explicitly recorded by it. */
export async function profileSession(home, id, label) {
  const lead = profileEvents(await readSession(home, id))
  const seen = new Set([id]), queue = [...lead.children], workers = [], warnings = []
  while (queue.length) {
    const child = queue.shift()
    if (seen.has(child)) continue
    seen.add(child)
    try {
      const profile = profileEvents(await readSession(home, child), `Worker ${workers.length + 1}`)
      workers.push(profile)
      queue.push(...profile.children)
    } catch (error) { warnings.push('A recorded child could not be profiled; all-agent totals are partial.') }
  }
  const usage = {}
  for (const member of [lead, ...workers]) { addUsage(usage, member.totals.usage); delete member.children }
  return { label, lead, workers, allAgentUsage: usage, warnings }
}

/** Embed report data as a script literal while preserving labels and blocking HTML termination. */
export function renderReport(template, result) {
  return template.replace('/*PROFILE_DATA*/null', () => JSON.stringify(result).replaceAll('<', '\\u003c'))
}

async function main() {
  const args = process.argv.slice(2), options = {}
  if (args.includes('--help')) {
    console.log('node coding/profile-session.mjs --session ID [--compare ID] [--home DIR] --out DIR\nReads only selected v4 sessions and their recorded children. Writes profile.json and a standalone report.html locally.')
    return
  }
  while (args.length) {
    const key = args.shift(), value = args.shift()
    if (!['--session', '--compare', '--home', '--out'].includes(key) || !value || value.startsWith('--')) throw new Error('Use --help for required session and output arguments')
    options[key.slice(2)] = value
  }
  if (!options.session || !options.out) throw new Error('Use --session ID and --out DIR')
  const home = resolve(options.home ?? process.env.DSH_HOME ?? '.coding-home')
  const cases = []
  if (options.compare) cases.push(await profileSession(home, options.compare, 'Previous'))
  cases.push(await profileSession(home, options.session, 'Latest'))
  const result = { generatedAt: new Date().toISOString(), method: 'Wait is step start to first received chunk, including local request preparation, network and provider delay. Stream is first-to-last received chunk. Tool durations are interval unions, not sums. Worker and job lanes overlap the lead; never add them to its critical path. No raw prompts, reasoning text, shell commands or tool bodies are exported. Labels retain file basenames and model names.', cases }
  const out = resolve(options.out)
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'profile.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  const template = await readFile(new URL('./session-profile.html', import.meta.url), 'utf8')
  await writeFile(join(out, 'report.html'), renderReport(template, result), { mode: 0o600 })
  console.log(JSON.stringify(cases.map(c => ({ label: c.label, activeMs: c.lead.totals.activeMs, waitMs: c.lead.totals.waitMs, streamMs: c.lead.totals.streamMs, toolMs: c.lead.totals.toolMs, workers: c.workers.length, warnings: c.warnings })), null, 2))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
