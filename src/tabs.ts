import type { ValleyPluginApi } from '@valley/plugin-sdk'
import type { EmailNavigation } from './mailboxController'
import type { EmailSelection, EmailStore } from './store'
import { api } from './runtime'

/**
 * Email main tabs are SDK instances (`openMainTab({ instanceId })`), so the host saves and restores each tab's
 * state on its own. The store holds one live mailbox, and it always belongs to the focused tab, the Email tab the
 * user was last on. Every other tab keeps its selection and history here and gets them back when it becomes the
 * active tab again. A tab opened without an instance (an older workspace, or a plain `tab:create`) is keyed ''.
 *
 * The current draft belongs to the one tab that showed it: it moves to the focused tab when that tab opens compose, and is
 * released when that tab leaves compose (Save draft, Discard, Send, Close, opening mail). Only that tab shows it again
 * after a tab switch, a reload, a restart or reopening the tab; a released draft stays closed until Compose opens it.
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
/** Plugin setting `{ draft, tab }`: the draft id and the tab that shows it (outside the draft record, which older Email reads strictly). */
export const COMPOSE_TAB_SETTING = 'composeTab'
interface ComposeOwner { draft: number; tab: string }

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
  // A tab whose saved message is covered by its own open draft at restore time gets it back when that draft view closes.
  let covered: { selection: EmailSelection; under: string } | null = null
  let owner: ComposeOwner | null = null
  // Whether the live mailbox showed the draft when last tracked: only closing it in the owner tab releases the draft.
  let shown = false
  let ready = false
  let settling = 0
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
  const fresh = async (selection: EmailSelection, composing = false): Promise<void> => {
    for (const candidate of selection.message ? [selection, withoutMessage(selection)] : [selection]) {
      try { await store.restoreNavigation({ selection: candidate, history: [], historyIndex: -1, composing, error: null }); return }
      catch (error) { if (conflict(error)) return }
    }
  }
  const owns = (tab: string): boolean => owner?.tab === tab && store.getSnapshot().compose?.id === owner.draft
  // Follows the live mailbox outside tab switches and restores, which rewrite it on purpose.
  const track = (): void => {
    if (!ready || settling || disposed) return
    const { compose, composing } = store.getSnapshot()
    // Before any Email tab took the live mailbox, a draft opened now shows in the active Email tab.
    const here = focused ?? activeKey()
    const released = !composing && shown && focused !== null && owner?.tab === focused
    shown = composing
    const next = !compose || released ? null : composing && here !== null ? { draft: compose.id, tab: here } : owner?.draft === compose.id ? owner : null
    if (next?.tab === owner?.tab && next?.draft === owner?.draft) return
    owner = next
    void api.settings.set(COMPOSE_TAB_SETTING, next).catch(() => undefined)
  }
  const settle = async (work: () => Promise<void>): Promise<void> => {
    settling++
    try { await work() } finally { settling--; track() }
  }
  const loaded = store.whenReady.catch(() => undefined).then(() => {
    const saved = api.settings.get()[COMPOSE_TAB_SETTING] as Partial<ComposeOwner> | null | undefined
    const draft = store.getSnapshot().compose
    if (draft && saved && typeof saved.tab === 'string' && saved.draft === draft.id) owner = { draft: draft.id, tab: saved.tab }
    ready = true
    track()
  })
  const focus = (tab: string): Promise<void> => enqueue(() => settle(async () => { try { await focusNow(tab) } catch { /* Switching never blocks the next switch. */ } }))
  const focusNow = async (tab: string): Promise<void> => {
    if (disposed) return
    if (tab === focused) { adoptUntil = 0; return }
    if (Date.now() < adoptUntil) { adopt(tab); return }
    const before = focused
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
    await loaded
    const composing = owns(tab)
    if (entry?.navigation) {
      try { await store.restoreNavigation({ ...entry.navigation, composing }) } catch (error) { if (!conflict(error)) await fresh(entry.navigation.selection, composing) }
    } else if (entry) await fresh(entry.selection, composing)
    // A tab seen for the first time keeps the live mailbox; its saved state, if any, arrives through restore.
    else if (before !== null) store.setComposing(composing)
  }
  const offStore = store.subscribe(() => {
    track()
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
    restore: (selection, instanceId, background) => enqueue(() => settle(async () => {
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
      await loaded
      if (store.getSnapshot().composing && owns(tab)) { covered = { selection, under: mailbox() }; notify(); return }
      covered = null
      await select(selection)
      if (owns(tab)) store.setComposing(true)
    })),
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
