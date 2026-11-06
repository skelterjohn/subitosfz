import { useState } from 'react'
import './ImportSf2Modal.css'

interface ChunkSummary {
  fileName: string
  durationSec: number
}

type Status = 'idle' | 'chunking' | 'done' | 'error'

interface Props {
  sfzFilePath: string | null
  onClose: () => void
  onImported: () => void
}

function baseNameFromPath(path: string): string {
  const fileName = path.split(/[/\\]/).pop() ?? path
  return fileName.replace(/\.wav$/i, '')
}

export default function ImportRecordingModal({ sfzFilePath, onClose, onImported }: Props): React.JSX.Element {
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [baseName, setBaseName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [chunks, setChunks] = useState<ChunkSummary[]>([])

  async function pickFile(): Promise<void> {
    const path = await window.api.chooseAudioFile()
    if (!path) return
    setSourcePath(path)
    setBaseName(baseNameFromPath(path))
    setStatus('idle')
    setErrorMessage(null)
    setChunks([])
  }

  async function runChunk(): Promise<void> {
    if (!sfzFilePath || !sourcePath || !baseName.trim()) return

    setStatus('chunking')
    setErrorMessage(null)

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/audio/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sfzPath: sfzFilePath, sourcePath, baseName: baseName.trim() })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const body = (await res.json()) as { chunks: ChunkSummary[] }
      setChunks(body.chunks)
      setStatus('done')
      onImported()
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  if (!sfzFilePath) {
    return (
      <div className="import-modal__backdrop" onClick={onClose}>
        <div className="import-modal" onClick={(e) => e.stopPropagation()}>
          <div className="import-modal__header">
            <h2>import recording</h2>
            <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
          <div className="import-modal__body">
            <p className="import-modal__placeholder">open or import an instrument first</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>import recording</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="import-modal__body">
          <section className="import-modal__field">
            <span className="import-modal__label">recording</span>
            <div className="import-modal__row">
              <button type="button" onClick={pickFile}>
                choose file…
              </button>
              <span className="import-modal__path">{sourcePath ?? '(none selected)'}</span>
            </div>
          </section>

          {sourcePath && (
            <section className="import-modal__field">
              <span className="import-modal__label">name</span>
              <div className="import-modal__row">
                <input
                  type="text"
                  value={baseName}
                  onChange={(e) => setBaseName(e.target.value)}
                  placeholder="recording name"
                />
              </div>
            </section>
          )}

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status === 'done' && (
              <p className="import-modal__success">
                found {chunks.length} chunk{chunks.length === 1 ? '' : 's'} - check the drawer to assign
                them
              </p>
            )}
          </div>
        </div>

        <div className="import-modal__footer">
          <button
            type="button"
            disabled={!sourcePath || !baseName.trim() || status === 'chunking'}
            onClick={runChunk}
          >
            {status === 'chunking' ? 'chunking…' : 'chunk'}
          </button>
        </div>
      </div>
    </div>
  )
}
