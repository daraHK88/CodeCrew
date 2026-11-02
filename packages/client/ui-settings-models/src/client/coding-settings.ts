/** Registration-owned global coding forms and model catalog. */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { CodingSection, codingEn } from './CodingSection.tsx'
import type { CodingInjected, CodingValues } from './CodingSection.tsx'

/**
 * Mount Coding only when its native Host preferences are available.
 * @param ctx - Models plugin with settings, locale, slots, and session remotes.
 */
export function registerCodingSettings(ctx: Context): void {
  const defaults = ctx.configForms.get<CodingValues['defaults']>('agent-default-model')
  const team = ctx.configForms.get<CodingValues['team']>('tool-agent-team')
  const skills = ctx.configForms.get<CodingValues['skills']>('coding-settings')
  const memory = ctx.configForms.get<CodingValues['memory']>('coding-settings')
  const parallel = ctx.configForms.get<CodingValues['parallel']>('agent-loop')
  const forms = { defaults, team, skills, memory, parallel }
  const catalog = createSnapshotStore<{ groups: readonly ModelProviderGroup[]; status: 'idle' | 'loading' | 'ready' | 'error' }>({ groups: [], status: 'idle' })
  let disposed = false
  const loadCatalog = (): void => {
    if (disposed || catalog.getSnapshot().status === 'loading') return
    catalog.set({ ...catalog.getSnapshot(), status: 'loading' })
    void ctx.remote.session.modelCatalog().then((result) => {
      if (!disposed) catalog.set(result.ok ? { groups: result.value.groups, status: 'ready' } : { ...catalog.getSnapshot(), status: 'error' })
    }).catch(() => { if (!disposed) catalog.set({ ...catalog.getSnapshot(), status: 'error' }) })
  }
  const actions: Pick<CodingInjected, 'loadCatalog' | 'save' | 'selectModel'> = {
    loadCatalog,
    save: (namespace, path, value) => forms[namespace].mutate([{ op: 'set', path: [...path], value }]),
    selectModel: async (profile, value) => {
      const selected = catalog.getSnapshot().groups.flatMap(group => group.models.map(entry => ({ provider: group.id, model: entry.id })))
        .find(route => JSON.stringify([route.provider, route.model]) === value)
      if (selected === undefined) return false
      const { provider, model } = selected
      if (profile === undefined) return defaults.mutate([{ op: 'set', path: ['provider'], value: provider }, { op: 'set', path: ['model'], value: model }, { op: 'unset', path: ['reasoningEffort'] }])
      const previous = team.getSnapshot().value?.coding.workerProfiles[profile]
      if (previous === undefined) return false
      return team.mutate([{ op: 'set', path: ['coding', 'workerProfiles', profile], value: { provider, model, ...previous.maxTokens === undefined ? {} : { maxTokens: previous.maxTokens } } }])
    },
  }
  // New keys fall back to English until reviewed translations are supplied.
  ctx.effect(() => ctx.locale.register('settings.coding', { en: codingEn, zh: codingEn }), 'coding-settings.locale')
  const t = ctx.locale.bind('settings.coding')
  ctx.effect(() => () => { disposed = true }, 'coding-settings.lifetime')
  for (const event of ['llm/adapters-updated', 'settings/document-updated'] as const) ctx.effect(() => ctx.remote.$on(event, () => { if (catalog.getSnapshot().status !== 'idle') loadCatalog() }), `coding-settings.${event}`)
  ctx.effect(() => ctx.configForms.whileServed(['coding-settings'], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'coding', order: 5, label: () => t('title'),
    inject: (): CodingInjected => ({ hooks: { ...forms, catalog }, ...actions, t }),
  }, CodingSection))), 'coding-settings.section')
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.coding': keyof typeof codingEn }
}
