import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailNavigation } from './mailboxController'
import type { EmailSelection, EmailStore } from './store'
import { api } from './runtime'

/**
 * Email main tabs are SDK instances (`openMainTab({ instanceId })`), so the host saves and restores each tab's
 * state on its own. The store holds one live mailbox, and it always belongs to the focused tab, the Email tab the
 * user was last on. Every other tab keeps its selection and history here and gets them back when it becomes the
 * active tab again. A tab opened without an instance (an older workspace, or a plain `tab:create`) is keyed ''.
 */
export interface ParkedEmailTab { selection: EmailSelection; navigation?: EmailNavigation; title?: string }

export interface EmailTabs {
  /** Instance of the tab that shows the live mailbox; undefined for a tab without an instance. */
  instance(): string | undefined
  /** Whether some Email tab already owns the live mailbox. */
  claimed(): boolean
  /** What a tab that does not show the live mailbox keeps, or null when the tab shows it. */
  parked(instanceId?: string): ParkedEmailTab | null
  /** The host's restore of a main tab's saved state (reload, restart, bookmark, link). */
  restore(selection: EmailSelection, instanceId: string | undefined, background: boolean): Promise<void>
  /** Bring the live mailbox's tab forward after an action changed it. */
  reveal(): void
  /** Open a selection in a new Email tab and leave the current tab as it is. */
  openNew(selection: EmailSelection, title?: string): void
  subscribe(listener: () => void): () => void
  dispose(): void
}

/** How long a user action that let the host pick the Email tab waits for that tab to become active. */
const ADOPT_MS = 5000

let current: EmailTabs | null = null
export const emailTabs = (): EmailTabs | null => current
export const focusedTabInstance = (): string | undefined => current?.instance()
/** Show the live mailbox in its Email tab (actions from the sidebar, commands, notifications, links). */
export function revealEmailTab(): void { if (current) current.reveal(); else api.workspace.openMainTab() }

const newInstanceId = (): string => `mail-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`
const conflict = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'REVISION_CONFLICT'
const withoutMessage = (selection: EmailSelection): EmailSelection => ({ accountIds: selection.accountIds, view: selection.view, folder: selection.folder, query: selection.query })

export function createEmailTabs(api: ValleyPluginApi, store: EmailStore): EmailTabs {
  let focused: string | null = null
  let adoptUntil = 0
  let disposed = false
  const parked = new Map<string, ParkedEmailTab>()
  const replaced = new Map<string, number>()
  // A tab whose saved message is covered by an open draft at restore time gets it back when that draft view closes.
  let covered: { selection: EmailSelection; under: string } | null = null
  const mailbox = (): string => { const state = store.getSnapshot(); return JSON.stringify([state.selectedAccountIds, state.view, state.selectedFolder, state.selectedUid]) }
  const listeners = new Set<() => void>()
  let queue: Promise<void> = Promise.resolve()
  const key = (instanceId?: string): string => instanceId ?? ''
  const notify = (): void => { for (const listener of listeners) listener() }
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }
  const activeKey = (): string | null => {
    const tab = api.getState().activePluginTab
    return tab?.pluginId === api.pluginId ? key(tab.instanceId) : null
  }
  const park = (tab: string, entry: ParkedEmailTab): void => {
    parked.delete(tab)
    parked.set(tab, entry)
    while (parked.size > 100) parked.delete(parked.keys().next().value!)
  }
  // The pending saved state of a tab a user action just took over must not replace that action.
  const adopt = (tab: string): void => {
    adoptUntil = 0
    covered = null
    focused = tab
    parked.delete(tab)
    replaced.set(tab, Date.now() + 10_000)
    notify()
  }
  // A selection whose message no longer exists comes back as that message's folder, without an error.
  const select = async (selection: EmailSelection): Promise<void> => {
    try { await store.restoreSelection(selection); return } catch { if (!selection.message) return }
    try { await store.restoreSelection(withoutMessage(selection)) } catch { /* The account or folder is gone: keep the mailbox. */ }
  }
  // A tab without in-session history starts its own history at the restored selection.
  const fresh = async (selection: EmailSelection): Promise<void> => {
    for (const candidate of selection.message ? [selection, withoutMessage(selection)] : [selection]) {
      try { await store.restoreNavigation({ selection: candidate, history: [], historyIndex: -1, composing: false, error: null }); return }
      catch (error) { if (conflict(error)) return }
    }
  }
  const focus = (tab: string): Promise<void> => enqueue(async () => { try { await focusNow(tab) } catch { /* Switching never blocks the next switch. */ } })
  const focusNow = async (tab: string): Promise<void> => {
    if (disposed) return
    if (tab === focused) { adoptUntil = 0; return }
    if (Date.now() < adoptUntil) { adopt(tab); return }
    if (focused !== null && covered) park(focused, { selection: covered.selection })
    else if (focused !== null) {
      const navigation = store.captureNavigation()
      park(focused, { selection: navigation.selection, navigation, title: store.getSnapshot().selectedMessage?.subject || undefined })
    }
    covered = null
    focused = tab
    const entry = parked.get(tab)
    parked.delete(tab)
    notify()
    if (entry?.navigation) {
      try { await store.restoreNavigation(entry.navigation) } catch (error) { if (!conflict(error)) await fresh(entry.navigation.selection) }
    } else if (entry) await fresh(entry.selection)
  }
  const offStore = store.subscribe(() => {
    if (!covered || store.getSnapshot().composing) return
    const back = covered
    covered = null
    notify()
    if (mailbox() === back.under) void enqueue(() => select(back.selection))
  })
  const off = api.subscribeState(['activePluginTab'], ({ state }) => {
    const tab = state.activePluginTab
    if (tab?.pluginId === api.pluginId) void focus(key(tab.instanceId))
  })
  const tabs: EmailTabs = {
    instance: () => focused || undefined,
    claimed: () => focused !== null,
    parked: (instanceId) => {
      const tab = key(instanceId)
      if (focused !== null && tab === focused) return covered ? { selection: covered.selection } : null
      return focused === null ? null : parked.get(tab) ?? null
    },
    restore: (selection, instanceId, background) => enqueue(async () => {
      if (disposed) return
      const tab = key(instanceId)
      const until = replaced.get(tab)
      if (background && until !== undefined) {
        replaced.delete(tab)
        if (Date.now() < until) return
      }
      if (!background && instanceId === undefined) {
        // A link or bookmark without a tab instance opens in whichever Email tab the host reveals.
        if (focused === null || activeKey() !== focused) adoptUntil = Date.now() + ADOPT_MS
        await store.restoreSelection(selection)
        return
      }
      if (Date.now() < adoptUntil) { park(tab, { selection }); notify(); return }
      if (focused === null) {
        const active = activeKey()
        if (active === null || active === tab) { focused = tab; notify() }
      }
      if (tab !== focused) { park(tab, { selection, title: parked.get(tab)?.title }); notify(); return }
      if (!background) { await store.restoreSelection(selection); return }
      await store.whenReady.catch(() => undefined)
      if (store.getSnapshot().composing && store.getSnapshot().compose?.dirty) { covered = { selection, under: mailbox() }; notify(); return }
      covered = null
      await select(selection)
    }),
    reveal: () => {
      if (disposed) return
      if (focused !== null && activeKey() === focused) return
      if (focused && api.workspace.getOpenMainTabs().includes(focused)) { api.workspace.openMainTab({ instanceId: focused }); return }
      adoptUntil = Date.now() + ADOPT_MS
      api.workspace.openMainTab()
    },
    openNew: (selection, title) => {
      if (disposed) return
      const instanceId = newInstanceId()
      park(instanceId, { selection, ...(title ? { title } : {}) })
      notify()
      api.workspace.openMainTab({ instanceId, newTab: true, ...(title ? { title } : {}) })
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => {
      disposed = true
      off()
      offStore()
      listeners.clear()
      if (current === tabs) current = null
    }
  }
  current = tabs
  return tabs
}
