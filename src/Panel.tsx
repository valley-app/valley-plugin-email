import { EmailFilterControls, ClassificationStatus } from './Organization'
import { React, api } from './runtime'
import type { EmailAccount, EmailMailbox } from './mailTypes'
import type { EmailMailboxView } from './mailTypes'
import { useEmail } from './hooks'
import { ErrorNotice } from './Notice'
import { Archive, ChevronDown, EyeOff, Flag, Google, Inbox, Mail, Microsoft, Plus, Reload, Search, Send, Trash, Paperclip, Filter } from './icons'
import { SwipeRow } from './SwipeRow'
import { ContactAvatar, contactName } from './People'
import { uiText } from './localization'
import { formatEmailTimestamp, messageKey } from './store'
import { useEmailDateFormat } from './hooks'

export function AccountIcon({ account }: { account: EmailAccount }): React.ReactElement {
  return account.provider === 'google' ? <Google /> : account.provider === 'microsoft' ? <Microsoft /> : <Mail />
}
export function FolderIcon({ mailbox }: { mailbox: EmailMailbox }): React.ReactElement {
  if (mailbox.specialUse === '\\Inbox' || mailbox.path.toUpperCase() === 'INBOX') return <Inbox />
  if (mailbox.specialUse === '\\Sent') return <Send />
  if (['\\Archive', '\\All'].includes(mailbox.specialUse ?? '')) return <Archive />
  if (mailbox.specialUse === '\\Trash') return <Trash />
  if (mailbox.specialUse === '\\Flagged') return <Flag />
  return <Mail />
}
export function folderLabel(mailbox: EmailMailbox): string {
  const kind = mailbox.specialUse?.replace('\\', '').toLowerCase() || (mailbox.path.toUpperCase() === 'INBOX' ? 'inbox' : '')
  return ['inbox', 'sent', 'drafts', 'archive', 'all', 'trash', 'junk', 'flagged'].includes(kind) ? uiText(`email.folder.${kind}`) : mailbox.name || mailbox.path
}

export const AccountPopover: React.FC = () => {
  const { store, snap } = useEmail()
  const selectedIds = snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map((account) => account.id)
  const allSelected = selectedIds.length === snap.accounts.length
  const selectedRows = snap.accounts.map((account) => selectedIds.includes(account.id))
  const selectionRunClass = (active: boolean, index: number): string => active
    ? ` active${!selectedRows[index - 1] ? ' selection-run-start' : ''}${!selectedRows[index + 1] ? ' selection-run-end' : ''}`
    : ''
  const toggleAccount = (accountId: string): void => {
    const next = selectedIds.includes(accountId)
      ? selectedIds.filter((id) => id !== accountId)
      : [...selectedIds, accountId]
    if (next.length) void store.selectAccounts(next)
  }
  return <div className="email-account-popover email-account-picker">
    <div className="email-account-picker-head"><span className="email-account-picker-title">{uiText('auto.225300411395')}</span>
      <button className="email-account-picker-all" disabled={allSelected} onClick={() => { void store.selectAccounts([]) }}>
        {uiText('email.selectAll')}
      </button>
    </div>
    <div className="email-account-picker-list">
    {snap.accounts.map((account, index) => {
      const active = selectedRows[index]
      return <button key={account.id} aria-pressed={active} disabled={active && selectedIds.length === 1} className={`email-account-picker-option${selectionRunClass(active, index)}`} onClick={() => { toggleAccount(account.id) }}>
      <span className="email-account-check" aria-hidden="true">{active ? '✓' : ''}</span>
      <AccountIcon account={account} /><span className="email-account-copy"><strong>{account.displayName || account.address}</strong>
      {account.displayName && <small>{account.address}</small>}</span>
      </button>
    })}</div>
  </div>
}

const smartViews: { view: EmailMailboxView; Icon: React.ComponentType }[] = [
  { view: 'recent', Icon: Mail }, { view: 'unread', Icon: EyeOff }, { view: 'flagged', Icon: Flag }
]
export const FolderPopover: React.FC<{ close(): void }> = ({ close }) => {
  const { store, snap } = useEmail()
  return <div className="email-account-popover">
    <div className="email-popover-label">{uiText('email.mailboxes')}</div>
    {smartViews.map(({ view, Icon }) => <button key={view} role="menuitemradio" aria-checked={snap.view === view}
      className={`email-account-option${snap.view === view ? ' selected' : ''}`} onClick={() => { void store.selectView(view); close() }}>
      <span className="email-account-check">{snap.view === view ? '✓' : ''}</span><Icon /><span>{uiText(`email.view.${view}`)}</span>
    </button>)}
    <div className="email-popover-separator" /><div className="email-popover-label">{uiText('auto.19adc47be34b')}</div>
    {snap.mailboxes.map((mailbox) => {
      const active = snap.view === 'folder' && snap.selectedFolder === mailbox.path
      return <button key={mailbox.path} role="menuitemradio" aria-checked={active} className={`email-account-option${active ? ' selected' : ''}`}
        onClick={() => { void store.selectFolder(mailbox.path); close() }}>
        <span className="email-account-check">{active ? '✓' : ''}</span><FolderIcon mailbox={mailbox} />
        <span className="email-row-label">{folderLabel(mailbox)}</span>{mailbox.cachedUnread > 0 && <small>{mailbox.cachedUnread}</small>}
      </button>
    })}
  </div>
}

export const MailboxControls: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { store, snap } = useEmail()
  const [expanded, setExpanded] = React.useState<'accounts' | 'folders' | 'filters' | null>(null)
  const panelId = React.useId()
  const trigger = React.useRef<HTMLButtonElement | null>(null)
  const toggle = (section: 'accounts' | 'folders' | 'filters', button: HTMLButtonElement): void => {
    trigger.current = button
    setExpanded(current => current === section ? null : section)
  }
  const close = (): void => { setExpanded(null); trigger.current?.focus() }
  const account = snap.accounts.find((candidate) => candidate.id === snap.selectedAccountId)
  const mailbox = snap.mailboxes.find((candidate) => candidate.path === snap.selectedFolder)
  const label = snap.view === 'folder' ? mailbox ? folderLabel(mailbox) : snap.selectedFolder : uiText(`email.view.${snap.view}`)
  const accountLabel = snap.selectedAccountIds.length === 0 || snap.selectedAccountIds.length === snap.accounts.length ? uiText('email.allAccounts')
    : snap.selectedAccountIds.length === 1 ? account?.displayName || account?.address
      : uiText('email.selectedAccounts', { count: snap.selectedAccountIds.length })
  return <><div className={`email-mailbox-controls${compact ? ' compact' : ''}`}>
    <button className="email-selector email-account-selector" disabled={!account} title={accountLabel || uiText('auto.73e3e6e8e067')}
      aria-label={uiText('auto.73e3e6e8e067')} aria-expanded={expanded === 'accounts'} aria-controls={panelId} onClick={(event) => {
        toggle('accounts', event.currentTarget)
      }}>{account ? <AccountIcon account={account} /> : <Mail />}<span>{accountLabel}</span><ChevronDown /></button>
    <button className="email-selector" disabled={!account} title={label} aria-label={uiText('email.mailboxes')} aria-expanded={expanded === 'folders'} aria-controls={panelId} onClick={(event) => {
      toggle('folders', event.currentTarget)
    }}>{snap.view === 'folder' && mailbox ? <FolderIcon mailbox={mailbox} /> : snap.view === 'unread' ? <EyeOff /> : snap.view === 'flagged' ? <Flag /> : <Mail />}<span>{label}</span><ChevronDown /></button>
    <button className="email-icon-btn" title={uiText('email.filters')} aria-label={uiText('email.filters')} aria-expanded={expanded === 'filters'} aria-controls={panelId} onClick={event => toggle('filters', event.currentTarget)}><Filter /></button>
    <button className="email-icon-btn email-reload" title={uiText(snap.syncing ? 'email.reloading' : 'email.reload')} aria-label={uiText('email.reload')} aria-busy={snap.syncing} disabled={!account || snap.syncing} onClick={() => { void store.sync() }}><Reload /></button>
    <button className="email-icon-btn email-compose-action" title={uiText('auto.47da6f0838f0')} aria-label={uiText('auto.47da6f0838f0')} disabled={!account} onClick={() => {
      void store.startCompose().then(() => api.workspace.openMainTab())
    }}><Plus /></button>
  </div>{expanded && <section id={panelId} className="email-inline-options" aria-label={uiText(expanded === 'accounts' ? 'auto.225300411395' : expanded === 'filters' ? 'email.filters' : 'email.mailboxes')}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return }
      if (expanded === 'filters' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      if (!options.length) return
      event.preventDefault()
      const current = options.indexOf(event.target as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      options[next].focus()
    }}>
    {expanded === 'accounts' ? <AccountPopover /> : expanded === 'filters' ? <EmailFilterControls /> : <FolderPopover close={close} />}
  </section>}<ClassificationStatus /></>
}

export const Panel: React.FC = () => {
  const { store, snap } = useEmail()
  const list = React.useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = React.useState({ top: 0, height: 720 })
  const rowHeight = 83
  React.useEffect(() => {
    const element = list.current
    const view = element?.ownerDocument.defaultView
    if (!element || !view) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      setViewport({ top: element.scrollTop, height: element.clientHeight || 720 })
    }
    const schedule = (): void => { if (!frame) frame = view.requestAnimationFrame(measure) }
    const observer = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null
    observer?.observe(element)
    element.addEventListener('scroll', schedule, { passive: true })
    measure()
    return () => { observer?.disconnect(); element.removeEventListener('scroll', schedule); if (frame) view.cancelAnimationFrame(frame) }
  }, [snap.loading, snap.selectedAccountId])
  React.useEffect(() => {
    if (list.current) list.current.scrollTop = 0
    setViewport(current => ({ ...current, top: 0 }))
  }, [snap.query, snap.view, snap.selectedFolder, snap.selectedAccountIds, snap.filters])
  const first = Math.max(0, Math.min(Math.floor(viewport.top / rowHeight) - 5, snap.messages.length - 1))
  const last = Math.min(snap.messages.length, first + Math.ceil(viewport.height / rowHeight) + 10)
  const { dateFormat, timeFormat } = useEmailDateFormat()
  const account = snap.accounts.find((candidate) => candidate.id === snap.selectedAccountId)
  const accountSelection = JSON.stringify(snap.selectedAccountIds.length ? snap.selectedAccountIds : snap.accounts.map((candidate) => candidate.id))
  React.useEffect(() => { void store.sync() }, [store, accountSelection, snap.view, snap.selectedFolder])
  return <div className="email-panel">
    <div className="panel-header"><span className="panel-title">{uiText('auto.84add5b29527')}</span></div>
    {!snap.loading && <div className="email-panel-toolbar">
      {account ? <MailboxControls compact /> : <button className="email-add-account" onClick={() => api.workspace.openOwnSettings()}><Plus />{uiText('auto.98b0ed858ae4')}</button>}
    </div>}
    <div className="panel-body email-panel-body">
      <ErrorNotice onRetry={() => { void store.refreshAccounts() }} />
      {snap.loading ? <api.ui.ContentLoader label={uiText('auto.33ce417454bf')} compact /> : account ? <>
        <div className="search-field-row">
          <label className="email-search search-field"><Search className="search-field-icon" /><input className="search-field-input" value={snap.query} aria-label={uiText('email.search')} onChange={(event) => store.setQuery(event.target.value)} placeholder={uiText('email.search')} /></label>
        </div>
        <div className="email-list-status"><span>{uiText('email.cachedMail')}</span><span>{snap.loadingMessages ? uiText('auto.33ce417454bf') : `${snap.messages.length}${snap.cursor ? '+' : ''}`}</span></div>
        <div ref={list} className="email-message-list" aria-busy={snap.loadingMessages}>
          {!snap.loadingMessages && !snap.messages.length && (snap.syncing ? <api.ui.ContentLoader label={uiText('auto.33ce417454bf')} compact /> : <div className="email-empty">{uiText('auto.34e618e62f74')}</div>)}
          {first > 0 && <div aria-hidden="true" style={{ height: first * rowHeight }} />}
          {snap.messages.slice(first, last).map((message) => {
            const messageAccount = snap.accounts.find((candidate) => candidate.id === message.accountId)
            const fromOwn = message.addresses.from.some((entry) => entry.address.toLowerCase() === messageAccount?.address.toLowerCase())
            const person = (fromOwn ? message.addresses.to : message.addresses.from)[0]
            const sender = person ? contactName(person, snap.contacts) : message.from || message.to
            const selected = snap.selectedMessage && messageKey(snap.selectedMessage) === messageKey(message)
            return <SwipeRow key={message.id} message={message} className={selected ? 'active' : ''} onOpen={(event) => {
              store.openMessage(message)
              api.workspace.openMainTab({ newTab: api.ui.hasModKey(event) })
            }}>
              <div className={`email-message-row${message.flags.includes('\\Seen') ? '' : ' unread'}`}>
                <span className={`email-message-avatar${message.flags.includes('\\Seen') ? '' : ' unread'}`}><ContactAvatar address={person} label={sender} contacts={snap.contacts} /></span>
                <div className="email-message-copy">
                  <div className="email-message-top"><strong title={person?.address || message.from}>{sender}</strong><time title={formatEmailTimestamp(message.date, dateFormat, timeFormat, api.ui.language(), true)}>{formatEmailTimestamp(message.date, dateFormat, timeFormat, api.ui.language())}</time></div>
                  <div className="email-message-subject">{message.subject || uiText('email.noSubject')}</div>
                  <div className="email-message-snippet">{message.snippet}</div>
                </div>
                <span className="email-message-badges">{message.flags.includes('\\Flagged') && <Flag filled />}{message.hasAttachments && <Paperclip />}</span>
              </div>
            </SwipeRow>
          })}
          {last < snap.messages.length && <div aria-hidden="true" style={{ height: (snap.messages.length - last) * rowHeight }} />}
          {snap.cursor && <button className="email-load-more" disabled={snap.loadingMessages} onClick={() => { void store.loadMore() }}>{uiText('email.loadMore')}</button>}
        </div>
      </> : null}
    </div>
  </div>
}
