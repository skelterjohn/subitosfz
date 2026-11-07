import { useState } from 'react'
import './ImportSf2Modal.css'

type Status = 'idle' | 'creating' | 'error'

interface Props {
  onClose: () => void
  // Fired with the new file's path on success - the parent opens it the
  // normal way (App.tsx's loadSfzFile), same as choosing an existing file
  // via Open.
  onCreated: (sfzPath: string) => void
}

export default function NewInstrumentModal({ onClose, onCreated }: Props): React.JSX.Element {
  const [destDir, setDestDir] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function pickDestination(): Promise<void> {
    const path = await window.api.chooseDirectory()
    if (path) setDestDir(path)
  }

  async function create(): Promise<void> {
    if (!destDir || !fileName.trim()) return
    setStatus('creating')
    setErrorMessage(null)

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destDir, fileName: fileName.trim() })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const body = (await res.json()) as { sfzPath: string }
      onCreated(body.sfzPath)
      onClose()
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal is-compact" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>new instrument</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="import-modal__body">
          <section className="import-modal__field">
            <span className="import-modal__label">folder</span>
            <div className="import-modal__row">
              <button type="button" onClick={pickDestination}>
                choose folder…
              </button>
              <span className="import-modal__path">{destDir ?? '(none selected)'}</span>
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">name</span>
            <div className="import-modal__row">
              <input
                type="text"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                placeholder="instrument name"
              />
            </div>
          </section>

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
          </div>
        </div>

        <div className="import-modal__footer">
          <button
            type="button"
            disabled={!destDir || !fileName.trim() || status === 'creating'}
            onClick={create}
          >
            {status === 'creating' ? 'creating…' : 'create'}
          </button>
        </div>
      </div>
    </div>
  )
}
