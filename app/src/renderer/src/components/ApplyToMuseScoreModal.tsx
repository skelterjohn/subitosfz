import { useState } from 'react'
import type { AxisValue } from '../model/instrument'
import './ImportSf2Modal.css'
import './ApplyToMuseScoreModal.css'

interface MuseScoreTrack {
  partId: string
  instrumentId: string | null
  label: string
  currentSound: string
}

// kind distinguishes WHERE the mark was found - a notehead group (e.g. the
// diamond head commonly used for harmonics), an <Articulation> symbol
// (staccato, accent, up-bow, ...), or free text (a dedicated Playing
// Technique annotation, or just a plain staff text - MuseScore doesn't
// always use the dedicated element, and there's no reliable way to tell a
// real technique marking apart from an unrelated rehearsal note by tag
// alone, so every text found is listed and left for curation here).
type ArticulationKind = 'notehead' | 'symbol' | 'text'

interface ArticulationMark {
  kind: ArticulationKind
  id: string
  label: string
  count: number
}

interface MuseScoreInfo {
  formatVersion: string
  tracks: MuseScoreTrack[]
  articulations: ArticulationMark[]
}

interface ApplyResult {
  tracksApplied: number
  backupPath: string
  keyswitchSfzPath: string
}

type Status = 'idle' | 'inspecting' | 'ready' | 'applying' | 'done' | 'error'

const ARTICULATION_KIND_LABELS: Record<ArticulationKind, string> = {
  notehead: 'noteheads',
  symbol: 'articulation symbols',
  text: 'text markings'
}
const ARTICULATION_KIND_ORDER: ArticulationKind[] = ['notehead', 'symbol', 'text']
// Distinct from the empty-string "use the default" sentinel below - this
// one means "explicitly give this mark no articulation at all", not
// "inherit whatever the default is". Matches AssignChunkModal's own
// `__sentinel__` convention for values that aren't real articulation ids.
const NONE_SENTINEL = '__none__'

interface Props {
  sfzFilePath: string
  dirty: boolean
  existingArticulations: AxisValue[]
  onClose: () => void
}

export default function ApplyToMuseScoreModal({
  sfzFilePath,
  dirty,
  existingArticulations,
  onClose
}: Props): React.JSX.Element {
  const [museScorePath, setMuseScorePath] = useState<string | null>(null)
  const [info, setInfo] = useState<MuseScoreInfo | null>(null)
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set())
  // What a plain, otherwise-unmarked note gets - and also what any found
  // mark falls back to when its own mapping is left at '' ("default").
  // '' means no default is set at all (unspecified notes get nothing).
  const [defaultArticulationId, setDefaultArticulationId] = useState('')
  // Keyed by `${kind}:${id}` -> '' to inherit defaultArticulationId above,
  // NONE_SENTINEL to explicitly silence this mark instead, or a real sfz
  // articulation id to override the default just for this mark. Sent
  // as-is to /musescore/apply, which injects a hidden keyswitch note (or
  // a mute flag, for NONE_SENTINEL) per the resolved mapping.
  const [articulationMapping, setArticulationMapping] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)

  async function pickFile(): Promise<void> {
    const path = await window.api.chooseMuseScoreFile()
    if (!path) return

    setMuseScorePath(path)
    setInfo(null)
    setSelectedPartIds(new Set())
    setDefaultArticulationId('')
    setArticulationMapping({})
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
          partIds: Array.from(selectedPartIds),
          articulationMapping,
          defaultArticulationId
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
          <p className="import-modal__warning">
            Requires sfizz (VST3) already installed and registered in MuseScore&apos;s plugin list -
            this only points tracks at it, it doesn&apos;t install anything.
          </p>
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

          {info && (status === 'ready' || status === 'applying' || status === 'done') && (
            <section className="import-modal__field">
              <span className="import-modal__label">default articulation</span>
              <div className="import-modal__row">
                <select
                  value={defaultArticulationId}
                  disabled={status === 'applying' || status === 'done'}
                  onChange={(e) => setDefaultArticulationId(e.target.value)}
                >
                  <option value="">— none —</option>
                  {existingArticulations.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <span className="import-modal__path">
                  applies to any plain note, and to any mark below left at &quot;— default —&quot;
                </span>
              </div>
            </section>
          )}

          {info && (status === 'ready' || status === 'applying' || status === 'done') && (
            <section className="import-modal__field is-grow">
              <span className="import-modal__label">articulations found</span>
              {info.articulations.length === 0 && (
                <p className="import-modal__placeholder">no articulation marks found in this piece.</p>
              )}
              {info.articulations.length > 0 && (
                <div className="apply-musescore__articulation-list">
                  {ARTICULATION_KIND_ORDER.map((kind) => {
                    const marks = info.articulations.filter((m) => m.kind === kind)
                    if (marks.length === 0) return null
                    return (
                      <div key={kind} className="apply-musescore__articulation-group">
                        <div className="apply-musescore__articulation-kind">
                          {ARTICULATION_KIND_LABELS[kind]}
                        </div>
                        {marks.map((mark) => {
                          const key = `${mark.kind}:${mark.id}`
                          return (
                            <div key={key} className="apply-musescore__articulation-row">
                              <span className="apply-musescore__articulation-label">
                                {mark.label}
                                <span className="apply-musescore__articulation-count">×{mark.count}</span>
                              </span>
                              <select
                                value={articulationMapping[key] ?? ''}
                                disabled={status === 'applying' || status === 'done'}
                                onChange={(e) =>
                                  setArticulationMapping((cur) => ({ ...cur, [key]: e.target.value }))
                                }
                              >
                                <option value="">— default —</option>
                                {existingArticulations.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.label}
                                  </option>
                                ))}
                                <option value={NONE_SENTINEL}>— none —</option>
                              </select>
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status === 'done' && result && (
              <p className="import-modal__success">
                Applied sfizz + a keyswitch-enabled copy of this sfz ({result.keyswitchSfzPath}) to{' '}
                {result.tracksApplied} track{result.tracksApplied === 1 ? '' : 's'}. Backup saved at{' '}
                {result.backupPath}.
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
