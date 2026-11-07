import { useState } from 'react'
import './ImportSf2Modal.css'
import './ApplyToMuseScoreModal.css'

interface MuseScoreTrack {
  partId: string
  instrumentId: string | null
  label: string
  currentSound: string
}

interface MuseScoreInfo {
  formatVersion: string
  tracks: MuseScoreTrack[]
}

interface ApplyResult {
  tracksApplied: number
  backupPath: string
}

type Status = 'idle' | 'inspecting' | 'ready' | 'applying' | 'done' | 'error'

interface Props {
  sfzFilePath: string
  dirty: boolean
  onClose: () => void
}

export default function ApplyToMuseScoreModal({ sfzFilePath, dirty, onClose }: Props): React.JSX.Element {
  const [museScorePath, setMuseScorePath] = useState<string | null>(null)
  const [info, setInfo] = useState<MuseScoreInfo | null>(null)
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)

  async function pickFile(): Promise<void> {
    const path = await window.api.chooseMuseScoreFile()
    if (!path) return

    setMuseScorePath(path)
    setInfo(null)
    setSelectedPartIds(new Set())
    setResult(null)
    setErrorMessage(null)
    setStatus('inspecting')

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/musescore/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const body = (await res.json()) as MuseScoreInfo
      setInfo(body)
      setStatus('ready')
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  function toggleTrack(partId: string): void {
    setSelectedPartIds((current) => {
      const next = new Set(current)
      if (next.has(partId)) next.delete(partId)
      else next.add(partId)
      return next
    })
  }

  async function apply(): Promise<void> {
    if (!museScorePath || selectedPartIds.size === 0) return
    setStatus('applying')
    setErrorMessage(null)
    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/musescore/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          museScorePath,
          sfzPath: sfzFilePath,
          partIds: Array.from(selectedPartIds)
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const body = (await res.json()) as ApplyResult
      setResult(body)
      setStatus('done')
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal is-compact" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>apply to musescore</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="import-modal__body">
          {dirty && (
            <p className="import-modal__warning">
              You have unsaved changes - save first so MuseScore picks up the latest version of this
              sfz.
            </p>
          )}

          <section className="import-modal__field">
            <span className="import-modal__label">musescore file</span>
            <div className="import-modal__row">
              <button type="button" onClick={pickFile} disabled={status === 'inspecting' || status === 'applying'}>
                choose file…
              </button>
              <span className="import-modal__path">{museScorePath ?? '(none selected)'}</span>
            </div>
          </section>

          {status === 'inspecting' && <p className="import-modal__placeholder">checking file…</p>}

          {info && (status === 'ready' || status === 'applying' || status === 'done') && (
            <section className="import-modal__field is-grow">
              <span className="import-modal__label">
                tracks (musescore format {info.formatVersion})
              </span>
              <div className="apply-musescore__track-list">
                {info.tracks.map((track) => (
                  <label key={track.partId} className="apply-musescore__track">
                    <input
                      type="checkbox"
                      checked={selectedPartIds.has(track.partId)}
                      disabled={status === 'applying' || status === 'done'}
                      onChange={() => toggleTrack(track.partId)}
                    />
                    <span className="apply-musescore__track-label">{track.label}</span>
                    <span className="apply-musescore__track-sound">currently: {track.currentSound}</span>
                  </label>
                ))}
              </div>
            </section>
          )}

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status === 'done' && result && (
              <p className="import-modal__success">
                Applied sfizz + this sfz to {result.tracksApplied} track
                {result.tracksApplied === 1 ? '' : 's'}. Backup saved at {result.backupPath}.
              </p>
            )}
          </div>
        </div>
        <div className="import-modal__footer">
          <button
            type="button"
            disabled={status !== 'ready' || selectedPartIds.size === 0}
            onClick={apply}
          >
            {status === 'applying' ? 'applying…' : 'apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
