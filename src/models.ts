import type { ModelEntry } from "./snapshot.ts"

export interface ModelAction {
  providerID: string
  id: string
  enabled: boolean
}

export interface ModelPlan {
  actions: ModelAction[]
  /** refs this run leaves disabled (previous minus re-enabled plus newly disabled) */
  disabledRefs: string[]
}

/**
 * Pure planner for hub model parity.
 * - disables local models missing from the hub list (never deletes)
 * - re-enables models this plugin previously disabled once the hub has them again
 * - an empty hub list disables nothing (guards against a failed hub fetch)
 */
export function planModelUpdates(
  editorModels: Array<{ providerID: string; id: string; enabled?: boolean }>,
  hubModels: ModelEntry[],
  previouslyDisabled: string[] = [],
): ModelPlan {
  const allowed = new Set(hubModels.map((m) => m.ref))
  const wasDisabled = new Set(previouslyDisabled)
  const actions: ModelAction[] = []
  const stillDisabled = new Set<string>()

  if (allowed.size === 0 && wasDisabled.size === 0) return { actions, disabledRefs: [] }

  for (const model of editorModels) {
    const ref = `${model.providerID}/${model.id}`
    if (allowed.has(ref)) {
      if (model.enabled === false && wasDisabled.has(ref)) {
        actions.push({ providerID: model.providerID, id: model.id, enabled: true })
        wasDisabled.delete(ref)
      }
    } else if (model.enabled === false) {
      // disabled by someone else or earlier and not hub-listed — leave alone
      continue
    } else {
      actions.push({ providerID: model.providerID, id: model.id, enabled: false })
      stillDisabled.add(ref)
    }
  }
  // refs disabled earlier that are not in the editor list any more stay tracked
  for (const ref of wasDisabled) if (!stillDisabled.has(ref)) stillDisabled.add(ref)
  return { actions, disabledRefs: [...stillDisabled] }
}
