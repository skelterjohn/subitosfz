import { useEffect, useMemo, useRef, useState } from 'react'
import type { AxisValue, CellRecord } from '../model/instrument'
import { cellsOverlap, midiToName } from '../model/instrument'
import type { DrawerChunk } from '../model/drawer'
import './ImportSf2Modal.css'
import './AssignChunkModal.css'

const NEW_ARTICULATION = '__new__'

// MuseScore assigns each dynamic marking a fixed default playback velocity
// (p=49, mp=64, mf=80, f=96, from its own internal dynamics table) - these
// presets are contiguous bands centered on those values (split at the
// midpoints between neighbors, with the outer two extended to the ends of
// the 1-127 range) so every velocity MuseScore could actually emit for one
// of these four markings - including hairpin/humanize jitter around the
// nominal value - lands in exactly one band, with no silent gaps between
// layers.
const VELOCITY_PRESETS: Array<{ label: string; loVel: number; hiVel: number }> = [
  { label: 'p', loVel: 1, hiVel: 56 },
  { label: 'mp', loVel: 57, hiVel: 72 },
  { label: 'mf', loVel: 73, hiVel: 88 },
  { label: 'f', loVel: 89, hiVel: 127 }
]

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
  // Every existing cell, so a key range/velocity range/articulation combo
  // that already overlaps one can be flagged before assigning into it.
  cells: CellRecord[]
  // The cell currently shown in the sample editor panel, if any - used only
  // to prepopulate the cell-defining fields below (key range, velocity
  // range, articulation) - the audio file itself always comes from `chunk`,
  // never from here.
  selectedCell: CellRecord | null
  onClose: () => void
  onAssigned: () => void
}

export default function AssignChunkModal({
  chunk,
  sfzFilePath,
  workingSfzPath,
  existingArticulations,
  cells,
  selectedCell,
  onClose,
  onAssigned
}: Props): React.JSX.Element {
  // Prepopulated from the currently selected cell's own cell-defining
  // fields, if there is one - the common case is assigning another take
  // (e.g. a round-robin or stereo pair) into the same cell the user already
  // has open, not starting from scratch every time. Falls back to the old
  // fixed defaults (a single-key, single-velocity cell) otherwise. Read
  // once at mount (this modal remounts fresh on every open - see its
  // conditional render in App.tsx), not kept in sync afterward - it's a
  // starting point the user can still edit, not a live binding.
  const [note, setNote] = useState(() => (selectedCell ? Number(selectedCell.note) : 60))
  const [loKey, setLoKey] = useState(() => (selectedCell ? selectedCell.loKey : 60))
  const [hiKey, setHiKey] = useState(() => (selectedCell ? selectedCell.hiKey : 60))
  const [loVel, setLoVel] = useState(() => (selectedCell ? selectedCell.loVel : 100))
  const [hiVel, setHiVel] = useState(() => (selectedCell ? selectedCell.hiVel : 100))
  // Not a cell-defining field (pan isn't part of CellRecord), so there's
  // nothing sensible to prepopulate from the selected cell - always starts
  // at center, left for the user to set (e.g. when hand-building a stereo
  // pair, see the "left+center instead of left+right" pitfall this avoids
  // by at least making pan a visible field instead of silently omitted).
  const [pan, setPan] = useState(0)
  const [articulationChoice, setArticulationChoice] = useState(
    () => selectedCell?.articulation ?? existingArticulations[0]?.id ?? NEW_ARTICULATION
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

  // Widens the key range rather than leaving it stale - a pitch outside the
  // current lo/hi otherwise silently makes the cell unreachable at its own
  // assigned note, which is never what's intended.
  function handleNoteChange(value: number): void {
    setNote(value)
    if (Number.isInteger(value) && value >= 0 && value <= 127) {
      setLoKey((prev) => Math.min(prev, value))
      setHiKey((prev) => Math.max(prev, value))
    }
  }

  const isNewArticulation = articulationChoice === NEW_ARTICULATION
  const articulationId = isNewArticulation ? newArticulationId.trim() : articulationChoice
  const articulationLabel = isNewArticulation
    ? newArticulationLabel.trim() || undefined
    : existingArticulations.find((a) => a.id === articulationChoice)?.label

  const inMidiRange = (v: number): boolean => Number.isInteger(v) && v >= 0 && v <= 127
  const noteValid = inMidiRange(note)
  const keyRangeValid = inMidiRange(loKey) && inMidiRange(hiKey) && loKey <= hiKey
  const velRangeValid = inMidiRange(loVel) && inMidiRange(hiVel) && loVel <= hiVel
  const panValid = Number.isInteger(pan) && pan >= -100 && pan <= 100
  const articulationValid = articulationId.length > 0
  const canSave =
    noteValid && keyRangeValid && velRangeValid && panValid && articulationValid && status !== 'saving'

  // Shown next to the (otherwise unexplained) disabled button - MIDI values
  // only go up to 127, which isn't obvious from a bare number input with no
  // visible max, and a reversed lo/hi range would otherwise just silently
  // never match anything.
  const validationMessage = !noteValid
    ? 'pitch must be an integer from 0 to 127'
    : !keyRangeValid
      ? 'key range must be 0-127 with lo ≤ hi'
      : !velRangeValid
        ? 'velocity range must be 0-127 with lo ≤ hi'
        : !panValid
          ? 'pan must be an integer from -100 to 100'
          : !articulationValid
            ? 'enter an id for the new articulation'
            : null

  // Not blocking - overlapping regions are valid SFZ (both sound together),
  // just usually not what was intended, so this is a heads-up rather than
  // something that disables the assign button.
  const overlappingCells = useMemo(() => {
    if (!keyRangeValid || !velRangeValid || !articulationValid) return []
    const range = { loKey, hiKey, loVel, hiVel, articulation: articulationId }
    return cells.filter((c) => cellsOverlap(c, range))
  }, [cells, loKey, hiKey, loVel, hiVel, articulationId, keyRangeValid, velRangeValid, articulationValid])

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
          lokey: loKey,
          hikey: hiKey,
          lovel: loVel,
          hivel: hiVel,
          pan,
          articulationId,
          articulationLabel
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

  // Enter anywhere in the form assigns, same as clicking the button below -
  // useful when assigning several samples in a row (round-robin takes,
  // stereo pairs) and not wanting to reach for the mouse each time.
  // Disabled fields' own native behavior (nothing happens on Enter) is
  // mirrored here via the canSave guard, so this never bypasses validation.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'Enter') return
    e.preventDefault()
    if (canSave) save()
  }

  // A document-level listener, not the form's own onKeyDown below - Escape
  // needs to close deliberately even when nothing inside the modal happens
  // to be focused (e.g. right after opening), and onKeyDown only ever sees
  // events that bubble through a focused descendant. Same pattern as
  // TopMenuBar's dropdown-dismiss.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    // No onClick here - this form holds in-progress, unsaved field values
    // (it remounts fresh on every open, see the note/loKey/etc. state init
    // above), so an accidental click on the backdrop must not discard them.
    // Closing is only via the explicit × button or Escape.
    <div className="import-modal__backdrop">
      <div className="import-modal" onKeyDown={handleKeyDown}>
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
                onChange={(e) => handleNoteChange(Number(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'PageUp') {
                    e.preventDefault()
                    handleNoteChange(Math.min(127, note + 12))
                  } else if (e.key === 'PageDown') {
                    e.preventDefault()
                    handleNoteChange(Math.max(0, note - 12))
                  }
                }}
              />
              <span className="import-modal__path">{noteValid ? midiToName(note) : 'invalid'}</span>
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">key range</span>
            <div className="import-modal__row">
              <input
                type="number"
                min={0}
                max={127}
                value={loKey}
                onChange={(e) => setLoKey(Number(e.target.value))}
              />
              <span>–</span>
              <input
                type="number"
                min={0}
                max={127}
                value={hiKey}
                onChange={(e) => setHiKey(Number(e.target.value))}
              />
              <span className="import-modal__path">
                {keyRangeValid ? `${midiToName(loKey)}–${midiToName(hiKey)}` : 'invalid'}
              </span>
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
            <span className="import-modal__label">velocity range</span>
            <div className="import-modal__row">
              <input
                type="number"
                min={0}
                max={127}
                value={loVel}
                onChange={(e) => setLoVel(Number(e.target.value))}
              />
              <span>–</span>
              <input
                type="number"
                min={0}
                max={127}
                value={hiVel}
                onChange={(e) => setHiVel(Number(e.target.value))}
              />
              <div className="assign-modal__preset-group">
                {VELOCITY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={
                      preset.loVel === loVel && preset.hiVel === hiVel
                        ? 'assign-modal__preset assign-modal__preset--active'
                        : 'assign-modal__preset'
                    }
                    onClick={() => {
                      setLoVel(preset.loVel)
                      setHiVel(preset.hiVel)
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              {!velRangeValid && <span className="import-modal__path">invalid</span>}
            </div>
          </section>

          <section className="import-modal__field">
            <span className="import-modal__label">pan</span>
            <div className="import-modal__row">
              <input
                type="number"
                min={-100}
                max={100}
                value={pan}
                onChange={(e) => setPan(Number(e.target.value))}
              />
              {!panValid && <span className="import-modal__path">invalid</span>}
            </div>
          </section>

          <div className="import-modal__status">
            {status === 'error' && errorMessage && (
              <p className="import-modal__error">error: {errorMessage}</p>
            )}
            {status !== 'error' && validationMessage && (
              <p className="import-modal__error">{validationMessage}</p>
            )}
            {status !== 'error' && !validationMessage && overlappingCells.length > 0 && (
              <p className="import-modal__warning">
                overlaps {overlappingCells.length} existing cell
                {overlappingCells.length === 1 ? '' : 's'}:{' '}
                {overlappingCells
                  .map((c) => {
                    const range = c.loKey === c.hiKey ? midiToName(c.loKey) : `${midiToName(c.loKey)}–${midiToName(c.hiKey)}`
                    return `${range} (${c.loVel}-${c.hiVel}, ${c.articulation})`
                  })
                  .join(', ')}{' '}
                - both will sound together
              </p>
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
