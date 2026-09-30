import { CONTACTS_DIRECTORY_V1, CONTACTS_DIRECTORY_REVISION_V1, type ContactDirectoryEntry, type ValleyPluginApi } from '@valley/plugin-sdk'
import { parseEmailAddresses } from './backend/query'
import { vipAddresses } from './grouping'

export function createEmailProjections(api: ValleyPluginApi, changed: () => Promise<void>) {
  let active = true, full = false, running: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Set<string>()
  const rebuild = async () => {
    while (active && (full || pending.size)) {
      const all = full; full = false
      const ids = [...pending]; pending.clear()
      let cursor: string | undefined, offset = 0
      do {
        const selected = all ? undefined : ids.slice(offset, offset += 100)
        if (!all && !selected?.length) break
        const page = await api.data.dataset('messages').query({ select: ['id', 'from', 'isVip', 'hasContact', 'categoryId'], where: selected ? { id: { in: selected } } : undefined, limit: 100, cursor: all ? cursor : undefined })
        const provider = api.interop.services.providers(CONTACTS_DIRECTORY_V1)[0]
        const senders = new Map(page.rows.map(row => [String(row.id), parseEmailAddresses(String(row.from)).map(address => address.address.toLowerCase())]))
        const addresses = [...new Set([...senders.values()].flat())]
        const matches = new Map<string, ContactDirectoryEntry[]>()
        if (provider) for (let start = 0; start < addresses.length; start += 200) {
          const result = await provider.invoke('resolveEmails', [addresses.slice(start, start + 200)])
          if (result.ok) for (const entry of result.value as { address: string; contacts: ContactDirectoryEntry[] }[]) matches.set(entry.address.toLowerCase(), entry.contacts)
        }
        if (!active) return
        const vips = vipAddresses(api)
        const assignments = page.rows.length ? await api.data.dataset('assignments').query({ where: { id: { in: page.rows.map(row => String(row.id)) } }, limit: 100 }) : { rows: [] }
        const updates = page.rows.flatMap(row => {
          const addresses = senders.get(String(row.id))!
          const values = { isVip: addresses.some(address => vips.has(address)), hasContact: addresses.some(address => matches.get(address)?.length === 1), categoryId: assignments.rows.find(assignment => assignment.id === row.id)?.categoryId ?? null }
          return Object.entries(values).some(([key, value]) => row[key] !== value) ? [{ key: { id: String(row.id) }, values }] : []
        })
        if (updates.length) await api.data.dataset('messages').updateMany(updates)
        cursor = page.cursor
        await new Promise(resolve => setTimeout(resolve, 0))
      } while (active && (all ? cursor : offset < ids.length))
    }
    if (active) await changed()
  }
  const schedule = (ids?: string[]) => {
    if (!active) return
    if (ids) ids.forEach(id => pending.add(id)); else full = true
    if (!running && !timer) timer = setTimeout(() => { timer = undefined; running = rebuild().catch(() => {}).finally(() => { running = undefined; if (active && (full || pending.size)) schedule([]) }) }, 50)
  }
  const offMessages = api.data.dataset('messages').subscribe(event => schedule(event.keys?.flatMap(key => typeof key.id === 'string' ? [key.id] : [])))
  const offAssignments = api.data.dataset('assignments').subscribe(event => schedule(event.keys?.flatMap(key => typeof key.id === 'string' && key.id !== '_configuration' ? [key.id] : [])))
  const offContacts = api.interop.services.subscribe(CONTACTS_DIRECTORY_V1, () => schedule())
  const offRevision = api.interop.state.subscribe(CONTACTS_DIRECTORY_REVISION_V1, () => schedule())
  let previousVip = JSON.stringify([...vipAddresses(api)].sort())
  const offSettings = api.settings.subscribe(() => { const next = JSON.stringify([...vipAddresses(api)].sort()); if (next !== previousVip) { previousVip = next; schedule() } })
  schedule()
  return { refresh: () => schedule(), dispose: async () => { active = false; if (timer) clearTimeout(timer); offMessages(); offAssignments(); offContacts(); offRevision(); offSettings(); await running } }
}
