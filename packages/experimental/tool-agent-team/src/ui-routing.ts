/** Approved Lead model routing after deterministic automatic UI skill selection. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tool-skill'
import type { CodingTeamSettings } from './index.ts'

/**
 * Select the configured UI route for substantial UI work, without an extra classifier call.
 * @param agent - exact Lead or worker owning the scoped tools.
 * @param settings - live approved role routes.
 * @returns the scoped event disposer.
 */
export function installUiRouting(agent: Agent, settings: () => CodingTeamSettings): () => void {
  let active = true
  const stop = agent.ctx.on('skills/automatic-selected', async (input) => {
    if (input.agent !== agent
      || !input.names.some(name => name === 'design-distinctive-frontends' || name === 'impeccable')) return
    const teams = agent.ctx.get('agentTeams')
    if (teams === undefined) throw new Error('UI routing requires Agent Teams')
    if (teams.membership(agent).role !== 'lead') return
    const policy = settings()
    const name = policy.uiProfile ?? ''
    if (!name) return
    const route = policy.workerProfiles[name]
    if (route === undefined) throw new Error(`Unknown UI model profile: ${name}`)
    const current = agent.model.current()
    if (current?.provider === route.provider && current.model === route.model && current.reasoningEffort === route.reasoningEffort) return
    const selection = { provider: route.provider, model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } }
    const llm = agent.ctx.get('llm')
    if (llm === undefined) throw new Error('UI routing requires the LLM service')
    await llm.resolveCallConfig(selection)
    input.signal.throwIfAborted()
    if (active) agent.model.select(selection)
  })
  return () => { active = false; stop() }
}
