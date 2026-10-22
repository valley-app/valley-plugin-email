import type { ValleyPluginApi } from '@valley/plugin-sdk'

export function vipAddresses(api: ValleyPluginApi): Set<string> {
  const raw = api.settings.get().vipAddresses
  return new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()) : [])
}
