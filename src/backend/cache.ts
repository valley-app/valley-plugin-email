import { t } from './localization'
import type { PluginDataApi } from '@valley/plugin-sdk'
import type { CachedMessage, EmailAccount } from '../mailTypes'
import type { DatasetPage, DatasetRecord, DatasetRequest, DatasetTransactionOperation, DatasetWhere } from '@valley/plugin-sdk/datasets'
import { identifyMessage } from './identity'

export interface EmailStoreContext {
  data: PluginDataApi
  datasets: { messages: string; mailboxes: string; folderMessages: string; recipients: string }
}

export function emailStoreContext(data: PluginDataApi): EmailStoreContext {
  return { data, datasets: { messages: 'messages', mailboxes: 'mailboxes', folderMessages: 'folder_messages', recipients: 'recipients' } }
}

export async function datasetRequest<T>(scope: EmailStoreContext, request: DatasetRequest): Promise<T> {
  if (request.operation === 'transaction') return await scope.data.transaction(request.operations) as T
  if (request.operation === 'query') return await scope.data.dataset(request.dataset).query(request.query) as T
  if (request.operation === 'get') return await scope.data.dataset(request.dataset).get(request.key) as T
  throw new Error(t('email.backend.operation'))
}

export async function queryAll(scope: EmailStoreContext, dataset: string, where?: DatasetWhere, select?: string[]): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = []
  let cursor: string | undefined
  do {
    const page = await datasetRequest<DatasetPage>(scope, {
      operation: 'query', dataset, query: { where, select, limit: 1000, cursor }
    })
    rows.push(...page.rows)
    cursor = page.cursor
  } while (cursor)
  return rows
}

function flagProjection(flags: readonly string[]) {
  return { unread: !flags.includes('\\Seen'), flagged: flags.includes('\\Flagged') }
}

const projecting = new WeakMap<PluginDataApi, Map<string, Promise<void>>>()

export async function ensureMembershipFlags(scope: EmailStoreContext, accountId: string): Promise<void> {
  let pending = projecting.get(scope.data)
  if (!pending) { pending = new Map(); projecting.set(scope.data, pending) }
  const existing = pending.get(accountId)
  if (existing) return existing
  const missing = (column: 'unread' | 'flagged') => scope.data.dataset(scope.datasets.folderMessages).query({
    where: { accountId, or: [{ [column]: { isNull: true } }, { projectionVersion: 0 }] },
    select: ['accountId', 'folder', 'uid', 'flags'], limit: 1000
  })
  const rebuild = async () => {
    let conflicts = 0
    while (true) {
      let page = await missing('unread')
      if (!page.rows.length) page = await missing('flagged')
      if (!page.rows.length) return
      const mailboxes = await queryAll(scope, scope.datasets.mailboxes, { accountId }, ['path', 'specialUse'])
      try {
        await scope.data.transaction(page.rows.map(row => ({
          operation: 'update', dataset: scope.datasets.folderMessages,
          key: { accountId, folder: String(row.folder), uid: Number(row.uid) },
          values: { ...flagProjection(Array.isArray(row.flags) ? row.flags.filter((flag): flag is string => typeof flag === 'string') : []), ...folderProjection(String(row.folder), mailboxes.find(mailbox => mailbox.path === row.folder)?.specialUse as string | undefined, Array.isArray(row.flags) ? row.flags as string[] : []) }
        })), { expected: [{ dataset: scope.datasets.folderMessages, revision: page.revision }] })
        conflicts = 0
      } catch (error) {
        if (!error || (error as { code?: string }).code !== 'conflict' || ++conflicts >= 3) throw error
      }
    }
  }
  const task = rebuild().finally(() => { if (pending.get(accountId) === task) pending.delete(accountId) })
  pending.set(accountId, task)
  return task
}

function messageRow(accountId: string, message: CachedMessage): DatasetRecord {
  return {
    id: message.logicalId!, accountId, messageId: message.messageId,
    contentRevision: message.contentRevision ?? null, complete: message.complete === true, originalDate: message.originalDate === undefined ? message.date || null : message.originalDate,
    sortDate: message.date || '', projectionVersion: 1,
    from: message.from, replyTo: message.replyTo ?? null, to: message.to, cc: message.cc ?? null,
    subject: message.subject, date: message.date || '1970-01-01T00:00:00.000Z', snippet: message.snippet,
    text: message.text ?? null, html: message.html ?? null, hasAttachments: message.hasAttachments
  }
}

function folderOperations(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  previous: CachedMessage[],
  messages: CachedMessage[]
): DatasetTransactionOperation[] {
  const before = new Map(previous.map((message) => [message.uid, message]))
  const after = new Map(messages.map((message) => [message.uid, message]))
  const existingMessages = new Map(previous.map((message) => [message.logicalId, message]))
  return [
    ...[...before.keys()].filter((uid) => !after.has(uid)).map((uid) => ({ dataset: scope.datasets.folderMessages, operation: 'delete' as const, key: { accountId, folder, uid } })),
    ...[...new Map(messages.map((message) => [message.logicalId, message])).values()].flatMap((message) => {
      const existing = existingMessages.get(message.logicalId)
      if (existing === message) return []
      const values = messageRow(accountId, message)
      if (existing && JSON.stringify(messageRow(accountId, existing)) === JSON.stringify(values)) return []
      const id = message.logicalId!
      const recipients = [
        ...message.to.split(',').map((address) => address.trim()).filter(Boolean).map((address, position) => ({ dataset: scope.datasets.recipients, operation: 'upsert' as const, values: { messageId: id, kind: 'to', position, address } })),
        ...(message.cc ?? '').split(',').map((address) => address.trim()).filter(Boolean).map((address, position) => ({ dataset: scope.datasets.recipients, operation: 'upsert' as const, values: { messageId: id, kind: 'cc', position, address } }))
      ]
      return [
        { dataset: scope.datasets.messages, operation: 'upsert' as const, values },
        ...recipients
      ]
    }),
    ...[...after.values()].filter((message) => {
      const existing = before.get(message.uid)
      return !existing || existing.logicalId !== message.logicalId || JSON.stringify(existing.flags) !== JSON.stringify(message.flags)
    }).map((message) => ({ dataset: scope.datasets.folderMessages, operation: 'upsert' as const, values: { accountId, folder, uid: message.uid, messageId: message.logicalId!, uidValidity: message.uidValidity ?? null, flags: message.flags, ...flagProjection(message.flags), ...folderProjection(folder, undefined, message.flags) } }))
  ]
}

async function writeOperations(scope: EmailStoreContext, operations: DatasetTransactionOperation[]): Promise<void> {
  for (let index = 0; index < operations.length; index += 1000) {
    await datasetRequest(scope, { operation: 'transaction', operations: operations.slice(index, index + 1000) })
  }
}

export async function readAccounts(scope: EmailStoreContext): Promise<EmailAccount[]> {
  const text = await scope.data.files.readText('accounts.json')
  if (text === null) return []
  const accounts: unknown = JSON.parse(text)
  if (!Array.isArray(accounts)) throw new Error(t('email.backend.accountsInvalid'))
  return accounts as EmailAccount[]
}

export async function writeAccounts(scope: EmailStoreContext, accounts: EmailAccount[]): Promise<void> {
  const current = await scope.data.files.readTextBaseline('accounts.json')
  const result = await scope.data.files.writeTextGuarded('accounts.json', JSON.stringify(accounts, null, 2), current?.baseline ?? null)
  if (!result.ok) throw new Error(t('email.backend.accountsChanged'))
}

export async function upsertAccount(scope: EmailStoreContext, account: EmailAccount): Promise<EmailAccount[]> {
  const accounts = await readAccounts(scope)
  const idx = accounts.findIndex((a) => a.id === account.id)
  if (idx >= 0) accounts[idx] = account
  else accounts.push(account)
  await writeAccounts(scope, accounts)
  return accounts
}

export async function getAccount(scope: EmailStoreContext, accountId: string): Promise<EmailAccount | null> {
  const accounts = await readAccounts(scope)
  return accounts.find((a) => a.id === accountId) ?? null
}

export async function removeAccountFiles(scope: EmailStoreContext, accountId: string): Promise<EmailAccount[]> {
  const accounts = (await readAccounts(scope)).filter((a) => a.id !== accountId)
  await writeAccounts(scope, accounts)
  const [memberships, messages] = await Promise.all([
    queryAll(scope, scope.datasets.folderMessages, { accountId }, ['folder', 'uid']),
    queryAll(scope, scope.datasets.messages, { accountId }, ['id'])
  ])
  const operations = [
    ...memberships.map((entry) => ({ dataset: scope.datasets.folderMessages, operation: 'delete' as const, key: { accountId, folder: String(entry.folder), uid: Number(entry.uid) } })),
    ...messages.map((entry) => ({ dataset: scope.datasets.messages, operation: 'delete' as const, key: { id: String(entry.id) } }))
  ]
  await writeOperations(scope, operations)
  return accounts
}

/** Read every cached message for one folder. */
export async function readFolder(scope: EmailStoreContext, accountId: string, folder: string): Promise<CachedMessage[]> {
  try {
    const memberships = await queryAll(scope, scope.datasets.folderMessages, { accountId, folder })
    const ids = [...new Set(memberships.map((membership) => String(membership.messageId)))]
    const messages: DatasetRecord[] = []
    for (let index = 0; index < ids.length; index += 100) {
      messages.push(...await queryAll(scope, scope.datasets.messages, { accountId, id: { in: ids.slice(index, index + 100) } }))
    }
    const byId = new Map(messages.map((message) => [String(message.id), message]))
    return memberships.flatMap((membership): CachedMessage[] => {
      const message = byId.get(String(membership.messageId))
      if (!message) return []
      return [{
        complete: message.complete === true, logicalId: String(message.id), contentRevision: typeof message.contentRevision === 'string' ? message.contentRevision : undefined,
        uidValidity: typeof membership.uidValidity === 'number' ? membership.uidValidity : undefined,
        originalDate: typeof message.originalDate === 'string' ? message.originalDate : null,
        uid: Number(membership.uid), messageId: String(message.messageId), from: String(message.from),
        replyTo: typeof message.replyTo === 'string' ? message.replyTo : undefined,
        to: String(message.to), cc: typeof message.cc === 'string' ? message.cc : undefined,
        subject: String(message.subject), date: typeof message.sortDate === 'string' ? message.sortDate : String(message.date), snippet: String(message.snippet),
        text: typeof message.text === 'string' ? message.text : undefined,
        html: typeof message.html === 'string' ? message.html : undefined,
        flags: Array.isArray(membership.flags) ? membership.flags.filter((flag): flag is string => typeof flag === 'string') : [],
        hasAttachments: message.hasAttachments === true
      }]
    }).sort((a, b) => (a.date < b.date ? 1 : -1))
  } catch {
    return []
  }
}

/** Merge fetched messages into a folder's cache, de-duped by uid, newest first. */
export async function mergeFolder(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  messages: CachedMessage[]
): Promise<number> {
  const identified: CachedMessage[] = []
  for (const message of messages) identified.push(await identifyMessage(accountId, folder, message))
  const mailbox = await scope.data.dataset(scope.datasets.mailboxes).get({ accountId, path: folder })
  const operations = folderOperations(scope, accountId, folder, [], identified)
  for (const operation of operations) if (operation.dataset === scope.datasets.folderMessages && operation.values && !Array.isArray(operation.values)) Object.assign(operation.values, folderProjection(folder, typeof mailbox?.specialUse === 'string' ? mailbox.specialUse : undefined, operation.values.flags as string[]))
  await writeOperations(scope, operations)
  await projectAssignments(scope, identified.map(message => message.logicalId!))
  return scope.data.dataset(scope.datasets.folderMessages).count({ accountId, folder })
}

export async function folderCacheStats(
  scope: EmailStoreContext,
  accountId: string
): Promise<Map<string, { total: number; unread: number }>> {
  await ensureMembershipFlags(scope, accountId)
  const live = { accountId, exists: { dataset: scope.datasets.messages, on: { messageId: 'id', accountId: 'accountId' } } }
  const rows = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: live, groupBy: ['folder'], metrics: { total: { operation: 'count' } } })
  const unread = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { ...live, unread: true }, groupBy: ['folder'], metrics: { unread: { operation: 'count' } } })
  return new Map(rows.map(row => [String(row.folder), { total: Number(row.total), unread: Number(unread.find(item => item.folder === row.folder)?.unread ?? 0) }]))
}

export async function updateMessageFlags(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  uid: number,
  add: string[] = [],
  remove: string[] = []
): Promise<CachedMessage[]> {
  const membership = await scope.data.dataset(scope.datasets.folderMessages).get({ accountId, folder, uid })
  if (!membership) return []
  const flags = new Set(Array.isArray(membership.flags) ? membership.flags as string[] : [])
  add.forEach(flag => flags.add(flag)); remove.forEach(flag => flags.delete(flag))
  if (JSON.stringify([...flags]) !== JSON.stringify(membership.flags)) await scope.data.transaction([{ operation: 'update', dataset: scope.datasets.folderMessages, key: { accountId, folder, uid }, values: { flags: [...flags], ...flagProjection([...flags]) } }])
  const row = await scope.data.dataset(scope.datasets.messages).get({ id: String(membership.messageId) })
  if (!row) return []
  return [{ ...row, uid, logicalId: String(row.id), contentRevision: row.contentRevision, flags: [...flags], date: row.sortDate ?? row.date } as unknown as CachedMessage]

}

export async function moveCachedMessage(
  scope: EmailStoreContext,
  accountId: string,
  sourceFolder: string,
  destinationFolder: string,
  uid: number,
  destinationUid?: number
): Promise<CachedMessage[]> {
  const source = await readFolder(scope, accountId, sourceFolder)
  const message = source.find((candidate) => candidate.uid === uid)
  const remaining = source.filter((candidate) => candidate.uid !== uid)
  const operations = folderOperations(scope, accountId, sourceFolder, source, remaining)
  if (message && destinationUid !== undefined) {
    const destination = destinationFolder === sourceFolder ? remaining : await readFolder(scope, accountId, destinationFolder)
    const moved = { ...message, uid: destinationUid }
    const merged = [moved, ...destination.filter((candidate) => candidate.uid !== destinationUid)]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
    operations.push(...folderOperations(scope, accountId, destinationFolder, destination, merged))
  }
  await writeOperations(scope, operations)
  return remaining
}

/** Append a single sent message to the Sent folder cache. */
export async function appendMessage(
  scope: EmailStoreContext,
  accountId: string,
  folder: string,
  message: CachedMessage
): Promise<void> {
  await mergeFolder(scope, accountId, folder, [message])
}

export function folderProjection(folder: string, specialUse?: string, flags: readonly string[] = []): { excluded: boolean; spam: boolean; projectionVersion: number } {
  const keywords = flags.map(flag => flag.toLowerCase())
  const spam = specialUse?.toLowerCase() === '\\junk' || /(^|[/.])(junk|spam)$/i.test(folder) || (keywords.includes('$junk') || keywords.includes('junk')) && !keywords.includes('$notjunk')
  return { spam, projectionVersion: 1, excluded: spam || ['\\Trash', '\\Drafts'].includes(specialUse ?? '') || /(^|[/.])(trash|drafts|deleted items|deleted messages)$/i.test(folder) }
}

export async function projectAssignments(scope: EmailStoreContext, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 100) {
    const selected = ids.slice(index, index + 100)
    const assignments = await scope.data.dataset('assignments').query({ where: { id: { in: selected } }, limit: 100 })
    const memberships = await scope.data.dataset(scope.datasets.folderMessages).aggregate({ where: { messageId: { in: selected }, spam: true }, groupBy: ['messageId'], metrics: { count: { operation: 'count' } } })
    await scope.data.transaction(selected.map(id => ({ operation: 'update', dataset: scope.datasets.messages, key: { id }, values: {
      categoryId: assignments.rows.find(row => row.id === id)?.categoryId ?? null,
      isSpam: memberships.some(row => row.messageId === id)
    } })))
  }
}

export async function establishFolderEpoch(scope: EmailStoreContext, accountId: string, folder: string, uidValidity: number | undefined): Promise<boolean> {
  const previous = await scope.data.dataset('sync_state').get({ accountId, folder })
  const reset = previous?.uidValidity !== uidValidity
  if (reset) {
    while (true) {
      const page = await scope.data.dataset(scope.datasets.folderMessages).query({ where: { accountId, folder }, select: ['uid', 'messageId'], limit: 500 })
      if (!page.rows.length) break
      await scope.data.dataset(scope.datasets.folderMessages).deleteMany(page.rows.map(row => ({ accountId, folder, uid: Number(row.uid) })))
      await projectAssignments(scope, [...new Set(page.rows.map(row => String(row.messageId)))])
    }
  }
  return Boolean(previous?.lastSyncAt && !reset && uidValidity !== undefined)
}
