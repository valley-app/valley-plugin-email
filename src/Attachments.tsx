import type { EmailAttachment, EmailDriver, EmailMessageDetail, EmailMessageRef } from './mailTypes'
import { mailApi } from './mailApi'
import { Paperclip } from './icons'
import { uiText } from './localization'
import { api, React } from './runtime'

/** Largest attachment the reader saves: one plugin UI call carries at most 8 MiB. */
export const SAVE_ATTACHMENT_BYTES = 7 * 1024 * 1024

export const formatAttachmentSize = (bytes: number): string => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function quotedPrintable(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  let length = 0
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 61) { out[length++] = bytes[index]; continue }
    const hex = String.fromCharCode(bytes[index + 1] ?? 0, bytes[index + 2] ?? 0)
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) { out[length++] = parseInt(hex, 16); index += 2 }
    else if (bytes[index + 1] === 13 && bytes[index + 2] === 10) index += 2
    else if (bytes[index + 1] === 10) index += 1
    else out[length++] = 61
  }
  return out.slice(0, length)
}

/** Fetch one attachment slice by slice from the server and undo its transfer encoding. */
export async function attachmentBytes(mail: Pick<EmailDriver, 'readAttachment'>, ref: EmailMessageRef, index: number): Promise<{ filename: string; bytes: Uint8Array }> {
  const slices: Uint8Array[] = []
  let filename = '', encoding = '7bit', size = 0
  for (let offset = 0, total = 1; offset < total;) {
    const result = await mail.readAttachment({ accountId: ref.accountId, folder: ref.folder, uid: ref.uid, ...(ref.uidValidity === undefined ? {} : { uidValidity: ref.uidValidity }), index, offset })
    if (!result.ok || !result.data) throw new Error(result.error || uiText('email.attachment.saveFailed'))
    ;({ filename, encoding } = result.data)
    total = result.data.encodedSize
    const slice = base64Bytes(result.data.data)
    if (!slice.length) break
    slices.push(slice)
    offset += slice.length
    size += slice.length
  }
  const encoded = new Uint8Array(size)
  slices.reduce((position, slice) => { encoded.set(slice, position); return position + slice.length }, 0)
  if (encoding.toLowerCase() === 'base64') {
    let text = ''
    for (let index = 0; index < encoded.length; index += 32768) text += String.fromCharCode(...encoded.subarray(index, index + 32768))
    return { filename, bytes: base64Bytes(text.replace(/[^A-Za-z0-9+/=]/g, '')) }
  }
  return { filename, bytes: encoding.toLowerCase() === 'quoted-printable' ? quotedPrintable(encoded) : encoded }
}

/** Note above a body the reader shows only in part. */
export const BodyNote: React.FC<{ message: EmailMessageDetail }> = ({ message }) => {
  if (!message.bodyTruncated) return null
  const megabytes = (characters: number): string => (characters / 1024 / 1024).toFixed(1)
  return <div className="email-attachments email-body-note" role="note">{uiText('email.body.truncated', { shown: megabytes(message.bodyTruncated.shown), total: megabytes(message.bodyTruncated.total) })}</div>
}

export const Attachments: React.FC<{ message: EmailMessageDetail }> = ({ message }) => {
  const [busy, setBusy] = React.useState<number | null>(null)
  const [status, setStatus] = React.useState<{ key: string; text: string } | null>(null)
  const key = JSON.stringify([message.accountId, message.folder, message.uid])
  if (!message.attachments?.length) return null
  const save = async (attachment: EmailAttachment): Promise<void> => {
    setBusy(attachment.index); setStatus(null)
    try {
      const { filename, bytes } = await attachmentBytes(mailApi(api), message, attachment.index)
      // The host writes text or bytes; the SDK declares only text.
      const path = await (api.files.downloadFile as (name: string, content: string | Uint8Array) => Promise<string | null>)(filename || attachment.filename, bytes)
      setStatus({ key, text: path ? uiText('email.attachment.saved', { path }) : uiText('email.attachment.saveFailed') })
    } catch (error) {
      setStatus({ key, text: error instanceof Error && error.message ? error.message : uiText('email.attachment.saveFailed') })
    } finally { setBusy(null) }
  }
  return <div className="email-attachments" role="group" aria-label={uiText('email.attachments')}>
    {message.attachments.map((attachment) => {
      const tooLarge = attachment.size > SAVE_ATTACHMENT_BYTES
      const label = tooLarge ? uiText('email.attachment.tooLarge', { size: SAVE_ATTACHMENT_BYTES / 1024 / 1024 }) : uiText('email.attachment.save', { name: attachment.filename })
      return <button key={attachment.index} type="button" className="email-attachment" disabled={busy !== null || tooLarge} aria-busy={busy === attachment.index} title={label} aria-label={label} onClick={() => { void save(attachment) }}>
        <Paperclip /><span className="email-attachment-name">{attachment.filename}</span><small>{formatAttachmentSize(attachment.size)}</small>
      </button>
    })}
    {status?.key === key && <span className="email-attachment-status" role="status">{status.text}</span>}
  </div>
}
