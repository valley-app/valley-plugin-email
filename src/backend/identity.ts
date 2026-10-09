import { addressParser } from 'postal-mime'
import type { CachedMessage } from '../mailTypes'

export async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function normalizedMessageId(value: string): string | null {
  const trimmed = value.trim().replace(/\r?\n[\t ]+/g, ' ')
  return /^<[^<>\s@]+@[^<>\s@]+>$/.test(trimmed) ? trimmed : null
}

const addresses = (value: string | undefined) => addressParser(value ?? '', { flatten: true }).map(address => [address.name ?? '', address.address ?? ''])
const body = (value: string | undefined) => value === undefined ? null : value.replace(/\r\n?/g, '\n')

export async function identifyMessage(accountId: string, folder: string, message: CachedMessage): Promise<CachedMessage> {
  if (message.logicalId && message.contentRevision) return message
  const contentRevision = await digest(JSON.stringify([
    addresses(message.from), addresses(message.to), addresses(message.cc), addresses(message.bcc), addresses(message.replyTo),
    message.originalDate === undefined ? message.date || null : message.originalDate,
    message.subject, body(message.text), body(message.html), message.attachmentDigests ?? [], ...(message.automationHeaders ? [message.automationHeaders] : [])
  ]))
  const complete = message.complete !== false && (message.text !== undefined || message.html !== undefined || message.complete === true) && (!message.hasAttachments || message.attachmentDigests !== undefined)
  const identity = complete ? [normalizedMessageId(message.messageId), contentRevision] : ['incomplete', folder, message.uidValidity ?? null, message.uid, contentRevision]
  return { ...message, logicalId: `v1:${await digest(JSON.stringify([accountId, ...identity]))}`, contentRevision, complete }
}
