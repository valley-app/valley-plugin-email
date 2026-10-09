import type { PluginCommand, ValleyPluginApi } from '@valley/plugin-sdk'
import type { CommandSideEffect } from '@valley/plugin-sdk/commands'
const text = { type: 'string', maxLength: 1048576 }
const flag = { type: 'boolean' }
const count = { type: 'integer', minimum: 0 }
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false })
const list = (items: Record<string, unknown>) => ({ type: 'array', items, maxItems: 10000 })
const nullableText = { type: ['string', 'null'], maxLength: 1048576 }
const summaryFields = { uid: { type: 'integer', minimum: 1 }, messageId: text, from: text, to: text, subject: text, date: text, read: flag, flagged: flag, hasAttachments: flag, snippet: text }
const message = object(summaryFields)
const noAccount = { const: 'No email account configured.' }
const accountResult = (schema: Record<string, unknown>) => ({ anyOf: [schema, noAccount] })
const sent = { sent: { const: true }, accountId: text, to: text, messageId: nullableText }
export const emailResults: Record<string, Record<string, unknown>> = {
  'list-mail-accounts': { anyOf: [list(object({ id: text, address: text, displayName: nullableText, provider: text })), { const: 'No accounts.' }] },
  'list-mail-folders': accountResult(object({ accountId: text, folders: list(object({ path: text, name: text, specialUse: nullableText, selectable: flag, cachedTotal: count, cachedUnread: count }, ['path'])) })),
  'read-inbox': { anyOf: [object({ accountId: text, folder: text, messages: list(message) }), noAccount, { const: 'Inbox empty.' }] },
  'search-email-messages': accountResult(object({ accountId: text, folder: text, query: text, messages: list(message) })),
  'read-mail-message': accountResult(object({ accountId: text, folder: text, ...summaryFields, replyTo: nullableText, cc: nullableText, text })),
  'update-email-message': accountResult(object({ accountId: text, folder: text, uid: count, action: { enum: ['mark-read', 'mark-unread', 'flag', 'unflag', 'archive', 'trash'] }, destinationFolder: nullableText })),
  'compose-email': accountResult(object(sent)), 'reply-to-email': accountResult(object({ ...sent, inReplyTo: text })), 'forward-email': accountResult(object({ ...sent, forwardedMessageId: text })),
  compose: { type: 'null' }, 'close-compose': object({ discarded: flag }), 'open-mailbox': { type: 'null' }, sync: { type: 'null' },
  'open-selection': object({ accountIds: list(text), view: { enum: ['folder', 'recent', 'unread', 'flagged'] }, folder: text, query: text, message: object({ accountId: text, folder: text, uid: { type: 'integer', minimum: 1 } }) }, ['accountIds', 'view', 'folder', 'query']),
  'update-properties': { ...object({ read: flag, flagged: flag }, []), minProperties: 1 }
}

export const commandRegistrar = (api: Pick<ValleyPluginApi, 'commands'>) => <I = void, O = void, E extends CommandSideEffect = 'read'>(command: PluginCommand<I, O, E> & { outputSchema: Record<string, unknown> }): (() => void) => api.commands.register(command)
