import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intervalMs, streamBounds, profileEvents, renderReport } from './profile-session.mjs'

const event = (type, time, data = {}) => ({ type, time, data })
const message = (time, stream, usage = {}) => event('assistant/message', time, { message: { source: { model: 'test-model' } }, stream, usage })
const start = time => event('step/start', time, { turn: 1, step: 1 })
const end = time => event('step/end', time, { turn: 1, step: 1 })
const call = (time, id, args) => event('tool/call', time, { name: 'write', callId: id, arguments: JSON.stringify(args) })
const result = (time, id) => event('tool/result', time, { message: { toolCallId: id, isError: false } })

test('decodes adjacent compact-stream gaps without exporting streamed text', () => {
  assert.deepEqual(streamBounds({ type: 'tool-call-chunks', time0: 10, dt: [2, 5, 7] }), [10, 24])
  assert.equal(intervalMs([[0, 10], [5, 20], [30, 40]]), 30)
})

test('reconciles active time and unions parallel tool calls rather than summing them', () => {
  const rows = [event('turn/start', 0, { turn: 1 }), start(2), message(22, [{ type: 'chunk', time: 5 }, { type: 'text-chunks', time0: 7, dt: [3, 10], texts: ['private', 'reason', 'payload'] }], { totalTokens: 10 }), call(23, 'a', { file_path: '/private/project/styles.css', content: 'SECRET_BODY' }), call(24, 'b', { file_path: '/private/project/app.js', content: 'SECOND_SECRET_BODY' }), result(30, 'a'), result(35, 'b'), end(36), event('turn/end', 38, { turn: 1, reason: { kind: 'completed' } })]
  const profile = profileEvents(rows)
  assert.equal(profile.totals.activeMs, 38)
  assert.equal(profile.totals.waitMs, 3)
  assert.equal(profile.totals.streamMs, 15)
  assert.equal(profile.totals.toolMs, 12)
  assert.equal(profile.totals.waitMs + profile.totals.streamMs + profile.totals.toolMs + profile.totals.otherMs + profile.totals.betweenStepsMs, 38)
  const output = JSON.stringify(profile)
  for (const secret of ['SECRET_BODY', 'SECOND_SECRET_BODY', '/private/project', 'private', 'reason', 'payload']) assert.equal(output.includes(secret), false)
  assert.match(output, /styles.css/)
})

test('separates interruption gaps and ignores untagged restore markers', () => {
  const rows = [event('turn/start', 0, { turn: 1 }), start(0), message(10, [{ type: 'chunk', time: 4 }]), end(10), event('turn/end', 10, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }), event('session/end-seed', 50), event('turn/start', 100, { turn: 2 }), event('step/start', 100, { turn: 2, step: 1 }), message(120, [{ type: 'chunk', time: 110 }]), event('step/end', 120, { turn: 2, step: 1 }), event('turn/end', 120, { turn: 2, reason: { kind: 'completed' } })]
  const profile = profileEvents(rows)
  assert.equal(profile.totals.activeMs, 30)
  assert.equal(profile.totals.wallMs, 120)
  assert.equal(profile.totals.interruptionMs, 90)
  assert.deepEqual(profile.turns.map(t => t.outcome), ['aborted', 'completed'])
})

test('excludes inherited fork history while retaining child-owned work', () => {
  const parent = [event('turn/start', 0, { turn: 1 }), start(0), message(10, [{ type: 'chunk', time: 5 }], { totalTokens: 900 }), end(10), event('turn/end', 10, { turn: 1, reason: { kind: 'completed' } })]
  const child = [{ type: 'session', isSeeded: true }, ...parent, event('session/end-seed', 20, { inherited: true }), event('turn/start', 30, { turn: 1 }), start(30), message(40, [{ type: 'chunk', time: 35 }], { totalTokens: 12 }), end(40), event('turn/end', 40, { turn: 1, reason: { kind: 'completed' } })]
  const profile = profileEvents(child)
  assert.equal(profile.totals.activeMs, 10)
  assert.equal(profile.totals.usage.totalTokens, 12)
  assert.throws(() => profileEvents([{ type: 'session', isSeeded: true }, ...parent]), /boundary/)
})

test('keeps server job lifetime separate from critical-path timing and flags incomplete work', () => {
  const rows = [event('turn/start', 0, { turn: 1 }), event('job/registered', 1, { jobId: 'job', startedAt: 1, kind: 'bash', label: 'PRIVATE_COMMAND' }), event('job/settled', 1000, { jobId: 'job', finishedAt: 1000, status: 'completed', detail: 'exit code: 1' })]
  const profile = profileEvents(rows)
  assert.equal(profile.totals.activeMs, 0)
  assert.equal(profile.jobs[0].end - profile.jobs[0].start, 999)
  assert.equal(profile.jobs[0].exitCode, '1')
  assert.equal(JSON.stringify(profile).includes('PRIVATE_COMMAND'), false)
  assert.match(profile.warnings.join(), /unfinished/)
})

test('keeps script embedding safe and preserves dollar replacement syntax in labels', () => {
  const label = '</script><script>UNTRUSTED</script>$&'
  const output = renderReport('const data=/*PROFILE_DATA*/null;', { label })
  assert.equal(output.includes('</script>'), false)
  assert.equal(output.includes('/*PROFILE_DATA*/null'), false)
  const decoded = JSON.parse(output.slice('const data='.length, -1))
  assert.equal(decoded.label, label)
})

test('flags missing stream timestamps and supports malformed tool arguments as failure evidence', () => {
  const rows = [event('turn/start', 0, { turn: 1 }), start(0), message(10, undefined), event('tool/call', 11, { name: 'bash', callId: 'a', arguments: 'null' }), result(12, 'a'), end(13), event('turn/end', 13, { turn: 1, reason: { kind: 'completed' } })]
  const profile = profileEvents(rows)
  assert.match(profile.warnings.join(), /timings are missing/)
  assert.equal(profile.steps[0].calls[0].label, 'bash · Shell action')
})

test('reads only selected v4 sessions and recorded children, and rejects ambiguous or newer generations', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { zstdCompressSync } = await import('node:zlib')
  const { profileSession } = await import('./profile-session.mjs')
  const home = await mkdtemp(join(tmpdir(), 'codecrew-profile-'))
  try {
    const store = join(home, 'sessions', 'bucket')
    const record = (id, tokens, extra = []) => [{ type: 'session', version: 4, id, isSeeded: false }, ...extra, event('turn/start', 0, { turn: 1 }), start(0), message(10, [{ type: 'chunk', time: 5 }], { totalTokens: tokens }), end(10), event('turn/end', 10, { turn: 1, reason: { kind: 'completed' } })].map(r => JSON.stringify(r)).join('\n')
    for (const id of ['selected', 'child', 'unrelated']) await mkdir(join(store, id), { recursive: true })
    const parent = record('selected', 10, [event('team/member', 0, { member: { id: 'child', phase: 'active' } })])
    await writeFile(join(store, 'selected', 'session.v4.jsonl'), parent)
    await writeFile(join(store, 'child', 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(record('child', 20))))
    await writeFile(join(store, 'unrelated', 'session.v4.jsonl'), 'UNREADABLE_UNRELATED_SESSION')
    const profile = await profileSession(home, 'selected', 'Fixture')
    assert.equal(profile.workers.length, 1)
    assert.equal(profile.allAgentUsage.totalTokens, 30)
    assert.deepEqual(profile.warnings, [])
    await writeFile(join(store, 'selected', 'session.v5.jsonl'), '')
    await assert.rejects(() => profileSession(home, 'selected', 'Fixture'), /v4/)
    await rm(join(store, 'selected', 'session.v5.jsonl'))
    await writeFile(join(store, 'selected', 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(parent)))
    await assert.rejects(() => profileSession(home, 'selected', 'Fixture'), /Ambiguous/)
    await assert.rejects(() => profileSession(home, '../unrelated', 'Fixture'), /single directory/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('keeps a preferences-file read separate from creating a visual reference', () => {
  const source = [event('turn/start', 0, { turn: 1 }), start(0), message(10, [{ type: 'chunk', time: 5 }]), event('tool/call', 11, { name: 'read', callId: 'a', arguments: JSON.stringify({ file_path: '/home/UI-PREFERENCES.md' }) }), result(12, 'a'), end(13), event('turn/end', 13, { turn: 1, reason: { kind: 'completed' } })]
  assert.equal(profileEvents(source).steps[0].category, 'Context and setup')
})

test('records queue and startup intervals without exporting assignment identities', () => {
  const rows = ['queued', 'starting', 'starting', 'running'].map((phase, i) => event('team/dispatch', [100, 106, 110, 250][i], { dispatch: { taskId: 'PRIVATE_TASK', name: 'PRIVATE_WORKER', taskRevision: 1, phase } }))
  rows.push(event('team/dispatch', 300, { dispatch: { taskId: 'PRIVATE_TASK', name: 'PRIVATE_WORKER', taskRevision: 2, phase: 'queued' } }))
  const profile = profileEvents(rows)
  assert.equal(profile.assignments.length, 2)
  assert.equal(profile.assignments[1].queued, 300)
  assert.equal(profile.assignments[0].starting - profile.assignments[0].queued, 6)
  assert.equal(profile.assignments[0].running - profile.assignments[0].starting, 144)
  assert.equal(JSON.stringify(profile).includes('PRIVATE_'), false)
})
