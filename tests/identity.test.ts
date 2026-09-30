import { describe, expect, it } from 'vitest'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { identifyMessage, normalizedMessageId } from '../src/backend/identity'
import { emailStoreContext, establishFolderEpoch, mergeFolder } from '../src/backend/cache'
import { queryMessages } from '../src/backend/query'
import type { CachedMessage } from '../src/mailTypes'

const message: CachedMessage = { uid: 1, uidValidity: 4, messageId: '<Canopy@example.test>', from: 'canopy@example.test', to: 'moss@example.test', subject: 'Forest survey', date: '', originalDate: null, text: 'Fern spores', snippet: '', flags: [], hasAttachments: false, complete: true }

describe('logical email identity', () => {
  it('preserves significant Message-ID case and handles absent or malformed headers', async () => {
    expect(normalizedMessageId(' <Canopy@example.test> ')).toBe('<Canopy@example.test>')
    expect(normalizedMessageId('<missing>')).toBeNull()
    const base = await identifyMessage('forest', 'INBOX', message)
    expect((await identifyMessage('forest', 'Archive', { ...message, uid: 99, uidValidity: 20, flags: ['\\Seen'] })).logicalId).toBe(base.logicalId)
    for (const change of [{ messageId: '<canopy@example.test>' }, { text: 'Moss spores' }, { originalDate: 'unknown' }, { subject: 'Wetland survey' }, { to: 'fern@example.test' }]) {
      expect((await identifyMessage('forest', 'INBOX', { ...message, ...change })).logicalId).not.toBe(base.logicalId)
    }
    expect((await identifyMessage('meadow', 'INBOX', message)).logicalId).not.toBe(base.logicalId)
    const missing = await identifyMessage('forest', 'INBOX', { ...message, messageId: '' })
    expect((await identifyMessage('forest', 'Archive', { ...message, messageId: 'broken', uid: 2 })).logicalId).toBe(missing.logicalId)
    expect((await identifyMessage('forest', 'INBOX', { ...message, messageId: '', text: 'Different body' })).logicalId).not.toBe(missing.logicalId)
  })

  it('distinguishes attachments and keeps incomplete messages isolated', async () => {
    const attached = { ...message, hasAttachments: true, attachmentDigests: ['fern-digest'] }
    const base = await identifyMessage('forest', 'INBOX', attached)
    expect((await identifyMessage('forest', 'INBOX', { ...attached, attachmentDigests: ['moss-digest'] })).logicalId).not.toBe(base.logicalId)
    const incomplete = await identifyMessage('forest', 'INBOX', { ...message, complete: false })
    expect((await identifyMessage('forest', 'Archive', { ...message, complete: false })).logicalId).not.toBe(incomplete.logicalId)
    expect((await identifyMessage('forest', 'INBOX', { ...message, complete: false, uid: 2 })).logicalId).not.toBe(incomplete.logicalId)
  })

  it('retains separate memberships and assignments across UIDVALIDITY resets and cache rebuilding', async () => {
    const mock = createMockValleyApi({ manifest: { id: 'forest-mail', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
    const scope = emailStoreContext(mock.api.data)
    await mergeFolder(scope, 'forest', 'INBOX', [message, { ...message, uid: 2 }])
    const first = await queryMessages(scope, { accountId: 'forest', view: 'recent' })
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0].date).toBe('')
    expect(first.messages[0].memberships).toHaveLength(2)
    const id = first.messages[0].id
    await mock.api.data.dataset('assignments').insert({ id, categoryId: 'canopy', manual: true, contentRevision: null, configurationRevision: null, revision: 1 })
    await mock.api.data.dataset('sync_state').upsert({ accountId: 'forest', folder: 'INBOX', uidValidity: 4, cursor: '2', lastSyncAt: new Date().toISOString() })
    expect(await establishFolderEpoch(scope, 'forest', 'INBOX', 5)).toBe(false)
    expect((await queryMessages(scope, { accountId: 'forest', view: 'recent' })).messages).toHaveLength(0)
    await mock.api.data.dataset('messages').delete({ id })
    await mergeFolder(scope, 'forest', 'INBOX', [{ ...message, uidValidity: 5, uid: 9 }])
    expect((await queryMessages(scope, { accountId: 'forest', view: 'recent' })).messages[0]).toMatchObject({ id, categoryId: 'canopy', memberships: [{ uid: 9 }] })
    expect(await mock.api.data.dataset('assignments').get({ id })).toMatchObject({ manual: true })
  })
})
