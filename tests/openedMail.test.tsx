import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { Attachments, BodyNote, SAVE_ATTACHMENT_BYTES } from '../src/Attachments'
import { createMessageController, DISPLAY_BODY_CHARACTERS, loadDeferredBody } from '../src/messageController'
import { encodeBytes } from '../src/backend/encoding'
import type { EmailDriver, EmailMessageDetail } from '../src/mailTypes'
import type { EmailSnapshot } from '../src/store'

afterEach(cleanup)

const detail = (patch: Partial<EmailMessageDetail> = {}): EmailMessageDetail => ({ id: 'v1:large', accountId: 'pureemail-fixture', folder: 'INBOX', uid: 31, uidValidity: 7, memberships: [], messageId: '<m31@birds.example>',
  from: 'desk@birds.example', to: 'hoopoe@birds.example', subject: 'Zählbogen', date: '2026-10-21T08:00:00.000Z', snippet: '', flags: ['\\Seen'], hasAttachments: false,
  addresses: { from: [{ name: '', address: 'desk@birds.example' }], to: [], cc: [], replyTo: [] }, ...patch })

describe('opening a large message', () => {
  it('loads a deferred body slice by slice before showing the message', async () => {
    const text = 'Schilfrohrsänger äöüß '.repeat(20_000)
    const slices: number[] = []
    const mail = {
      readMessage: vi.fn(async () => ({ ok: true, data: { message: detail({ bodyDeferred: true }) } })),
      loadMessageContent: vi.fn(async (input: { field: 'text' | 'html'; offset: number }) => {
        if (input.field === 'html') return { ok: true, data: { field: input.field, offset: 0, total: 0, chunk: '' } }
        slices.push(input.offset)
        return { ok: true, data: { field: input.field, offset: input.offset, total: text.length, chunk: text.slice(input.offset, input.offset + 100_000) } }
      }),
      applyMessageAction: vi.fn()
    } as unknown as EmailDriver
    let state = { messages: [], selectedMessage: null, actionUid: null } as unknown as EmailSnapshot
    const set = (patch: Partial<EmailSnapshot>) => { state = { ...state, ...patch } }
    const controller = createMessageController(mail, { snapshot: () => state, active: () => true, activeAccountIds: () => ['pureemail-fixture'], set, report: error => { throw error },
      updateTitle: () => {}, pushHistory: () => {}, removeFromHistory: () => {}, resolveContacts: async () => {} })
    controller.openMessage({ accountId: 'pureemail-fixture', folder: 'INBOX', uid: 31, uidValidity: 7 })
    await waitFor(() => expect(state.loadingMessage).toBe(false))
    expect(state.selectedMessage).toMatchObject({ subject: 'Zählbogen', text, bodyDeferred: false })
    expect(slices).toEqual([0, 100_000, 200_000, 300_000, 400_000])
  })

  it('keeps a body longer than one plugin UI message can carry to the display limit and says so', async () => {
    const text = 'x'.repeat(DISPLAY_BODY_CHARACTERS + 700_000)
    const mail = {
      readMessage: vi.fn(async () => ({ ok: true, data: { message: detail({ bodyDeferred: true }) } })),
      loadMessageContent: vi.fn(async (input: { field: 'text' | 'html'; offset: number }) => input.field === 'html'
        ? { ok: true, data: { field: input.field, offset: 0, total: 0, chunk: '' } }
        : { ok: true, data: { field: input.field, offset: input.offset, total: text.length, chunk: text.slice(input.offset, input.offset + 512 * 1024) } })
    }
    const message = await loadDeferredBody(mail as never, detail({ bodyDeferred: true }))
    expect(message.text).toHaveLength(DISPLAY_BODY_CHARACTERS)
    expect(message.bodyTruncated).toEqual({ shown: DISPLAY_BODY_CHARACTERS, total: text.length })
    const mock = createMailMock({ manifest: { id: 'email' } })
    const dispose = register(mock.api)
    render(React.createElement(BodyNote, { message }))
    expect(screen.getByRole('note').textContent).toBe('This message is too long to show completely: showing the first 0.5 MB of 1.2 MB.')
    dispose()
  })

  it('saves an attachment fetched on demand as bytes and refuses one above the save limit', async () => {
    const mock = createMailMock({ manifest: { id: 'email' } })
    const dispose = register(mock.api)
    const original = Uint8Array.from({ length: 300_000 }, (_, index) => (index * 7) & 255)
    const encoded = new TextEncoder().encode(encodeBytes(original).replace(/.{76}/g, '$&\r\n'))
    mock.mail.readAttachment = vi.fn(async input => ({ ok: true, data: { filename: 'survey.bin', mimeType: 'application/octet-stream', encoding: 'base64', encodedSize: encoded.length, offset: input.offset, data: encodeBytes(encoded.subarray(input.offset, input.offset + 100_000)) } }))
    const downloadFile = vi.fn(async () => '/Downloads/survey.bin')
    Object.assign(mock.api.files, { downloadFile })
    render(React.createElement(Attachments, { message: detail({ hasAttachments: true, attachments: [{ index: 0, filename: 'survey.bin', mimeType: 'application/octet-stream', size: original.length }, { index: 1, filename: 'archive.zip', mimeType: 'application/zip', size: SAVE_ATTACHMENT_BYTES + 1 }] }) }))
    expect((screen.getByRole('button', { name: /archive\.zip|above/i }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save survey.bin' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved to /Downloads/survey.bin'))
    expect(downloadFile).toHaveBeenCalledOnce()
    const [name, content] = downloadFile.mock.calls[0] as unknown as [string, Uint8Array]
    expect(name).toBe('survey.bin')
    expect(content).toEqual(original)
    expect(vi.mocked(mock.mail.readAttachment).mock.calls.map(([input]) => input.offset)).toEqual([0, 100_000, 200_000, 300_000, 400_000])
    dispose()
  })
})
