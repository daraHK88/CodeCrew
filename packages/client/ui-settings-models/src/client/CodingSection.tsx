/** Global coding preferences; Session model choices remain independent. */
import { useEffect, useState } from 'react'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CodingSection.module.css'
import modelCss from './ModelsSection.module.css'

/** Model route saved for one worker role. */
export interface CodingRoute { provider: string; model: string; maxTokens?: number; reasoningEffort?: string }
/** Global forms consumed by the Coding page. */
export interface CodingValues {
  defaults: CodingRoute
  team: { coding: {
    requireTaskBrief: boolean
    defaultWorkerProfile: string
    workerProfiles: Record<string, CodingRoute>
    decisions?: {
      enabled: boolean
      model: string
      timeoutMs: number
      minConfidence: number
      autoSelectSkills?: boolean
      autoRouteWorkers?: boolean
      inspectFiles?: boolean
    }
  } }
  skills: { skills: { enabled: boolean } }
  memory: { memory: { enabled: boolean; maxBytes: number } }
  parallel: { maxParallelToolCalls: number }
}
/** Copy keys owned by the Coding page. */
export const codingEn = {
  title: 'Coding', intro: 'Use small models for routine work and scoped workers for larger tasks. These settings apply across workspaces.',
  defaultModel: 'Default model', defaultHint: 'Used for new chats. Changing a model inside a chat affects that chat only.',
  workers: 'Worker models', workerHint: 'The supervisor selects a profile for each assignment. Reader is the default for delegated lookups.',
  decisions: 'Decision advisor', decisionEnabled: 'Use a decision model for ambiguous choices', decisionModel: 'Decision model ID',
  decisionHint: 'Uses the OpenRouter Decisions API for short choices and optional session images. Routine edits skip it. Advice does not replace tests or supervisor judgment.',
  autoSelectSkills: 'Use Jev when local skill rules do not match', autoRouteWorkers: 'Choose worker models automatically when no profile is specified',
  inspectFiles: 'Allow bounded assessment of explicitly selected workspace files',
  reader: 'Read and inspect', implementer: 'Implement', reviewer: 'Review', planner: 'Plan',
  brief: 'Require scoped assignments and supervisor approval', briefHint: 'Workers need a ready task with inputs, scope, acceptance checks, verification, and stop conditions.',
  skills: 'Load relevant skills automatically', skillsHint: 'Use local rules and a bounded instruction budget. Exact edits do not need a design workflow.',
  memory: 'Load general and workspace memory', memoryHint: 'Restore the current working brief after compaction. Keep each workspace separate.',
  parallel: 'Parallel tool calls per agent', parallelHint: 'Independent safe calls can run together. Dependent work remains ordered.',
  saved: 'Saved', saving: 'Saving…', failed: 'Could not save. Retry the change.', loading: 'Loading models…', retry: 'Retry', unavailable: 'Unavailable',
  compaction: 'Long sessions', compactionHint: 'The coding profile compacts automatically and preserves the goal and remaining work in its checkpoint. Repeated unchanged failures are suppressed within a turn.',
}
/** Injected settings streams and mutations. */
export interface CodingInjected {
  hooks: { [K in keyof CodingValues]: HostObservable<ConfigFormSnapshot<CodingValues[K]>> } & {
    catalog: HostObservable<{ groups: readonly ModelProviderGroup[]; status: 'idle' | 'loading' | 'ready' | 'error' }>
  }
  loadCatalog: () => void
  save: (namespace: keyof CodingValues, path: readonly string[], value: string | number | boolean) => Promise<boolean>
  selectModel: (profile: string | undefined, value: string) => Promise<boolean>
  t: (key: keyof typeof codingEn) => string
}

/**
 * Render global coding controls with native labels and serialized, fenced saves.
 * @param props - framework-bound form snapshots and registration-owned actions.
 * @returns coding settings independent of a conversation or workspace.
 */
export function CodingSection(props: InjectFace<CodingInjected>) {
  const defaults = props.useDefaults(value => value)
  const team = props.useTeam(value => value)
  const skills = props.useSkills(value => value)
  const memory = props.useMemory(value => value)
  const parallel = props.useParallel(value => value)
  const catalog = props.useCatalog(value => value)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const { t } = props
  useEffect(props.loadCatalog, [props.loadCatalog])
  const save = async (action: () => Promise<boolean>): Promise<void> => {
    setStatus('saving')
    try { setStatus(await action() ? 'saved' : 'error') } catch { setStatus('error') }
  }
  const routeKey = (route: CodingRoute | undefined) => route === undefined ? '' : JSON.stringify([route.provider, route.model])
  const picker = (id: string, label: string, route: CodingRoute | undefined, writable: boolean, profile?: string) => {
    const selected = routeKey(route)
    const listed = catalog.groups.some(group => group.models.some(model => selected === JSON.stringify([group.id, model.id])))
    return <label className={css.field} htmlFor={id}>
      <span>{label}</span>
      <select className={modelCss.selectInput} id={id} aria-label={label} value={selected} disabled={!writable || status === 'saving'} onChange={(event) => { void save(() => props.selectModel(profile, event.target.value)) }}>
        {!listed && <option value={selected}>{route?.model ?? t('unavailable')}</option>}
        {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
          {group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>)}
        </optgroup>)}
      </select>
    </label>
  }
  return <div className={css.section}>
    <h2>{t('title')}</h2><p className={css.hint}>{t('intro')}</p>
    {catalog.status === 'loading' && <p role="status">{t('loading')}</p>}
    {catalog.status === 'error' && <button type="button" onClick={props.loadCatalog}>{t('retry')}</button>}
    <section className={css.card}>
      {picker('coding-default', t('defaultModel'), defaults.value, defaults.writable)}
      <p className={css.hint}>{t('defaultHint')}</p>
    </section>
    <section className={css.card}>
      <h3>{t('workers')}</h3><p className={css.hint}>{t('workerHint')}</p>
      {Object.entries(team.value?.coding.workerProfiles ?? {}).map(([profile, route]) => picker(`coding-worker-${profile}`, profile in codingEn ? t(profile as keyof typeof codingEn) : profile, route, team.writable, profile))}
      <label className={css.toggle}><input type="checkbox" checked={team.value?.coding.requireTaskBrief ?? false} disabled={!team.writable || status === 'saving'} onChange={(event) => { void save(() => props.save('team', ['coding', 'requireTaskBrief'], event.target.checked)) }} /><span>{t('brief')}</span></label>
      <p className={css.hint}>{t('briefHint')}</p>
    </section>
    <section className={css.card}>
      <h3>{t('decisions')}</h3>
      <label className={css.toggle}>
        <input type="checkbox" checked={team.value?.coding.decisions?.enabled ?? false}
          disabled={!team.writable || status === 'saving'}
          onChange={(event) => { void save(() => props.save('team', ['coding', 'decisions', 'enabled'], event.target.checked)) }} />
        <span>{t('decisionEnabled')}</span>
      </label>
      <label className={css.field} htmlFor="coding-decision-model">
        <span>{t('decisionModel')}</span>
        <input id="coding-decision-model" type="text" key={team.value?.coding.decisions?.model}
          defaultValue={team.value?.coding.decisions?.model ?? ''} disabled={!team.writable || status === 'saving'}
          onBlur={(event) => {
            const model = event.target.value.trim()
            if (!model) {
              event.target.value = team.value?.coding.decisions?.model ?? ''
              setStatus('error')
              return
            }
            if (model !== team.value?.coding.decisions?.model) {
              void save(() => props.save('team', ['coding', 'decisions', 'model'], model))
            }
          }} />
      </label>
      {(['autoSelectSkills', 'autoRouteWorkers', 'inspectFiles'] as const).map(key => (
        <label className={css.toggle} key={key}>
          <input type="checkbox" checked={team.value?.coding.decisions?.[key] ?? false}
            disabled={!team.writable || status === 'saving' || !team.value?.coding.decisions?.enabled}
            onChange={(event) => { void save(() => props.save('team', ['coding', 'decisions', key], event.target.checked)) }} />
          <span>{t(key)}</span>
        </label>
      ))}
      <p className={css.hint}>{t('decisionHint')}</p>
    </section>
    <section className={css.card}>
      <label className={css.toggle}><input type="checkbox" checked={skills.value?.skills.enabled ?? false} disabled={skills.status !== 'ready' || !skills.writable || status === 'saving'} onChange={(event) => { void save(() => props.save('skills', ['skills', 'enabled'], event.target.checked)) }} /><span>{t('skills')}</span></label>
      <p className={css.hint}>{t('skillsHint')}</p>
      <label className={css.toggle}><input type="checkbox" checked={memory.value?.memory.enabled ?? false} disabled={memory.status !== 'ready' || !memory.writable || status === 'saving'} onChange={(event) => { void save(() => props.save('memory', ['memory', 'enabled'], event.target.checked)) }} /><span>{t('memory')}</span></label>
      <p className={css.hint}>{t('memoryHint')}</p>
      <label className={css.field} htmlFor="coding-parallel"><span>{t('parallel')}</span><input id="coding-parallel" type="number" min={1} max={16} value={parallel.value?.maxParallelToolCalls ?? 1} disabled={!parallel.writable || status === 'saving'} onChange={(event) => {
        const count = Number(event.target.value)
        if (Number.isInteger(count) && count >= 1 && count <= 16) void save(() => props.save('parallel', ['maxParallelToolCalls'], count))
      }} /></label>
      <p className={css.hint}>{t('parallelHint')}</p>
    </section>
    <section className={css.card}><h3>{t('compaction')}</h3><p className={css.hint}>{t('compactionHint')}</p></section>
    {status !== 'idle' && <p role={status === 'error' ? 'alert' : 'status'}>{t(status === 'error' ? 'failed' : status)}</p>}
  </div>
}
