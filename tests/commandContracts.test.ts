import { expect, it } from 'vitest'
import { commandContracts } from './commandContracts'

it('publishes distinct typed input and output contracts for every background action', () => {
  expect(commandContracts).toHaveLength(12)
  expect(new Set(commandContracts.map(entry => entry.command.id)).size).toBe(commandContracts.length)
  for (const entry of commandContracts) expect(entry.output({ unexpected: 'not an owner result' }), entry.command.id).toBe(false)
})

it('declares account removal as an irreversible execute without an undo hook', () => {
  const removal = commandContracts.find(entry => entry.command.id === 'removeAccount')!.command
  expect(removal).toMatchObject({ effect: 'execute', recovery: 'non-replayable' })
  expect(removal.undoMethod).toBeUndefined()
  expect(removal.revisionMethod).toBeUndefined()
  const addition = commandContracts.find(entry => entry.command.id === 'addSmtpAccount')!.command
  expect(addition.effect).toBe('execute')
})
