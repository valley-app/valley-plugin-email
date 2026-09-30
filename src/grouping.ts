import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { AiModelRef } from '@valley/plugin-sdk/ai'
import { digest } from './backend/identity'

export interface GroupingSettings {
  automatic: boolean
  dailyLimit: number
  categories: Record<string, string>
}

export function groupingSettings(api: ValleyPluginApi): GroupingSettings {
  const raw = api.settings.get().grouping as Partial<GroupingSettings> | undefined
  return { automatic: raw?.automatic === true, dailyLimit: Math.max(0, Math.min(10000, Math.floor(Number(raw?.dailyLimit ?? 100) || 0))),
    categories: Object.fromEntries(Object.entries(raw?.categories ?? {}).filter(([id, description]) => id !== 'uncategorized' && typeof description === 'string').slice(0, 254)) }
}

export function vipAddresses(api: ValleyPluginApi): Set<string> {
  const raw = api.settings.get().vipAddresses
  return new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()) : [])
}

export async function classificationConfiguration(api: ValleyPluginApi): Promise<{ model?: AiModelRef; categories: { id: string; description: string }[]; revision: string }> {
  const model = (await api.ai.defaults()).classification
  const settings = groupingSettings(api)
  const categories = api.getState().groups.filter(group => Object.hasOwn(settings.categories, group.id))
    .map(group => ({ id: group.id, description: `${group.name}: ${settings.categories[group.id]}` }))
  categories.push({ id: 'uncategorized', description: 'None of the other categories fits this message.' })
  return { model, categories, revision: await digest(JSON.stringify([model ?? null, categories])) }
}
