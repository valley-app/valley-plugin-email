import { describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import { createMockValleyApi } from '@valley/plugin-testkit'
import type { ValleyPluginManifest } from '@valley/plugin-sdk/types'
import config from '../config.json'
import { assertAutomaticReplyAllowed, automationHeaders, prepareAutomaticMail } from '../src/backend/automation'
import { emailStoreContext, mergeFolder, readFolder } from '../src/backend/cache'
import { readMessage } from '../src/backend/query'
import type { CachedMessage, EmailAccount } from '../src/mailTypes'

const account: EmailAccount = { id: 'flora', provider: 'pureemail', address: 'flora@example.test', createdAt: 0, imap: { host: 'imap.example.test', port: 993, secure: true }, smtp: { host: 'smtp.example.test', port: 465, secure: true } }
const input = { accountId: account.id, to: 'canopy@example.test', subject: 'Canopy', text: 'Fern' }
const receipt = '11111111-1111-4111-8111-111111111111'
const causation = { rootId: '22222222-2222-4222-8222-222222222222', runId: 'flora-run', originPlugin: 'fauna', depth: 0 }
function fixture() {
  const mock = createMockValleyApi({ manifest: { id: 'email', datasets: config.datasets as unknown as ValleyPluginManifest['datasets'] } })
  const services = { inspectCausation: vi.fn(async () => structuredClone(causation)), captureCausation: vi.fn(async () => receipt) }
  return { mock, scope: { data: mock.api.data, services } }
}

describe('automatic mail provenance and loop prevention', () => {
  it('retains bounded In-Reply-To observations through cached message reads', async () => {
    const { scope } = fixture()
    const headers = automationHeaders([{ key: 'References', value: '<request@example.test>' }, { key: 'In-Reply-To', value: '<request@example.test>' }, ...Array.from({ length: 20 }, (_, index) => ({ key: 'In-Reply-To', value: `<reply-${index}@example.test>` }))])
    expect(headers.inReplyTo).toHaveLength(16); expect(headers.uncertain).toBe(true)
    const store = emailStoreContext(scope.data)
    await mergeFolder(store, account.id, 'INBOX', [{ uid: 1, messageId: '<response@example.test>', from: 'canopy@example.test', to: account.address, subject: 'Canopy', date: '2026-01-01T00:00:00Z', snippet: 'Fern', flags: [], hasAttachments: false, automationHeaders: headers }])
    expect((await readMessage(store, { accountId: account.id, folder: 'INBOX', uid: 1 }))?.automationHeaders).toMatchObject({ inReplyTo: expect.arrayContaining(['<request@example.test>']), references: ['<request@example.test>'] })
  })
  it('accepts observed thread headers in every published message contract', () => {
    const compiler = new Ajv({ strict: false })
    let checked = 0
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const schema = value as { properties?: Record<string, unknown> }
      if (schema.properties?.autoSubmitted && schema.properties?.observed) {
        const validate = compiler.compile(schema)
        expect(validate(automationHeaders([{ key: 'In-Reply-To', value: '<request@example.test>' }, { key: 'References', value: '<request@example.test>' }]))).toBe(true)
        expect(validate({ ...automationHeaders([]), references: Array(17).fill('<request@example.test>') })).toBe(false)
        checked++
      }
      Object.values(value).forEach(visit)
    }
    visit(config)
    expect(checked).toBeGreaterThan(0)
  })
  it('preserves manual sends and never accepts payload headers as automation authority', async () => {
    const { scope } = fixture()
    scope.services.inspectCausation.mockResolvedValue(undefined as never)
    expect(await prepareAutomaticMail(scope, account, { ...input, ...{ automatic: true, headers: { 'X-Valley-Origin': receipt } } })).toBeUndefined()
    expect(scope.services.captureCausation).not.toHaveBeenCalled()
  })

  it('persists unknown before SMTP and does not replay a receipt after owner reload or completion', async () => {
    const { scope } = fixture()
    const prepared = await prepareAutomaticMail(scope, account, input)
    expect(prepared?.origin).toBe(receipt)
    const files = await scope.data.files.list('automatic-mail')
    expect(files).toHaveLength(1)
    const path = `automatic-mail/${files[0].name}`
    expect(JSON.parse((await scope.data.files.readText(path))!)).toMatchObject({ receipt, messageId: prepared?.messageId, state: 'unknown' })
    await expect(prepareAutomaticMail({ ...scope }, account, input)).rejects.toThrow('already accepted')
    await prepared!.complete()
    expect(JSON.parse((await scope.data.files.readText(path))!)).toMatchObject({ receipt, state: 'sent' })
    await expect(prepareAutomaticMail(scope, account, input)).rejects.toThrow('already accepted')
  })

  it('retains trusted inbound header observations in cache and blocks automatic replies to automated messages', async () => {
    const { scope } = fixture()
    const message: CachedMessage = { uid: 1, messageId: '<fern@example.test>', from: 'canopy@example.test', to: account.address, subject: 'Canopy', date: '2026-01-01T00:00:00Z', snippet: 'Fern', text: 'Fern', flags: [], hasAttachments: false, complete: true, automationHeaders: automationHeaders([{ key: 'Auto-Submitted', value: 'auto-generated' }, { key: 'X-Valley-Origin', value: receipt }]) }
    const store = emailStoreContext(scope.data)
    await mergeFolder(store, account.id, 'INBOX', [message])
    expect((await readFolder(store, account.id, 'INBOX'))[0].automationHeaders).toEqual(message.automationHeaders)
    expect((await readMessage(store, { accountId: account.id, folder: 'INBOX', uid: 1 }))?.automationHeaders).toEqual(message.automationHeaders)
    await expect(prepareAutomaticMail(scope, account, { ...input, inReplyTo: message.messageId })).rejects.toThrow('email loop')
    expect(await scope.data.files.list('automatic-mail')).toHaveLength(0)
  })

  it('fails closed for missing, malformed, duplicate, and truncated incoming evidence', async () => {
    for (const evidence of [undefined, {}, automationHeaders([{ key: 'List-ID', value: 'flora.example.test' }]), automationHeaders([{ key: 'Precedence', value: 'bulk' }]), automationHeaders([{ key: 'X-Auto-Response-Suppress', value: 'All' }]), automationHeaders([{ key: 'Auto-Submitted', value: 'no' }, { key: 'Auto-Submitted', value: 'no' }]), automationHeaders([{ key: 'Auto-Submitted', value: 'x'.repeat(9000) }])]) expect(() => assertAutomaticReplyAllowed(evidence)).toThrow()
    expect(() => assertAutomaticReplyAllowed(automationHeaders([]))).not.toThrow()
    expect(() => automationHeaders([{ key: 'constructor', value: 'ignored' }, { key: '__proto__', value: 'ignored' }])).not.toThrow()
    const { scope } = fixture()
    await expect(prepareAutomaticMail(scope, account, { ...input, inReplyTo: '<missing@example.test>' })).rejects.toThrow('one complete')
  })

  it('reports every refusal before the reservation as a known no-effect outcome', async () => {
    const refused = (code: string) => expect.objectContaining({ code, outcome: 'not-applied' })
    expect(() => assertAutomaticReplyAllowed(undefined)).toThrow(refused('AUTOMATIC_HEADERS_UNVERIFIED'))
    expect(() => assertAutomaticReplyAllowed(automationHeaders([{ key: 'Precedence', value: 'bulk' }]))).toThrow(refused('AUTOMATIC_EMAIL_LOOP'))
    const cases: Array<[string, (scope: ReturnType<typeof fixture>['scope']) => Promise<unknown>]> = [
      ['AUTOMATIC_CAUSATION_MISMATCH', async (scope) => { scope.services.inspectCausation.mockResolvedValueOnce(structuredClone(causation)).mockResolvedValueOnce({ ...causation, runId: 'other' }); return prepareAutomaticMail(scope, account, input) }],
      ['AUTOMATIC_INVALID_MESSAGE_ID', (scope) => prepareAutomaticMail(scope, account, { ...input, inReplyTo: 'not a message id' })],
      ['AUTOMATIC_INCOMING_UNAVAILABLE', (scope) => prepareAutomaticMail(scope, account, { ...input, inReplyTo: '<missing@example.test>' })],
      ['AUTOMATIC_ALREADY_ACCEPTED', async (scope) => { await prepareAutomaticMail(scope, account, input); return prepareAutomaticMail(scope, account, input) }],
      ['AUTOMATIC_RECEIPT_LIMIT', async (scope) => { vi.spyOn(scope.data.files, 'list').mockResolvedValueOnce(Array.from({ length: 4096 }, (_, index) => ({ name: `${index}.json` })) as never); return prepareAutomaticMail(scope, account, input) }]
    ]
    for (const [code, attempt] of cases) {
      const { scope } = fixture()
      const before = code === 'AUTOMATIC_ALREADY_ACCEPTED' ? 1 : 0
      await expect(attempt(scope), code).rejects.toEqual(refused(code))
      expect(await scope.data.files.list('automatic-mail'), code).toHaveLength(before)
    }
  })
})
