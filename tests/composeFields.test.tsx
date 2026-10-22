import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createMailMock } from './mailMock'
import { register } from '../src/index'
import { Compose } from '../src/Compose'
import { getStore } from '../src/store'

let dispose: (() => void | Promise<void>) | undefined
afterEach(async () => { cleanup(); await dispose?.(); dispose = undefined })

async function setup() {
  const mock = createMailMock({ manifest: { id: 'email' } })
  mock.mail.listAccounts = async () => ({ ok: true, data: { accounts: [{ id: 'one', provider: 'pureemail', address: 'one@example.com', displayName: 'one',
    imap: { host: 'example.com', port: 993, secure: true }, smtp: { host: 'example.com', port: 465, secure: true }, createdAt: 1 }] } })
  dispose = register(mock.api)
  await getStore().whenReady
  await getStore().startCompose()
  render(<Compose />)
  return mock
}

// Counts every script write to a field's value or default value (React's own tracker included) and every change to a
// textarea's text children: the writes that end the browser's typing undo group.
function watch(field: HTMLInputElement | HTMLTextAreaElement) {
  const writes: string[] = []
  const proto = Object.getPrototypeOf(field) as object
  for (const name of ['value', 'defaultValue'] as const) {
    const inner = Object.getOwnPropertyDescriptor(field, name) ?? Object.getOwnPropertyDescriptor(proto, name)!
    Object.defineProperty(field, name, { configurable: true, get() { return inner.get!.call(this) }, set(value: string) { writes.push(name); inner.set!.call(this, value) } })
  }
  const mutations: MutationRecord[] = []
  const observer = new MutationObserver((records) => mutations.push(...records))
  observer.observe(field, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['value'] })
  return { writes, mutations: () => { mutations.push(...observer.takeRecords()); return mutations } }
}

// What a key press does: the browser changes the value itself (no script setter) and fires input.
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
  for (const character of text) {
    act(() => {
      setter.call(field, field.value + character)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}

describe('Email compose fields (F18)', () => {
  it('never rewrites the body or the subject while the user types, and still saves every keystroke', async () => {
    await setup()
    const body = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    const subject = document.querySelector('.email-compose-subject input') as HTMLInputElement
    const watched = [watch(body), watch(subject)]
    typeInto(body, 'Heron count: 12')
    typeInto(subject, 'Pond walk')
    expect(getStore().getSnapshot().compose).toMatchObject({ text: 'Heron count: 12', subject: 'Pond walk', dirty: true })
    expect(watched.map((entry) => entry.writes)).toEqual([[], []])
    expect(watched.map((entry) => entry.mutations().length)).toEqual([0, 0])
    expect([body.value, subject.value]).toEqual(['Heron count: 12', 'Pond walk'])
  })

  it('shows a change from outside the field, such as another draft or a revert', async () => {
    await setup()
    const body = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
    typeInto(body, 'Typed')
    act(() => getStore().updateDraft({ text: 'Replaced from outside', subject: 'Reply' }))
    expect(body.value).toBe('Replaced from outside')
    expect((document.querySelector('.email-compose-subject input') as HTMLInputElement).value).toBe('Reply')
  })

  it('never rewrites the recipient query while the user types and clears it after the address is added', async () => {
    const mock = await setup()
    fireEvent.click(screen.getByRole('button', { name: 'Add recipient To' }))
    render(<>{mock.popovers.at(-1)!.node}</>)
    const query = screen.getByRole('combobox', { name: 'Name or email address' }) as HTMLInputElement
    const watched = watch(query)
    typeInto(query, 'heron@')
    expect(getStore().getSnapshot().compose?.pending.to).toBe('heron@')
    expect(watched.writes).toEqual([])
    expect(watched.mutations()).toHaveLength(0)
    act(() => getStore().updateDraft({ pending: { to: '', cc: '', bcc: '' } }))
    await waitFor(() => expect(query.value).toBe(''))
  })
})
