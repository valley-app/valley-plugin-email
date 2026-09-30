import { AGENT_TOOL_PROVIDER_V1, SEARCH_RESULT_ACTION_V1, type ValleyPluginApi, type ValleyPluginModule } from '@valley/plugin-sdk'
import { initRuntime, React } from './runtime'
import { injectStyles } from './styles'
import { getStore, disposeStore } from './store'
import { registerEmailFence } from './fence'
import { Panel } from './Panel'
import { Preview } from './Preview'
import { Page } from './Page'
import { Settings } from './Settings'
import { initLocalization } from './localization'
import { emailAgentTools, registerEmailAgentCommands } from './agentTools'
import { registerEmailSurfaces } from './surfaces'

export function register(api: ValleyPluginApi): () => Promise<void> {
  initLocalization(api)
  initRuntime(api)
  const disposeStyles = injectStyles()
  // Instantiate the window-anchored store eagerly so account state loads.
  const store = getStore(api)
  const offLinkHandler = api.links.register({
    id: 'compose', label: api.ui.t('manifest.name'), version: '1.0.0', categories: ['email'], schemes: ['mailto'],
    open: async ({ value }) => {
      await store.whenReady
      const url = new URL(value)
      const addresses = (raw: string) => raw.split(',').map(address => address.trim()).filter(address => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)).map(address => ({ address, name: '' }))
      const previous = store.getSnapshot().compose
      await store.startCompose('new', undefined, { to: addresses(decodeURIComponent(url.pathname)), cc: addresses(url.searchParams.get('cc') ?? ''), bcc: addresses(url.searchParams.get('bcc') ?? ''), subject: (url.searchParams.get('subject') ?? '').replace(/[\r\n]/g, ' '), text: url.searchParams.get('body') ?? '' })
      api.workspace.openMainTab()
      return { status: store.getSnapshot().compose !== previous ? 'opened' : store.getSnapshot().selectedAccountId ? 'cancelled' : 'unavailable' }
    }
  })
  const offNotification = api.notifications.onAction(event => {
    if (event.action !== 'click' || !event.targetItemId) return
    void (async () => {
      await store.whenReady
      if (event.eventId.endsWith('.newMail')) {
        const message = JSON.parse(event.targetItemId!) as { accountId: string; folder: string; uid: number }
        await store.restoreSelection({ accountIds: [message.accountId], view: 'folder', folder: message.folder, message })
      }
      api.workspace.openMainTab()
    })().catch(() => {})
  })
  const offFlush = api.runtime.onBeforeUnload(() => store.flushDraft())
  const offCommands = registerEmailAgentCommands(api)
  const offSurfaces = registerEmailSurfaces(api)
  const offSearch = api.interop.extensions.provide(SEARCH_RESULT_ACTION_V1, {
    cardKind: 'email',
    open: async (record, context) => {
      if (typeof record.id !== 'string' || !record.id || typeof record.accountId !== 'string' || !record.accountId) return false
      const memberships = api.data.dataset('folder_messages')
      const where = { accountId: record.accountId, messageId: record.id }
      const inbox = await memberships.query({ where: { ...where, folder: 'INBOX' }, limit: 1 })
      const membership = inbox.rows[0] ?? (await memberships.query({ where, orderBy: [{ field: 'folder', direction: 'asc' }, { field: 'uid', direction: 'asc' }], limit: 1 })).rows[0]
      if (!membership || typeof membership.folder !== 'string' || typeof membership.uid !== 'number' || !Number.isSafeInteger(membership.uid) || membership.uid < 1) return false
      const restored = await store.restoreSelection({
        accountIds: [record.accountId], view: 'folder', folder: membership.folder,
        message: { accountId: record.accountId, folder: membership.folder, uid: membership.uid }
      })
      if (restored) api.workspace.openMainTab({ newTab: context.newTab })
      return restored
    }
  })

  api.registerView('email.panel', Panel)
  api.registerView('email.preview', Preview)
  api.registerView('email.page', Page)
  api.registerView('email.settings', Settings)

  const offCompose = api.commands.register({
    id: 'compose',
    label: 'Email: Compose', labelKey: 'auto.0a3f4e087378',
    sideEffect: 'read',
    run: () => {
      getStore(api).startCompose()
      api.workspace.openMainTab()
      return undefined
    }
  })
  const offOpen = api.commands.register({
    id: 'open-mailbox',
    label: 'Email: Open mailbox', labelKey: 'auto.ddf53deccb65',
    sideEffect: 'read',
    run: () => {
      api.workspace.openMainTab()
      return undefined
    }
  })
  const offSync = api.commands.register({
    id: 'sync',
    label: 'Email: Sync folder', labelKey: 'auto.03820524c5cb',
    sideEffect: 'write',
    run: async () => {
      await getStore(api).sync()
      return { value: undefined, revert: null }
    }
  })
  const offFence = registerEmailFence()
  const offAgentTools = api.interop.services.provide(AGENT_TOOL_PROVIDER_V1, emailAgentTools(api))

  return () => {
    offLinkHandler()
    offNotification()
    offFlush()
    offCompose()
    offOpen()
    offSync()
    offFence()
    offAgentTools()
    offCommands()
    offSurfaces()
    offSearch()
    const drained = disposeStore(api)
    disposeStyles()
    return drained
  }
}

const plugin: ValleyPluginModule = { register }
export default plugin
