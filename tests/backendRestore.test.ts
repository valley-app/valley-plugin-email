import { assertCommandOutput } from './commandContracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { register, type MailBackendApi } from '../src/backend'
import { appendMessage, emailStoreContext, mergeFolder, queryAll, upsertAccount } from '../src/backend/cache'
import * as transport from '../src/backend/transport'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'

const id = (n: number) => `pureemail-00000000-0000-4000-8000-00000000000${n}`
const account = (n: number): EmailAccount => ({ id: id(n), provider: 'pureemail', address: `user${n}@example.test`, createdAt: n,
  imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } })
const message = (uid: number, subject: string, extra: Partial<CachedMessage> = {}): CachedMessage => ({ uid, uidValidity: 7, messageId: `<${subject}@example.test>`, from: 'sender@example.test', to: 'a@example.test, b@example.test', cc: 'c@example.test', subject, date: `2031-01-0${uid % 9 + 1}T00:00:00.000Z`, snippet: subject, text: subject, flags: ['\\Seen'], hasAttachments: false, ...extra })
const CACHE = ['messages', 'mailboxes', 'folder_messages', 'recipients', 'sync_state']

async function fixture(stored: 'absent' | 'stored' = 'absent') {
  const mock = createMockValleyApi({ manifest: { id: 'email', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const scope = emailStoreContext(mock.api.data)
  for (const n of [1, 2, 3]) await upsertAccount(scope, account(n))
  const handlers = new Map<string, (payload: unknown) => Promise<unknown>>()
  const api: MailBackendApi = {
    data: mock.api.data,
    accounts: { list: vi.fn(async () => []), authorize: vi.fn() },
    credentials: { presence: vi.fn(async () => stored), state: vi.fn(async () => 'ok' as const), set: vi.fn(), delete: vi.fn(), handle: vi.fn(), write: vi.fn() },
    network: { fetch: vi.fn(), open: vi.fn(), read: vi.fn(), write: vi.fn(), startTls: vi.fn(), close: vi.fn(async () => {}) },
    rpc: { handle: (name, handler) => { handlers.set(name, handler); return () => { handlers.delete(name) } }, emit: vi.fn() }
  }
  const dispose = register(api)
  const call = async (name: string, payload: unknown) => assertCommandOutput(name, payload, await handlers.get(name)!(payload)) as { ok: boolean; data?: any; code?: string; outcome?: string }
  const snapshot = async () => ({ accounts: await mock.api.data.files.readText('accounts.json'), ...Object.fromEntries(await Promise.all(CACHE.map(async name => [name, (await queryAll(scope, name)).map(row => JSON.stringify(row)).sort()]))) })
  return { mock, scope, api, call, dispose, snapshot }
}

afterEach(() => { vi.restoreAllMocks() })

describe('exact public inverses of removeAccount, syncFolder and the Sent copy', () => {
  it('returns the removed credential-less account and restoreAccount re-inserts it byte-exactly', async () => {
    const host = await fixture()
    await mergeFolder(host.scope, id(2), 'INBOX', [message(11, 'lichen'), message(12, 'canopy', { flags: ['\\Flagged'] })])
    await mergeFolder(host.scope, id(2), 'Archive', [message(31, 'canopy', { flags: ['\\Flagged'] })])
    await mergeFolder(host.scope, id(3), 'INBOX', [message(5, 'other')])
    const before = await host.snapshot()
    const removed = await host.call('removeAccount', { accountId: id(2) })
    expect(removed.ok).toBe(true)
    expect(removed.data.accounts.map((row: EmailAccount) => row.id)).toEqual([id(1), id(3)])
    expect(removed.data.restore).toMatchObject({ index: 1, account: account(2) })
    expect(removed.data.restore.folderMessages).toHaveLength(3)
    expect(removed.data.restore.messages).toHaveLength(3)
    expect(host.api.credentials.delete).toHaveBeenCalledOnce()
    const restored = await host.call('restoreAccount', { restore: removed.data.restore })
    expect(restored).toMatchObject({ ok: true, data: { account: account(2) } })
    expect(restored.data.accounts.map((row: EmailAccount) => row.id)).toEqual([id(1), id(2), id(3)])
    expect(await host.snapshot()).toEqual(before)
    expect(await host.call('restoreAccount', { restore: removed.data.restore })).toMatchObject({ ok: false, code: 'ACCOUNT_EXISTS', outcome: 'not-applied' })
    expect(await host.snapshot()).toEqual(before)
    await host.dispose()
  })

  it('keeps removal unchanged for an account with a stored password and returns no restore for it', async () => {
    const host = await fixture('stored')
    await mergeFolder(host.scope, id(2), 'INBOX', [message(11, 'lichen')])
    const removed = await host.call('removeAccount', { accountId: id(2) })
    expect(removed).toMatchObject({ ok: true, data: { restore: null } })
    expect(host.api.credentials.delete).toHaveBeenCalledWith(id(2), transport.MAIL_CREDENTIAL_STORE)
    expect(await queryAll(host.scope, 'folder_messages', { accountId: id(2) })).toEqual([])
    expect(await host.call('restoreAccount', { restore: { index: 0, account: account(2), folderMessages: [], messages: [] } })).toMatchObject({ ok: false, code: 'ACCOUNT_EXISTS', outcome: 'not-applied' })
    expect(JSON.parse((await host.mock.api.data.files.readText('accounts.json'))!).map((row: EmailAccount) => row.id)).toEqual([id(1), id(3)])
    await host.dispose()
  })

  it('refuses a restore whose rows belong to another account or collide with cached rows', async () => {
    const host = await fixture()
    await mergeFolder(host.scope, id(2), 'INBOX', [message(11, 'lichen')])
    const removed = await host.call('removeAccount', { accountId: id(2) })
    const foreign = { ...removed.data.restore, messages: removed.data.restore.messages.map((row: Record<string, unknown>) => ({ ...row, accountId: id(3) })) }
    expect(await host.call('restoreAccount', { restore: foreign })).toMatchObject({ ok: false, code: 'INVALID_INPUT', outcome: 'not-applied' })
    await mergeFolder(host.scope, id(2), 'INBOX', [message(11, 'lichen')])
    const before = await host.snapshot()
    expect(await host.call('restoreAccount', { restore: removed.data.restore })).toMatchObject({ ok: false, code: 'ACCOUNT_EXISTS', outcome: 'not-applied' })
    expect(await host.snapshot()).toEqual(before)
    await host.dispose()
  })

  it('writes back or deletes a sync position only while it still equals the expected one', async () => {
    const host = await fixture()
    vi.spyOn(transport, 'fetchFolder').mockResolvedValue({ messages: [message(13, 'fresh')], uidValidity: 7 })
    const previous = { uidValidity: 7, cursor: '12', lastSyncAt: '2031-04-05T00:00:00.000Z' }
    await host.mock.api.data.dataset('sync_state').upsert({ accountId: id(1), folder: 'INBOX', ...previous })
    const before = await host.snapshot()
    expect(await host.call('syncFolder', { accountId: id(1), folder: 'INBOX', limit: 1 })).toMatchObject({ ok: true, data: { fetched: 1 } })
    const synced = await host.mock.api.data.dataset('sync_state').get({ accountId: id(1), folder: 'INBOX' })
    expect(synced).toMatchObject({ cursor: '13' })
    const expected = { uidValidity: synced!.uidValidity, cursor: synced!.cursor, lastSyncAt: synced!.lastSyncAt }
    expect(await host.call('restoreSyncState', { accountId: id(1), folder: 'INBOX', expected: previous, previous })).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', outcome: 'not-applied' })
    expect(await host.mock.api.data.dataset('sync_state').get({ accountId: id(1), folder: 'INBOX' })).toEqual(synced)
    expect(await host.call('restoreSyncState', { accountId: id(1), folder: 'INBOX', expected, previous })).toEqual({ ok: true, data: { syncState: { accountId: id(1), folder: 'INBOX', ...previous } } })
    expect(await host.call('forgetCachedMessage', { accountId: id(1), folder: 'INBOX', uid: 13 })).toEqual({ ok: true, data: { accountId: id(1), folder: 'INBOX', uid: 13, messageRemoved: true } })
    expect(await host.snapshot()).toEqual(before)
    expect(await host.call('restoreSyncState', { accountId: id(1), folder: 'INBOX', expected: previous, previous: null })).toEqual({ ok: true, data: { syncState: null } })
    expect(await host.mock.api.data.dataset('sync_state').get({ accountId: id(1), folder: 'INBOX' })).toBeNull()
    expect(await host.call('restoreSyncState', { accountId: 'missing', folder: 'INBOX', expected: null, previous: null })).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND', outcome: 'not-applied' })
    await host.dispose()
  })

  it('forgets a cached Sent copy with its message and recipients, and keeps a message another folder still holds', async () => {
    const host = await fixture()
    await mergeFolder(host.scope, id(1), 'INBOX', [message(12, 'canopy')])
    const [inbox] = await queryAll(host.scope, 'folder_messages', { accountId: id(1) })
    await host.mock.api.data.dataset('folder_messages').upsert({ ...inbox, folder: 'Archive', uid: 31 })
    const before = await host.snapshot()
    await appendMessage(host.scope, id(1), 'Sent', message(1924992000000, 'sent'))
    expect((await queryAll(host.scope, 'recipients')).length).toBeGreaterThan((before.recipients as unknown[]).length)
    expect(await host.call('forgetCachedMessage', { accountId: id(1), folder: 'Sent', uid: 1924992000000 })).toMatchObject({ ok: true, data: { messageRemoved: true } })
    expect(await host.snapshot()).toEqual(before)
    expect(await host.call('forgetCachedMessage', { accountId: id(1), folder: 'Archive', uid: 31 })).toMatchObject({ ok: true, data: { messageRemoved: false } })
    expect(await queryAll(host.scope, 'messages', { accountId: id(1) })).toHaveLength(1)
    expect((await queryAll(host.scope, 'recipients')).map(row => JSON.stringify(row)).sort()).toEqual(before.recipients)
    expect(await host.call('forgetCachedMessage', { accountId: id(1), folder: 'Archive', uid: 31 })).toMatchObject({ ok: false, code: 'MESSAGE_NOT_FOUND', outcome: 'not-applied' })
    await host.dispose()
  })
})
