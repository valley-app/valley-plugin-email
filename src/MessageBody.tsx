import { normalizeLinkPreferences, parseLinkUrl, recognizeLinkValue } from '@valley/plugin-sdk/linkTargets'
import DOMPurify from 'dompurify'
import type { EmailMessageDetail } from './mailTypes'
import { api, opensInNewTab, React } from './runtime'
import { uiText } from './localization'
import { useEmailDisplaySettings } from './hooks'

const documents = new Map<string, { document: string; blockedImages: boolean }>()

export function emailDocument(html: string, remoteImages = true): { document: string; blockedImages: boolean } {
  const key = `${remoteImages}:${html}`
  const cached = documents.get(key)
  if (cached) { documents.delete(key); documents.set(key, cached); return cached }
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true, ALLOW_UNKNOWN_PROTOCOLS: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'frame', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'base', 'link', 'audio', 'video', 'source'],
    FORBID_ATTR: ['srcset', 'ping', 'download', 'autofocus', 'contenteditable'],
    ALLOW_DATA_ATTR: false
  })
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  let blockedImages = false
  for (const image of doc.querySelectorAll('img')) {
    const src = image.getAttribute('src')?.trim() ?? ''
    const embedded = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(src)
    const remote = /^(https?:)?\/\//i.test(src)
    image.setAttribute('referrerpolicy', 'no-referrer')
    if (remote && remoteImages) {
      image.setAttribute('src', src.startsWith('//') ? `https:${src}` : src)
    } else if (!embedded) {
      image.removeAttribute('src')
      if (remote) blockedImages = true
    }
  }
  for (const link of doc.querySelectorAll('a')) {
    const href = link.getAttribute('href')?.trim() ?? ''
    link.removeAttribute('href')
    link.removeAttribute('target')
    if (parseLinkUrl(href)) {
      link.dataset.contentHref = href
      link.setAttribute('role', 'link')
      link.setAttribute('tabindex', '0')
      link.setAttribute('title', href)
    }
  }
  const policy = doc.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https: http:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`
  doc.head.prepend(policy)
  const referrer = doc.createElement('meta')
  referrer.name = 'referrer'
  referrer.content = 'no-referrer'
  doc.head.append(referrer)
  const style = doc.createElement('style')
  style.textContent = `
    html,body{height:auto!important;min-height:0!important;max-height:none!important}
    html{color-scheme:light;background:#fff;color:#202124;overflow-wrap:anywhere}
    body{display:flow-root;box-sizing:border-box;margin:0!important;padding:24px;min-width:0!important;width:auto!important;font:15px/1.6 system-ui,sans-serif}
    img{max-width:100%!important;height:auto!important;object-fit:contain}
    table{max-width:100%!important}td,th{overflow-wrap:anywhere}
    a[data-content-href]{cursor:pointer}a[data-content-href]:not([style]){color:#1769aa;text-decoration:underline}
    pre{white-space:pre-wrap;overflow-wrap:anywhere}
    @media(max-width:480px){body{padding:16px}}
  `
  doc.head.append(style)
  const result = { document: `<!doctype html>${doc.documentElement.outerHTML}`, blockedImages }
  if (html.length < 256000) {
    documents.set(key, result)
    if (documents.size > 8) documents.delete(documents.keys().next().value!)
  }
  return result
}

function PlainBody({ value }: { value: string }) {
  const [, refresh] = React.useState(0)
  React.useEffect(() => api.settings.core.subscribe(() => refresh(revision => revision + 1)), [])
  const preferences = normalizeLinkPreferences(api.settings.core.get('linkActions'))
  const parts: React.ReactNode[] = []
  let copied = 0
  for (const match of value.matchAll(/(^|[\s(])(?=[+\p{L}\d])/gu)) {
    const from = match.index! + match[0].length
    if (from < copied) continue
    const link = recognizeLinkValue(value.slice(from), api.getState().dateFormat)
    if (!link || !preferences[link.target.category].recognize) continue
    parts.push(value.slice(copied, from), <span key={from} role="link" tabIndex={0} style={{ cursor: 'pointer', textDecoration: 'underline' }}
      onClick={event => { if (!event.shiftKey && !event.altKey && event.currentTarget.ownerDocument.getSelection()?.isCollapsed !== false) void api.links.open(link.target, { newTab: opensInNewTab(event) }) }}
      onAuxClick={event => { if (event.button === 1 && !event.shiftKey && !event.altKey) { event.preventDefault(); void api.links.open(link.target, { newTab: true }) } }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.altKey) { event.preventDefault(); void api.links.open(link.target, { newTab: opensInNewTab(event) }) } }}
    >{value.slice(from, from + link.length)}</span>)
    copied = from + link.length
  }
  parts.push(value.slice(copied))
  return <>{parts}</>
}

export const MessageBody: React.FC<{ message: EmailMessageDetail; plain?: boolean; remoteImages?: boolean }> = ({ message, plain: plainOverride, remoteImages: remoteImagesOverride }) => {
  const settings = useEmailDisplaySettings(message.accountId)
  const plain = plainOverride ?? !settings.htmlContent
  const remoteImages = remoteImagesOverride ?? settings.remoteImages
  const content = React.useMemo(() => message.html && !plain ? emailDocument(message.html, remoteImages) : null, [message.html, plain, remoteImages])
  return <div className="email-body-content">
    {content && !plain && content.blockedImages && <div className="email-body-options"><span>{uiText('email.imagesBlocked')}</span></div>}
    {content && !plain ? <api.ui.HtmlContent html={content.document} title={uiText('email.htmlBody')} remoteImages={remoteImages} onLink={(url, options) => { void api.files.openExternalUrl(url, options) }} /> : <PlainBody value={message.text || message.snippet || uiText('auto.d141aa8bcb1f')} />}
  </div>
}
