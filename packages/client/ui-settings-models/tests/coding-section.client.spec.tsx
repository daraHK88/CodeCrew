// @vitest-environment jsdom
/** Global supervisor selection stays separate from the default chat and worker routes. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CodingSection, codingEn } from '../src/client/CodingSection.tsx'
import type { CodingValues } from '../src/client/CodingSection.tsx'

afterEach(cleanup)

function form<T>(value: T, writable = true) {
  return bindSnapshotSelector(createSnapshotStore<ConfigFormSnapshot<T>>({
    status: 'ready', value, base: value, user: {}, revision: 1, writable,
  }))
}

function mount(writable = true, accepted = true) {
  const save = vi.fn().mockResolvedValue(accepted)
  render(<CodingSection
    useDefaults={form<CodingValues['defaults']>({ provider: 'mock', model: 'cheap' })}
    useTeam={form<CodingValues['team']>({ coding: { supervisorProfile: 'planner', requireTaskBrief: true,
      defaultWorkerProfile: 'reader', workerProfiles: {
        reader: { provider: 'mock', model: 'cheap' }, planner: { provider: 'mock', model: 'capable' },
      },
    } }, writable)}
    useSkills={form<CodingValues['skills']>({ skills: { enabled: true } })}
    useMemory={form<CodingValues['memory']>({ memory: { enabled: true, maxBytes: 6000 } })}
    useParallel={form<CodingValues['parallel']>({ maxParallelToolCalls: 4 })}
    useCatalog={bindSnapshotSelector(createSnapshotStore({ groups: [], status: 'ready' as const }))}
    loadCatalog={() => undefined} save={save} selectModel={async () => true} t={key => codingEn[key]}
  />)
  return save
}

it('saves the supervisor role without changing chat or worker models and supports retaining the chat model', async () => {
  const save = mount()
  const select = screen.getByLabelText<HTMLSelectElement>(codingEn.supervisor)
  expect(select.value).toBe('planner')
  fireEvent.change(select, { target: { value: 'reader' } })
  await waitFor(() => { expect(screen.getByText(codingEn.saved)).toBeTruthy() })
  expect(save).toHaveBeenCalledExactlyOnceWith('team', ['coding', 'supervisorProfile'], 'reader')
  fireEvent.change(select, { target: { value: '' } })
  await waitFor(() => { expect(save).toHaveBeenCalledTimes(2) })
  expect(save).toHaveBeenLastCalledWith('team', ['coding', 'supervisorProfile'], '')
})

it('disables supervisor changes when settings are read-only', () => {
  mount(false)
  expect((screen.getByLabelText<HTMLSelectElement>(codingEn.supervisor)).disabled).toBe(true)
})

it('reports rejected supervisor saves', async () => {
  mount(true, false)
  fireEvent.change(screen.getByLabelText<HTMLSelectElement>(codingEn.supervisor), { target: { value: '' } })
  await waitFor(() => { expect(screen.getByText(codingEn.failed)).toBeTruthy() })
})

it('saves the UI role independently of the supervisor and chat model', async () => {
  const save = mount()
  fireEvent.change(screen.getByLabelText(codingEn.uiProfile), { target: { value: 'planner' } })
  await waitFor(() => { expect(save).toHaveBeenCalledExactlyOnceWith('team', ['coding', 'uiProfile'], 'planner') })
})

it('saves a local decision endpoint independently of worker and chat models', async () => {
  const save = mount()
  fireEvent.blur(screen.getByLabelText(codingEn.localEndpoint), { target: { value: 'http://127.0.0.1:1234/v1/systemone' } })
  await waitFor(() => { expect(save).toHaveBeenCalledWith('team', ['coding', 'decisions', 'localEndpoint'], 'http://127.0.0.1:1234/v1/systemone') })
})

it('can enable saved role reuse while the decision advisor is disabled', async () => {
  const save = mount()
  fireEvent.click(screen.getByLabelText(codingEn.reuseWorkerProfiles))
  await waitFor(() => { expect(save).toHaveBeenCalledWith('team', ['coding', 'decisions', 'reuseWorkerProfiles'], true) })
})
