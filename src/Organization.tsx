import { paletteCssValue } from '@valley/plugin-sdk/palette'
import { React, api } from './runtime'
import { useEmail } from './hooks'
import { uiText } from './localization'
import { groupingSettings, vipAddresses } from './grouping'
import type { EmailFilters, EmailMessageDetail } from './mailTypes'

export const EmailFilterControls: React.FC<{ settings?: boolean }> = ({ settings = false }) => {
  const { store, snap } = useEmail()
  const state = React.useSyncExternalStore(api.subscribe, api.getState)
  const controls: { key: keyof EmailFilters; values: string[] }[] = [
    { key: 'contact', values: ['all', 'known', 'unknown'] }, { key: 'vip', values: ['all', 'vip', 'others'] }, { key: 'spam', values: ['default', 'not-spam', 'spam', 'all'] }
  ]
  const { SelectField, Row, Button } = api.ui.settings
  const field = (title: string, control: React.ReactNode) => settings ? <Row key={title} title={title}>{control}</Row> : <div className="email-filter-row" key={title}><span>{title}</span>{control}</div>
  return <div className={`email-filter-controls${settings ? ' in-settings' : ''}`}>
    {controls.map(({ key, values }) => field(uiText(`email.filter.${key}`), <SelectField ariaLabel={uiText(`email.filter.${key}`)} value={snap.filters[key] ?? values[0]} onChange={value => store.setFilters({ ...snap.filters, [key]: value })} options={values.map(value => ({ value, label: uiText(`email.filter.${value}`) }))} />))}
    {field(uiText('email.group'), <SelectField ariaLabel={uiText('email.group')} value={snap.filters.categoryId ?? ''} onChange={value => store.setFilters({ ...snap.filters, categoryId: value || undefined })} options={[{ value: '', label: uiText('email.filter.all') }, { value: 'uncategorized', label: uiText('email.uncategorized') }, ...state.groups.map(group => ({ value: group.id, label: group.name }))]} />)}
    <Button className="email-filter-reset" variant="ghost" size="small" onClick={() => store.setFilters({})}>{uiText('email.resetFilters')}</Button>
  </div>
}

export const MessageOrganization: React.FC<{ message: EmailMessageDetail }> = ({ message }) => {
  const { store } = useEmail()
  const state = React.useSyncExternalStore(api.subscribe, api.getState)
  const vips = React.useSyncExternalStore(api.settings.subscribe, () => JSON.stringify([...vipAddresses(api)]))
  const [category, setCategory] = React.useState(message.categoryId ?? '')
  const [manual, setManual] = React.useState(false)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let active = true
    const read = () => { void api.data.dataset('assignments').get({ id: message.id }).then(row => { if (active) { setCategory(typeof row?.categoryId === 'string' ? row.categoryId : ''); setManual(row?.manual === true) } }) }
    read(); const off = api.data.dataset('assignments').subscribe(read)
    return () => { active = false; off() }
  }, [message.id])
  const sender = message.addresses.from[0]
  const starred = sender && (JSON.parse(vips) as string[]).includes(sender.address.toLowerCase())
  const run = (promise: Promise<void>) => { setError(''); void promise.catch(reason => setError(String(reason))) }
  const SelectField = api.ui.settings.SelectField
  return <div className="email-message-organization">
    {sender && <button className={`email-vip-star${starred ? ' active' : ''}`} aria-pressed={Boolean(starred)} title={uiText('email.filter.vip')} aria-label={uiText(starred ? 'email.removeVip' : 'email.addVip')} onClick={() => run(store.toggleVip(sender))}>{starred ? '★' : '☆'}</button>}
    <div className="email-category-picker"><SelectField ariaLabel={uiText('email.group')} value={category} onChange={value => run(store.assignCategory(message.id, value || null))} options={[{ value: '', label: uiText('email.uncategorized') }, ...state.groups.map(group => ({ value: group.id, label: group.name }))]} /></div>
    {manual && <button onClick={() => run(store.resetCategory(message.id))}>{uiText('email.resetAutomatic')}</button>}
    {error && <span role="alert">{error}</span>}
  </div>
}

export const ClassificationStatus: React.FC = () => {
  const { store, snap } = useEmail()
  const status = snap.classification
  if (!status.pending && !status.failed && !status.paused && !status.error) return null
  return <div className="email-classification-status" role="status">
    <span>{status.paused === 'unavailable' ? uiText('email.layaUnavailable') : status.paused === 'rate-limited' ? uiText('email.classificationThrottled') : status.error || uiText('email.classificationProgress', { pending: status.pending, completed: status.completed, failed: status.failed })}</span>
    {status.paused && <button onClick={store.retryClassification}>{uiText('email.retry')}</button>}
    {status.pending > 0 && <button onClick={() => { void store.cancelClassification() }}>{uiText('email.cancelClassification')}</button>}
  </div>
}

export const OrganizationSettings: React.FC = () => {
  const { store, snap } = useEmail()
  const state = React.useSyncExternalStore(api.subscribe, api.getState)
  const raw = React.useSyncExternalStore(api.settings.subscribe, () => JSON.stringify(groupingSettings(api)))
  const settings = React.useMemo(() => JSON.parse(raw) as ReturnType<typeof groupingSettings>, [raw])
  const [model, setModel] = React.useState('')
  const [selection, setSelection] = React.useState<string[] | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => { let active = true; void api.ai.defaults().then(defaults => { if (active) setModel(defaults.classification ? `${defaults.classification.provider} · ${defaults.classification.model}` : '') }, reason => { if (active) setError(String(reason)) }); return () => { active = false } }, [])
  const save = (patch: Partial<typeof settings>) => { void api.settings.set('grouping', { ...settings, ...patch }).catch(reason => setError(String(reason))) }
  const { Section, Row, Toggle, NumberField, TextField, Button } = api.ui.settings
  return <div className="email-organization-settings">
    <Section title={uiText('email.filters')}><EmailFilterControls settings /></Section>
    <Section title={uiText('email.groups')}>
    <p className="email-settings-hint">{uiText('email.groupDescription')}</p>
    <div className="email-classifier-default">{uiText('email.classificationProvider')}: {model || uiText('email.chooseClassifier')}</div>
    <Row title={uiText('email.automaticGrouping')}><Toggle label={uiText('email.automaticGrouping')} checked={settings.automatic} onChange={automatic => save({ automatic })} /></Row>
    <Row title={uiText('email.dailyAllowance')}><NumberField ariaLabel={uiText('email.dailyAllowance')} min={0} max={10000} step={1} value={settings.dailyLimit} onChange={value => save({ dailyLimit: value ?? 100 })} /></Row>
    {state.groups.map(group => <div className="email-category-setting" key={group.id}>
      <Row title={<span className="email-category-name"><span className="email-group-color" style={{ background: paletteCssValue(group.color) }} />{group.name}</span>}><Toggle label={group.name} checked={Object.hasOwn(settings.categories, group.id)} onChange={enabled => { const categories = { ...settings.categories }; if (enabled) categories[group.id] = group.name; else delete categories[group.id]; save({ categories }) }} /></Row>
      {Object.hasOwn(settings.categories, group.id) && <TextField ariaLabel={uiText('email.categoryDescription', { name: group.name })} value={settings.categories[group.id]} onChange={value => save({ categories: { ...settings.categories, [group.id]: value } })} />}
    </div>)}
    {!state.groups.length && <p className="email-settings-hint">{uiText('email.createSharedGroups')}</p>}
    <div className="email-organization-actions"><Button disabled={!model || !Object.keys(settings.categories).length} onClick={() => setSelection([])}>{uiText('email.classifyExisting')}</Button></div>
    {selection && <div className="email-classification-selection">
      <p>{uiText('email.selectExisting')}</p>
      <Button size="small" onClick={() => setSelection(snap.messages.slice(0, 2000).map(message => message.id))}>{uiText('email.selectLoaded')}</Button>
      <div>{snap.messages.slice(0, 2000).map(message => <label key={message.id}><input type="checkbox" checked={selection.includes(message.id)} onChange={event => setSelection(current => event.target.checked ? [...current!, message.id] : current!.filter(id => id !== message.id))} /><span>{message.subject}</span></label>)}</div>
      {snap.cursor && snap.messages.length < 2000 && <Button size="small" onClick={() => { void store.loadMore() }}>{uiText('email.loadMoreSelection')}</Button>}
      <div className="email-organization-actions"><Button variant="primary" disabled={!selection.length} onClick={() => { const ids = selection; setSelection(null); void store.classifyExisting(ids).catch(reason => setError(String(reason))) }}>{uiText('email.classifySelected', { count: selection.length })}</Button>
      <Button onClick={() => setSelection(null)}>{uiText('email.cancelClassification')}</Button></div>
    </div>}
    <ClassificationStatus />{error && <p role="alert">{error}</p>}
    </Section>
  </div>
}
