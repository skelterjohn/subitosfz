import { useMemo, useState } from 'react'
import './ImportSf2Modal.css'

interface PresetSummary {
  index: number
  name: string
  bank: number
  program: number
}

interface ExportResult {
  sfz_path: string
  sample_count: number
}

type Status = 'idle' | 'loading-presets' | 'ready' | 'exporting' | 'done' | 'error'

interface ImportOutcome {
  name: string
  success: boolean
  sampleCount?: number
  error?: string
}

interface Props {
  onClose: () => void
}

export default function ImportSf2Modal({ onClose }: Props): React.JSX.Element {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [presets, setPresets] = useState<PresetSummary[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
  const [destDir, setDestDir] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([])

  const filteredPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return presets
    return presets.filter((p) => p.name.toLowerCase().includes(q))
  }, [presets, searchQuery])

  async function pickFile(): Promise<void> {
    const path = await window.api.chooseSf2File()
    if (!path) return

    setFilePath(path)
    setPresets([])
    setSelectedIndices(new Set())
    setSearchQuery('')
    setOutcomes([])
    setStatus('loading-presets')
    setErrorMessage(null)

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sf2/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      const body = (await res.json()) as { presets: PresetSummary[] }
      setPresets(body.presets)
      setStatus('ready')
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  function togglePreset(index: number): void {
    setSelectedIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  async function pickDestination(): Promise<void> {
    const path = await window.api.chooseDirectory()
    if (path) setDestDir(path)
  }

  async function save(): Promise<void> {
    if (!filePath || selectedIndices.size === 0 || !destDir) return

    setStatus('exporting')
    setErrorMessage(null)
    setOutcomes([])

    const port = await window.api.getServerPort()
    const selected = presets.filter((p) => selectedIndices.has(p.index))
    const results: ImportOutcome[] = []

    for (const preset of selected) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/sf2/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: filePath,
            presetIndex: preset.index,
            destDir,
            instrumentName: preset.name
          })
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error ?? `request failed (${res.status})`)
        }
        const body = (await res.json()) as ExportResult
        results.push({ name: preset.name, success: true, sampleCount: body.sample_count })
      } catch (err) {
        results.push({ name: preset.name, success: false, error: String(err) })
      }
    }

    setOutcomes(results)
    setStatus('done')
    onClose()
  }

  const hasPresets = presets.length > 0
  const hasSelection = selectedIndices.size > 0
  const failedCount = outcomes.filter((o) => !o.success).length

  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>import sf2/sf3</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="import-modal__body">
          <section className="import-modal__field">
            <span className="import-modal__label">file</span>
            <div className="import-modal__row">
              {!filePath && (
                <button type="button" onClick={pickFile}>
                  choose file…
                </button>
              )}
              <span className="import-modal__path">{filePath ?? '(none selected)'}</span>
            </div>
          </section>

          <section className="import-modal__field is-grow">
            <div className="import-modal__label-row">
              <span className="import-modal__label">
                instruments {hasSelection && `(${selectedIndices.size} selected)`}
              </span>
              <input
                type="text"
                className="import-modal__search-input"
                placeholder="search instruments…"
                value={searchQuery}
                disabled={!hasPresets}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div
              className={
                hasPresets
                  ? 'import-modal__preset-list'
                  : 'import-modal__preset-list is-disabled'
              }
            >
              {status === 'loading-presets' && (
                <p className="import-modal__placeholder">reading presets…</p>
              )}
              {!hasPresets && status !== 'loading-presets' && (
                <p className="import-modal__placeholder">choose a file first</p>
              )}
              {hasPresets && filteredPresets.length === 0 && (
                <p className="import-modal__placeholder">no matches</p>
              )}
              {filteredPresets.map((p) => (
                <label key={p.index} className="import-modal__preset">
                  <input
                    type="checkbox"
                    checked={selectedIndices.has(p.index)}
                    onChange={() => togglePreset(p.index)}
                  />
                  <span className="import-modal__preset-name">{p.name}</span>
                  <span className="import-modal__preset-meta">
                    bank {p.bank} / program {p.program}
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">destination</span>
            <div className="import-modal__row">
              <button type="button" disabled={!hasSelection} onClick={pickDestination}>
                choose folder…
              </button>
              <span className="import-modal__path">{destDir ?? '(none selected)'}</span>
            </div>
          </section>

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status === 'done' && outcomes.length > 0 && (
              <div>
                <p className={failedCount > 0 ? 'import-modal__error' : 'import-modal__success'}>
                  imported {outcomes.length - failedCount} of {outcomes.length} instrument
                  {outcomes.length === 1 ? '' : 's'}
                  {failedCount > 0 && `, ${failedCount} failed`}
                </p>
                {outcomes
                  .filter((o) => !o.success)
                  .map((o) => (
                    <p key={o.name} className="import-modal__error">
                      {o.name}: {o.error}
                    </p>
                  ))}
              </div>
            )}
          </div>
        </div>

        <div className="import-modal__footer">
          <button
            type="button"
            disabled={!hasSelection || !destDir || status === 'exporting'}
            onClick={save}
          >
            {status === 'exporting' ? 'saving…' : 'save'}
          </button>
        </div>
      </div>
    </div>
  )
}
