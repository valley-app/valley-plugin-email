import type { EmailDriver, EmailFilters, EmailMessageAction, EmailMessageDetail, EmailMessageRef } from './mailTypes'
import type { EmailSnapshot } from './store'
import { uiText } from './localization'

interface MessagePorts {
  snapshot(): EmailSnapshot
  active(): boolean
  activeAccountIds(): string[]
  set(patch: Partial<EmailSnapshot>): void
  report(error: unknown): void
  updateTitle(): void
  pushHistory(): void
  removeFromHistory(key: string): void
  resolveContacts(): Promise<void>
  /** The open smart group's query filter for this tab (empty when none); kept out of the saved global filters. */
  groupFilters?(): EmailFilters
}

export const messageKey = (message: EmailMessageRef): string => JSON.stringify([message.accountId, message.folder, message.uid])

/**
 * Characters of body the reader shows. The reader renders and link-scans the whole body on the plugin UI thread, and that
 * thread must keep answering the host's liveness checks; a longer body is shown up to this length with a note.
 */
export const DISPLAY_BODY_CHARACTERS = 512 * 1024

/** Fetch a body that readMessage deferred (too large for one reply, or not downloaded during sync) slice by slice. */
export async function loadDeferredBody(mail: Pick<EmailDriver, 'loadMessageContent' | 'readMessage'>, message: EmailMessageDetail, cancellation?: AbortSignal): Promise<EmailMessageDetail> {
  const ref = { accountId: message.accountId, folder: message.folder, uid: message.uid, ...(message.uidValidity === undefined ? {} : { uidValidity: message.uidValidity }) }
  const body: { text?: string; html?: string } = {}
  let budget = DISPLAY_BODY_CHARACTERS, shown = 0, available = 0
  for (const field of ['text', 'html'] as const) {
    const slices: string[] = []
    let total = 1
    for (let offset = 0; offset < total;) {
      if (budget <= 0) { const result = await mail.loadMessageContent({ ...ref, field, offset }, cancellation); total = result.ok && result.data ? result.data.total : 0; break }
      const result = await mail.loadMessageContent({ ...ref, field, offset }, cancellation)
      if (!result.ok || !result.data) throw new Error(result.error || uiText('email.body.loadFailed'))
      total = result.data.total
      if (!result.data.chunk.length) break
      const chunk = result.data.chunk.slice(0, budget)
      slices.push(chunk)
      offset += result.data.chunk.length
      budget -= chunk.length
      shown += chunk.length
    }
    available += Math.max(0, total === 1 && !slices.length ? 0 : total)
    if (slices.length) body[field] = slices.join('')
  }
  const reread = await mail.readMessage(ref, cancellation)
  const fresh = reread.ok ? reread.data?.message : null
  return { ...(fresh ?? message), ...body, bodyDeferred: false, bodyError: undefined, ...(shown < available ? { bodyTruncated: { shown, total: available } } : {}) }
}

export interface EmailActionOptions {
  /** Wait for an action already in flight instead of refusing (the automatic mark-read on open). */
  wait?: boolean
  onFailure?(outcome: 'not-applied' | 'unknown'): void
}

type FlagChange = { add?: string; remove?: string }
const FLAG_CHANGES: Partial<Record<EmailMessageAction, FlagChange>> = { 'mark-read': { add: '\\Seen' }, 'mark-unread': { remove: '\\Seen' }, flag: { add: '\\Flagged' }, unflag: { remove: '\\Flagged' } }
const changed = (flags: string[], change: FlagChange): string[] => {
  const next = flags.filter((flag) => flag !== change.remove)
  return change.add && !next.includes(change.add) ? [...next, change.add] : next
}

export function createMessageController(mail: EmailDriver, ports: MessagePorts) {
  let requestId = 0
  let messageRevision = 0
  let pendingMessages: { key: string; revision: number; token: number; promise: Promise<void> } | null = null
  let detailId = 0
  let queryCancellation: AbortController | undefined
  let detailCancellation: AbortController | undefined
  let running: Promise<boolean> | null = null
  // Read and flag changes show at once and stay shown across list reloads until the server answers.
  const pendingFlags = new Map<string, FlagChange[]>()
  const addPending = (key: string, change: FlagChange): void => { pendingFlags.set(key, [...pendingFlags.get(key) ?? [], change]) }
  const dropPending = (key: string, change: FlagChange): void => {
    const rest = (pendingFlags.get(key) ?? []).filter((entry) => entry !== change)
    if (rest.length) pendingFlags.set(key, rest); else pendingFlags.delete(key)
  }
  const pendingRead = (key: string): boolean => (pendingFlags.get(key) ?? []).some((change) => change.add === '\\Seen')
  const withPending = <T extends EmailMessageRef & { flags: string[] }>(message: T): T => {
    const changes = pendingFlags.get(messageKey(message))
    return changes ? { ...message, flags: changes.reduce(changed, message.flags) } : message
  }
  const showFlags = (key: string, change: FlagChange): void => {
    const { messages, selectedMessage } = ports.snapshot()
    const patch: Partial<EmailSnapshot> = {}
    if (messages.some((message) => messageKey(message) === key)) patch.messages = messages.map((message) => messageKey(message) === key ? { ...message, flags: changed(message.flags, change) } : message)
    if (selectedMessage && messageKey(selectedMessage) === key) patch.selectedMessage = { ...selectedMessage, flags: changed(selectedMessage.flags, change) }
    if (patch.messages || patch.selectedMessage) ports.set(patch)
  }
  const messageQuery = (append = false) => ({ accountId: ports.snapshot().selectedAccountId!, view: ports.snapshot().view, folder: ports.snapshot().selectedFolder,
    accountIds: ports.activeAccountIds(), filters: { ...ports.snapshot().filters, ...ports.groupFilters?.() }, query: ports.snapshot().query, cursor: append ? ports.snapshot().cursor : undefined })
  function loadMessages(append = false): Promise<void> {
    const accountIds = ports.activeAccountIds()
    if (!ports.active() || !ports.snapshot().selectedAccountId || !accountIds.length || (append && (!ports.snapshot().cursor || ports.snapshot().loadingMessages))) return Promise.resolve()
    const input = messageQuery(append)
    const key = JSON.stringify(input)
    if (pendingMessages?.key === key && pendingMessages.revision === messageRevision && pendingMessages.token === requestId) return pendingMessages.promise
    queryCancellation?.abort()
    const cancellation = queryCancellation = new AbortController()
    const token = ++requestId
    ports.set({ loadingMessages: true })
    const promise = read()
    pendingMessages = { key, revision: messageRevision, token, promise }
    const clear = (): void => { if (pendingMessages?.token === token) pendingMessages = null }
    void promise.then(clear, clear)
    return promise
    async function read(): Promise<void> {
      try {
        const result = await mail.queryMessages(input, cancellation.signal)
        if (token !== requestId || !ports.active()) return
        if (!result.ok || !result.data) throw new Error(result.error || uiText('email.loadFailed'))
        const messages = (append ? [...ports.snapshot().messages, ...result.data.messages.filter((message) => !ports.snapshot().messages.some((current) => current.id === message.id))] : result.data.messages).map(withPending)
        ports.set({ messages, cursor: result.data.cursor, loadingMessages: false })
        void ports.resolveContacts()
      } catch (error) {
        if (token === requestId) { ports.set({ loadingMessages: false }); ports.report(error) }
      }
    }
  }
  async function readSelected(ref: EmailMessageRef, recordHistory = true): Promise<void> {
    detailCancellation?.abort()
    const cancellation = detailCancellation = new AbortController()
    const token = ++detailId
    const summary = ports.snapshot().messages.find((message) => messageKey(message) === messageKey(ref))
    ports.set({ selectedUid: ref.uid, selectedMessage: summary ?? null, loadingMessage: true, composing: false })
    try {
      const result = await mail.readMessage(ref, cancellation.signal)
      if (token !== detailId || !ports.active()) return
      if (!result.ok) throw new Error(result.error || uiText('email.loadFailed'))
      let message = result.data?.message ?? null
      if (!message) throw new Error(uiText('email.selectionMissing'))
      if (message.bodyDeferred) {
        const retried = Boolean(message.bodyError)
        ports.set({ selectedMessage: withPending(message), selectedUid: message.uid })
        message = await loadDeferredBody(mail, message, cancellation.signal)
        if (token !== detailId || !ports.active()) return
        if (retried) { ++messageRevision; void loadMessages() }
      }
      ports.set({ selectedMessage: withPending(message), selectedUid: message?.uid ?? null, bodyOverride: null, loadingMessage: false })
      ports.updateTitle()
      if (recordHistory) ports.pushHistory()
      void ports.resolveContacts()
      if (!message.flags.includes('\\Seen') && !pendingRead(messageKey(message))) void act(message, 'mark-read', { wait: true })
    } catch (error) { if (token === detailId) { ports.set({ loadingMessage: false }); ports.report(error) } }
  }
  function openMessage(input: EmailMessageRef | null): void {
    if (!ports.active()) return
    if (input === null) { ++detailId; detailCancellation?.abort(); ports.set({ selectedMessage: null, selectedUid: null, composing: false }); ports.updateTitle(); return }
    // The first open marks an unread message read at once, also while another action is still in flight.
    const summary = ports.snapshot().messages.find((message) => messageKey(message) === messageKey(input))
    if (summary && !summary.flags.includes('\\Seen') && !pendingRead(messageKey(summary))) void act(summary, 'mark-read', { wait: true })
    void readSelected(input)
  }
  async function act(ref: EmailMessageRef, action: EmailMessageAction, options: EmailActionOptions = {}): Promise<boolean> {
    const refuse = (): false => { options.onFailure?.('not-applied'); return false }
    if (!ports.active()) return refuse()
    const key = messageKey(ref)
    const flagChange = FLAG_CHANGES[action]
    const change = flagChange && { ...flagChange }
    if (ports.snapshot().actionUid !== null) {
      if (!options.wait) return refuse()
      if (change) { addPending(key, change); showFlags(key, change) }
      while (ports.snapshot().actionUid !== null && running) await running
      if (!ports.active()) { if (change) dropPending(key, change); return refuse() }
    } else if (change) { addPending(key, change); showFlags(key, change) }
    const run = apply(ref, key, action, change, options)
    running = run
    try { return await run } finally { if (running === run) running = null }
  }
  async function apply(ref: EmailMessageRef, key: string, action: EmailMessageAction, change: FlagChange | undefined, options: EmailActionOptions): Promise<boolean> {
    const previous = ports.snapshot().selectedMessage
    const generation = detailId
    let classified = false
    ports.set({ actionUid: ref.uid, error: null })
    try {
      const result = await mail.applyMessageAction({ accountId: ref.accountId, folder: ref.folder, uid: ref.uid, uidValidity: ref.uidValidity, action })
      if (!result.ok) {
        // A refusal changed nothing and an unknown outcome is not shown as done: the row and the open message return to the cached flags.
        if (change) { dropPending(key, change); showFlags(key, { add: change.remove, remove: change.add }) }
        classified = true
        options.onFailure?.(result.outcome === 'not-applied' ? 'not-applied' : 'unknown')
        throw new Error(result.error || uiText('email.actionFailed'))
      }
      if (!ports.active()) return true
      ++messageRevision
      if (generation === detailId && previous && messageKey(previous) === key) {
        if (action === 'trash' || action === 'archive' || action === 'junk') {
          ports.set({ selectedMessage: null, selectedUid: null })
          ports.removeFromHistory(key)
        } else {
          const changed = result.data?.messages.find((message) => message.uid === ref.uid)
          if (changed) ports.set({ selectedMessage: { ...previous, ...changed } })
        }
      }
      if (ports.activeAccountIds().includes(ref.accountId)) await loadMessages()
      ports.updateTitle()
      return true
    } catch (error) { if (!classified) options.onFailure?.('unknown'); ports.report(error); return false }
    finally { if (change) dropPending(key, change); ports.set({ actionUid: null }) }
  }
  return {
    loadMessages, openMessage, act,
    invalidateDetail: () => { detailCancellation?.abort(); return ++detailId },
    invalidateSelection: () => { ++detailId; ++requestId; detailCancellation?.abort(); queryCancellation?.abort() },
    invalidateMessages: () => { ++messageRevision },
    selectionVersion: () => detailId,
    queryKey: () => JSON.stringify([messageRevision, requestId, messageQuery()])
  }
}
