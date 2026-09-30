import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { DatasetPage, DatasetRecord } from '@valley/plugin-sdk/datasets'
import { digest } from './backend/identity'
import { classificationConfiguration, groupingSettings } from './grouping'

export interface ClassificationProgress { pending: number; completed: number; failed: number; paused?: 'unavailable' | 'rate-limited'; error?: string }
const configurationKey = '_configuration'

export function createClassificationQueue(api: ValleyPluginApi, publish: (state: ClassificationProgress) => void, refresh: () => Promise<void>) {
  const jobs = api.data.dataset('classification_jobs'), assignments = api.data.dataset('assignments'), messages = api.data.dataset('messages')
  const active = new Map<string, Promise<void>>()
  const requests = new Map<string, string>()
  let disposed = false, pumping = false, stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let paused: ClassificationProgress['paused'], error: string | undefined
  let mutation = Promise.resolve()
  const serialize = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = mutation.then(work)
    mutation = result.then(() => {}, () => {})
    return result
  }
  const configuration = async () => {
    const config = await classificationConfiguration(api)
    const current = await assignments.read({ id: configurationKey })
    if (current.value?.configurationRevision !== config.revision) {
      try { await assignments.upsert({ id: configurationKey, categoryId: null, manual: false, contentRevision: null, configurationRevision: config.revision, revision: Number(current.value?.revision ?? 0) + 1 }, { expected: [{ dataset: 'assignments', key: { id: configurationKey }, revision: current.revision }] }) }
      catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || (await assignments.get({ id: configurationKey }))?.configurationRevision !== config.revision) throw reason }
    }
    return { ...config, marker: await assignments.read({ id: configurationKey }) }
  }
  const report = async () => {
    if (disposed) return
    const rows = await jobs.aggregate({ groupBy: ['status'], metrics: { count: { operation: 'count' } } })
    const count = (status: string) => Number(rows.find(row => row.status === status)?.count ?? 0)
    publish({ pending: count('queued') + count('running'), completed: count('completed'), failed: count('failed') + count('uncertain'), paused, error })
  }
  const project = async (id: string) => {
    const assignment = await assignments.get({ id })
    if (await messages.get({ id })) await messages.update({ id }, { categoryId: assignment?.categoryId ?? null })
    await refresh()
  }
  const schedule = (at: number) => {
    if (timer) clearTimeout(timer)
    if (!disposed) timer = setTimeout(() => { timer = undefined; paused = undefined; void pump() }, Math.max(1, at - Date.now()))
  }
  const run = async (job: DatasetRecord) => {
    const requestId = crypto.randomUUID(), id = String(job.id), messageId = String(job.messageId)
    let ownsJob = false
    try {
      const config = await serialize(configuration)
      const assignment = await assignments.read({ id: messageId })
      const message = await messages.get({ id: messageId })
      if (!message || assignment.value?.manual || config.revision !== job.configurationRevision || message.contentRevision !== job.contentRevision || !config.model) {
        await jobs.update({ id }, { status: 'cancelled' }); return
      }
      const claimed = await jobs.read({ id })
      if (claimed.value?.status !== 'queued') return
      await jobs.update({ id }, { status: 'running', requestId, error: null, startedAt: new Date().toISOString() }, { expected: [{ dataset: 'classification_jobs', key: { id }, revision: claimed.revision }] })
      ownsJob = true; requests.set(id, requestId)
      const body = String(message.text ?? String(message.html ?? '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
      const result = await api.ai.classify({ ...config.model, requestId, input: JSON.stringify({ sender: String(message.from).slice(0, 1024), subject: String(message.subject).slice(0, 2048), body: body.replace(/[\u0000-\u001f]/g, ' ').slice(0, 32000) }), categories: config.categories })
      if (disposed || stopped) { await jobs.update({ id }, { status: 'cancelled' }); return }
      if (result.status === 'paused') {
        paused = result.reason
        await jobs.update({ id }, { status: 'queued', requestId: null })
        schedule(result.retryAt); return
      }
      const latest = await serialize(configuration)
      if (latest.revision !== config.revision) { await jobs.update({ id }, { status: 'cancelled' }); return }
      const currentJob = await jobs.read({ id })
      const currentMessage = await messages.get({ id: messageId })
      if (currentJob.value?.status !== 'running' || currentJob.value.requestId !== requestId || currentMessage?.contentRevision !== job.contentRevision) return
      await api.data.transaction([
        { operation: 'upsert', dataset: 'assignments', values: { id: messageId, categoryId: result.categoryId === 'uncategorized' ? null : result.categoryId, manual: false, contentRevision: job.contentRevision, configurationRevision: config.revision, revision: Number(assignment.value?.revision ?? 0) + 1 } },
        { operation: 'update', dataset: 'classification_jobs', key: { id }, values: { status: 'completed', requestId: null } }
      ], { expected: [{ dataset: 'classification_jobs', key: { id }, revision: currentJob.revision }, { dataset: 'assignments', key: { id: messageId }, revision: assignment.revision }, { dataset: 'assignments', key: { id: configurationKey }, revision: config.marker.revision }] })
      await project(messageId)
    } catch (reason) {
      const conflict = (reason as { code?: string }).code === 'conflict'
      error = conflict ? undefined : reason instanceof Error ? reason.message : String(reason)
      if (ownsJob) await jobs.update({ id }, { status: conflict ? 'cancelled' : 'failed', error: error ?? null, requestId: null }).catch(() => {})
    } finally { requests.delete(id) }
  }
  async function pump(): Promise<void> {
    if (pumping || disposed || stopped || paused) return
    pumping = true
    try {
      const page = await jobs.query({ where: { status: 'queued' }, orderBy: [{ field: 'createdAt', direction: 'asc' }], limit: 3 })
      for (const job of page.rows) {
        if (active.size >= 3 || active.has(String(job.id))) continue
        const task = run(job).finally(() => { active.delete(String(job.id)); void report(); if (!disposed && !paused && !stopped) void pump() })
        active.set(String(job.id), task)
      }
    } catch (reason) { error = String(reason) }
    finally { pumping = false; await report() }
  }
  const enqueue = (ids: string[], automatic = false): Promise<void> => serialize(async () => {
    if (disposed) return
    const settings = groupingSettings(api)
    if (automatic && !settings.automatic) return
    const config = await configuration()
    if (!config.model || config.categories.length < 2) return
    const since = new Date(Date.now() - 86400000).toISOString()
    const selected = [...new Set(ids)].slice(0, 2000)
    for (let offset = 0; offset < selected.length; offset += 100) {
      const page = await messages.query({ where: { id: { in: selected.slice(offset, offset + 100) }, complete: true, ...(automatic ? { isSpam: false, exists: { dataset: 'folder_messages', on: { id: 'messageId', accountId: 'accountId' }, where: { unread: true, folder: 'INBOX', spam: false } } } : {}) }, select: ['id', 'accountId', 'contentRevision'], limit: 100 })
      const manual = await assignments.query({ where: { id: { in: page.rows.map(row => String(row.id)) }, manual: true }, select: ['id'], limit: 100 })
      const candidates: DatasetRecord[] = []
      for (const message of page.rows) {
        const messageId = String(message.id)
        if (!message.contentRevision || !messageId.startsWith('v1:') || manual.rows.some(row => row.id === messageId)) continue
        const id = await digest(JSON.stringify([messageId, message.contentRevision, config.revision]))
        candidates.push({ id, messageId, accountId: message.accountId, contentRevision: message.contentRevision, configurationRevision: config.revision, status: 'queued', automatic, createdAt: new Date().toISOString(), startedAt: null, requestId: null, error: null })
      }
      if (!candidates.length) continue
      for (let attempt = 0; attempt < 8; attempt++) {
        const snapshot = await api.data.snapshot([
          { operation: 'query', dataset: 'classification_jobs', query: { where: { id: { in: candidates.map(row => String(row.id)) } }, select: ['id'], limit: 100 } },
          { operation: 'aggregate', dataset: 'classification_jobs', request: { where: { automatic: true, createdAt: { gte: since }, accountId: { in: [...new Set(candidates.map(row => String(row.accountId)))] } }, groupBy: ['accountId'], metrics: { count: { operation: 'count' } } } }
        ])
        const existing = snapshot.values[0] as DatasetPage, counts = snapshot.values[1] as DatasetRecord[]
        const remaining = new Map(counts.map(row => [String(row.accountId), settings.dailyLimit - Number(row.count)]))
        const inserts = candidates.filter(row => {
          if (existing.rows.some(value => value.id === row.id)) return false
          if (!automatic) return true
          const account = String(row.accountId), available = remaining.get(account) ?? settings.dailyLimit
          if (available <= 0) return false
          remaining.set(account, available - 1); return true
        })
        if (!inserts.length) break
        try { await jobs.insert(inserts, { expected: [{ dataset: 'classification_jobs', revision: existing.revision }] }); break }
        catch (reason) { if ((reason as { code?: string }).code !== 'conflict' || attempt === 7) throw reason }
      }
    }
    stopped = false; void pump()
  })
  const assign = (id: string, categoryId: string | null, manual = true) => serialize(async () => {
    const current = await assignments.read({ id })
    const message = await messages.get({ id })
    await assignments.upsert({ id, categoryId, manual, contentRevision: message?.contentRevision ?? null, configurationRevision: null, revision: Number(current.value?.revision ?? 0) + 1 })
    await project(id)
  })
  const recover = async () => {
    for (;;) {
      const page = await jobs.query({ where: { status: 'running', or: [{ startedAt: { isNull: true } }, { startedAt: { lt: new Date(Date.now() - 900000).toISOString() } }] }, limit: 100 })
      if (!page.rows.length) break
      await jobs.updateMany(page.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'uncertain', error: 'Interrupted request: review before retrying', requestId: null } })))
    }
    const next = await jobs.query({ where: { status: 'running' }, orderBy: [{ field: 'startedAt', direction: 'asc' }], limit: 1 })
    if (!disposed && next.rows.length) recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void recover().catch(reason => { error = String(reason); void report() }) }, Math.max(1000, Date.parse(String(next.rows[0].startedAt)) + 900001 - Date.now()))
    await pump()
  }
  const startup = recover().catch(reason => { error = String(reason); void report() })
  return {
    enqueue, assign,
    reset: async (id: string) => { await assign(id, null, false); const stale = await jobs.query({ where: { messageId: id, status: { notIn: ['running', 'queued'] } }, limit: 1000 }); if (stale.rows.length) await jobs.updateMany(stale.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'queued', error: null } }))); await enqueue([id]); void pump() },
    retry: () => { paused = undefined; error = undefined; stopped = false; if (timer) clearTimeout(timer); void pump() },
    cancel: async () => {
      stopped = true; if (timer) clearTimeout(timer)
      const pending = await jobs.query({ where: { status: 'running' }, limit: 100 })
      if (pending.rows.length) await jobs.updateMany(pending.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'cancelled' } })))
      await Promise.allSettled(pending.rows.flatMap(row => typeof row.requestId === 'string' ? [api.ai.cancel(row.requestId)] : []))
      for (;;) { const page = await jobs.query({ where: { status: 'queued' }, limit: 500 }); if (!page.rows.length) break; await jobs.updateMany(page.rows.map(row => ({ key: { id: String(row.id) }, values: { status: 'cancelled' } }))) }
      await report()
    },
    dispose: async () => { disposed = true; if (recoveryTimer) clearTimeout(recoveryTimer); if (timer) clearTimeout(timer); await startup; await Promise.allSettled([...requests.values()].map(requestId => api.ai.cancel(requestId))); await Promise.allSettled([...active.values(), mutation]) }
  }
}
