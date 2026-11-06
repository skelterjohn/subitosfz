import { useEffect, useRef, useState } from 'react'
import type { AxisValue } from '../model/instrument'
import { midiToName } from '../model/instrument'
import type { DrawerChunk } from '../model/drawer'
import './ImportSf2Modal.css'
import './AssignChunkModal.css'

const NEW_ARTICULATION = '__new__'

type Status = 'idle' | 'saving' | 'error'

interface Props {
  chunk: DrawerChunk
  // The real, opened file's path - used to resolve where sample files
  // actually live (both for this component's own playback preview and for
  // the backend's sample= existence check), never written to directly.
  sfzFilePath: string
  // Where the add-region edit actually lands - an app-specific temp copy,
  // never the real file (see App.tsx's workingPath).
  workingSfzPath: string
  existingArticulations: AxisValue[]
  onClose: () => void
  onAssigned: () => void
}

export default function AssignChunkModal({
  chunk,
  sfzFilePath,
  workingSfzPath,
  existingArticulations,
  onClose,
  onAssigned
}: Props): React.JSX.Element {
  const [note, setNote] = useState(60)
  const [velocity, setVelocity] = useState(100)
  const [articulationChoice, setArticulationChoice] = useState(
    existingArticulations[0]?.id ?? NEW_ARTICULATION
  )
  const [newArticulationId, setNewArticulationId] = useState('')
  const [newArticulationLabel, setNewArticulationLabel] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [playbackReady, setPlaybackReady] = useState(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const bufferRef = useRef<AudioBuffer | null>(null)

  // Same one-shot decode-and-play as the drawer's own preview button - this
  // is still just a flat, unassigned sample, so no envelope/loop/pan to
  // apply yet.
  useEffect(() => {
    const ctx = new AudioContext()
    audioCtxRef.current = ctx
    let cancelled = false

    ;(async () => {
      try {
        const bytes = await window.api.readAudioFile(sfzFilePath, chunk.fileName)
        const arrayBuffer = bytes.slice().buffer as ArrayBuffer
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
        if (cancelled) return
        bufferRef.current = audioBuffer
        setPlaybackReady(true)
      } catch {
        // Leave playbackReady false - the play button just stays disabled.
      }
    })()

    return () => {
      cancelled = true
      ctx.close()
      audioCtxRef.current = null
    }
  }, [sfzFilePath, chunk.fileName])

  function play(): void {
    const ctx = audioCtxRef.current
    const buffer = bufferRef.current
    if (!ctx || !buffer) return
    ctx.resume()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
  }

  const isNewArticulation = articulationChoice === NEW_ARTICULATION
  const articulationId = isNewArticulation ? newArticulationId.trim() : articulationChoice
  const articulationLabel = isNewArticulation
    ? newArticulationLabel.trim() || undefined
    : existingArticulations.find((a) => a.id === articulationChoice)?.label

  const noteValid = Number.isInteger(note) && note >= 0 && note <= 127
  const velocityValid = Number.isInteger(velocity) && velocity >= 0 && velocity <= 127
  const articulationValid = articulationId.length > 0
  const canSave = noteValid && velocityValid && articulationValid && status !== 'saving'

  // Shown next to the (otherwise unexplained) disabled button - MIDI
  // pitch/velocity only go up to 127, which isn't obvious from a bare
  // number input with no visible max.
  const validationMessage = !noteValid
    ? 'pitch must be an integer from 0 to 127'
    : !velocityValid
      ? 'velocity must be an integer from 0 to 127'
      : !articulationValid
        ? 'enter an id for the new articulation'
        : null

  async function save(): Promise<void> {
    if (!canSave) return
    setStatus('saving')
    setErrorMessage(null)

    try {
      const port = await window.api.getServerPort()
      const res = await fetch(`http://127.0.0.1:${port}/sfz/add-region`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingSfzPath,
          originalSfzPath: sfzFilePath,
          samplePath: chunk.fileName,
          note,
          articulationId,
          articulationLabel,
          velocity
        })
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `request failed (${res.status})`)
      }
      onAssigned()
      onClose()
    } catch (err) {
      setErrorMessage(String(err))
      setStatus('error')
    }
  }

  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>assign sample</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="import-modal__body">
          <section className="import-modal__field">
            <span className="import-modal__label">sample</span>
            <div className="import-modal__row">
              <button
                type="button"
                className="assign-modal__play"
                onClick={play}
                disabled={!playbackReady}
                aria-label="Play this sample"
              >
                ▶
              </button>
              <span className="import-modal__path">{chunk.fileName}</span>
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">pitch</span>
            <div className="import-modal__row">
              <input
                type="number"
                min={0}
                max={127}
                value={note}
                onChange={(e) => setNote(Number(e.target.value))}
              />
              <span className="import-modal__path">{noteValid ? midiToName(note) : 'invalid'}</span>
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">articulation</span>
            <div className="import-modal__row">
              <select
                value={articulationChoice}
                onChange={(e) => setArticulationChoice(e.target.value)}
              >
                {existingArticulations.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
                <option value={NEW_ARTICULATION}>+ New…</option>
              </select>
            </div>
            {isNewArticulation && (
              <div className="import-modal__row">
                <input
                  type="text"
                  placeholder="id (e.g. pizzicato)"
                  value={newArticulationId}
                  onChange={(e) => setNewArticulationId(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="label (optional)"
                  value={newArticulationLabel}
                  onChange={(e) => setNewArticulationLabel(e.target.value)}
                />
              </div>
            )}
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">velocity</span>
            <div className="import-modal__row">
              <input
                type="number"
                min={0}
                max={127}
                value={velocity}
                onChange={(e) => setVelocity(Number(e.target.value))}
              />
              {!velocityValid && <span className="import-modal__path">invalid</span>}
            </div>
          </section>

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status !== 'error' && validationMessage && (
              <p className="import-modal__error">{validationMessage}</p>
            )}
          </div>
        </div>

        <div className="import-modal__footer">
          <button type="button" disabled={!canSave} onClick={save}>
            {status === 'saving' ? 'assigning…' : 'assign'}
          </button>
        </div>
      </div>
    </div>
  )
}
