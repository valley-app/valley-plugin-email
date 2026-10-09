import { t } from './localization'
import { z } from 'zod'
import type { PluginBackendApi, PluginDataApi } from '@valley/plugin-sdk'
import type { EmailAccount, EmailSendInput, MailAutomationHeaders } from '../mailTypes'
import { digest, normalizedMessageId } from './identity'

/** A refusal raised before any effect: the caller learns nothing was applied. */
export class MailRefusal extends Error {
  readonly outcome = 'not-applied' as const
  constructor(readonly code: string, message: string) { super(message) }
}

export type MailAutomationServices = Pick<PluginBackendApi['services'], 'inspectCausation' | 'captureCausation'>
const values = z.array(z.string().max(2048)).max(16)
const headersSchema = z.object({ observed: z.literal(true), autoSubmitted: values, precedence: values, listId: values, suppress: values, origin: values, inReplyTo: values.optional(), references: values.optional(), uncertain: z.boolean().optional() }).strict()
const fields = { 'auto-submitted': 'autoSubmitted', precedence: 'precedence', 'list-id': 'listId', 'x-auto-response-suppress': 'suppress', 'x-valley-origin': 'origin', 'in-reply-to': 'inReplyTo', references: 'references' } as const

export function automationHeaders(headers: Array<{ key: string; value: string }>): MailAutomationHeaders {
  const result: MailAutomationHeaders = { observed: true, autoSubmitted: [], precedence: [], listId: [], suppress: [], origin: [] }
  let bytes = 0
  for (const header of headers) {
    const key = header.key.toLowerCase()
    if (!Object.hasOwn(fields, key)) continue
    const field = fields[key as keyof typeof fields]
    bytes += new TextEncoder().encode(header.value).length
    if (bytes > 8192 || header.value.length > 2048 || (result[field]?.length ?? 0) >= 16) { result.uncertain = true; continue }
    ;(result[field] ??= []).push(header.value.trim())
  }
  return result
}

export function readAutomationHeaders(value: unknown): MailAutomationHeaders | undefined {
  const result = headersSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function assertAutomaticReplyAllowed(value: unknown): void {
  const headers = readAutomationHeaders(value)
  if (!headers || headers.uncertain) throw new MailRefusal('AUTOMATIC_HEADERS_UNVERIFIED', t('email.automatic.verifiedHeaders'))
  if (headers.autoSubmitted.length > 1 || headers.autoSubmitted.some(entry => entry.toLowerCase() !== 'no') || headers.precedence.some(entry => /\b(bulk|list|junk)\b/i.test(entry)) || headers.listId.length || headers.suppress.some(entry => entry.toLowerCase() !== 'none') || headers.origin.length) throw new MailRefusal('AUTOMATIC_EMAIL_LOOP', t('email.automatic.emailLoop'))
}

export async function prepareAutomaticMail(scope: { data: PluginDataApi; services?: MailAutomationServices }, account: EmailAccount, input: EmailSendInput) {
  const causation = await scope.services?.inspectCausation()
  if (!causation) return undefined
  const receipt = await scope.services!.captureCausation()
  if (!receipt || JSON.stringify(await scope.services!.inspectCausation(receipt)) !== JSON.stringify(causation)) throw new MailRefusal('AUTOMATIC_CAUSATION_MISMATCH', t('email.automatic.authenticatedCausation'))
  if (input.inReplyTo) {
    const id = normalizedMessageId(input.inReplyTo)
    if (!id) throw new MailRefusal('AUTOMATIC_INVALID_MESSAGE_ID', t('email.automatic.validMessageIdentity'))
    const page = await scope.data.dataset('messages').query({ where: { accountId: account.id, messageId: id }, select: ['automationHeaders', 'complete'], limit: 2 })
    if (page.rows.length !== 1 || page.rows[0].complete !== true) throw new MailRefusal('AUTOMATIC_INCOMING_UNAVAILABLE', t('email.automatic.completeIncoming'))
    assertAutomaticReplyAllowed(page.rows[0].automationHeaders)
  }
  const key = await digest(JSON.stringify([causation.rootId, causation.runId, account.id, input]))
  const path = `automatic-mail/${key}.json`
  if (await scope.data.files.readTextBaseline(path)) throw new MailRefusal('AUTOMATIC_ALREADY_ACCEPTED', t('email.automatic.alreadyAccepted'))
  if ((await scope.data.files.list('automatic-mail')).length >= 4096) throw new MailRefusal('AUTOMATIC_RECEIPT_LIMIT', t('email.automatic.receiptLimit'))
  const messageId = `<${crypto.randomUUID()}@${account.address.split('@')[1]}>`
  const record = { version: 1, accountId: account.id, messageId, receipt, state: 'unknown', createdAt: new Date().toISOString() }
  const written = await scope.data.files.writeTextGuarded(path, JSON.stringify(record), null)
  if (!written.ok) throw new Error(t('email.automatic.reservationChanged'))
  return {
    origin: receipt, messageId,
    async complete(): Promise<void> {
      const current = await scope.data.files.readTextBaseline(path)
      if (!current || JSON.parse(current.content).messageId !== messageId) throw new Error(t('email.automatic.receiptUnavailable'))
      const saved = await scope.data.files.writeTextGuarded(path, JSON.stringify({ ...record, state: 'sent' }), current.baseline)
      if (!saved.ok) throw new Error(t('email.automatic.outcomeRetain'))
    }
  }
}
