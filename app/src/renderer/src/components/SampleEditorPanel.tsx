import { useRef, useState } from 'react'
import { midiToName, type AxisValue, type CellRecord } from '../model/instrument'
import './SampleEditorPanel.css'

type SetCellOpcodes = (
  regionIndices: number[],
  opcodes: Array<{ name: string; value: string }>
) => Promise<void>

interface Props {
  cell: CellRecord | null
  existingArticulations: AxisValue[]
  onSetCellOpcodes: SetCellOpcodes
}

const NEW_ARTICULATION = '__new__'

// Right-hand companion to the grid: the grid picks *which* sound (by
// criteria), this panel shows - and now edits - the raw criteria for that
// one cell. Unlike a single opcode edit in the take list below (which only
// ever touches one region), committing a field here fans the same opcodes
// out to every region across every take in the cell at once, so editing
// a stereo pair's shared pitch moves both regions together instead of
// splitting them apart (see App.tsx's setCellOpcodes / sfz_write.rs's
// set_cell_opcodes).
export default function SampleEditorPanel({
  cell,
  existingArticulations,
  onSetCellOpcodes
}: Props): React.JSX.Element {
  if (!cell) {
    return (
      <div className="sample-editor">
        <div className="sample-editor__empty">select a cell to inspect its criteria</div>
      </div>
    )
  }

  const regionIndices = cell.samples.flatMap((take) => take.regions.map((r) => r.regionIndex))

  function setOpcodes(opcodes: Array<{ name: string; value: string }>): Promise<void> {
    return onSetCellOpcodes(regionIndices, opcodes)
  }

  return (
    <div className="sample-editor">
      <div className="sample-editor__fields">
        <PitchRow
          note={Number(cell.note)}
          onCommit={(note) => setOpcodes([{ name: 'key', value: String(note) }])}
        />
        <RangeRow
          label="pitch range"
          lo={cell.loKey}
          hi={cell.hiKey}
          min={0}
          max={127}
          format={midiToName}
          onCommit={(lo, hi) =>
            setOpcodes([
              { name: 'lokey', value: String(lo) },
              { name: 'hikey', value: String(hi) }
            ])
          }
        />
        <RangeRow
          label="volume"
          lo={cell.loVel}
          hi={cell.hiVel}
          min={0}
          max={127}
          onCommit={(lo, hi) =>
            setOpcodes([
              { name: 'lovel', value: String(lo) },
              { name: 'hivel', value: String(hi) }
            ])
          }
        />
        <ArticulationRow
          articulationId={cell.articulation}
          existingArticulations={existingArticulations}
          onCommit={(id, label) =>
            setOpcodes(
              label
                ? [
                    { name: 'sw_last', value: id },
                    { name: 'sw_label', value: label }
                  ]
                : [{ name: 'sw_last', value: id }]
            )
          }
        />
      </div>
    </div>
  )
}

interface PitchRowProps {
  note: number
  onCommit: (note: number) => Promise<void>
}

function PitchRow({ note, onCommit }: PitchRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(note))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set by Escape just before it blurs the input, so the blur handler's
  // commit is skipped instead of re-saving the value Escape just reverted.
  const cancelingRef = useRef(false)

  function start(): void {
    setDraft(String(note))
    setError(null)
    setEditing(true)
  }

  function cancel(): void {
    cancelingRef.current = true
    setDraft(String(note))
    setEditing(false)
  }

  async function commit(): Promise<void> {
    if (cancelingRef.current) {
      cancelingRef.current = false
      return
    }
    const n = Number(draft)
    if (!Number.isInteger(n) || n < 0 || n > 127) {
      setError('0-127')
      return
    }
    if (n === note) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCommit(n)
      setEditing(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const draftNote = Number(draft)
  const draftValid = Number.isInteger(draftNote) && draftNote >= 0 && draftNote <= 127

  return (
    <div className="sample-editor__row">
      <span className="sample-editor__label">pitch</span>
      {editing ? (
        <div className="sample-editor__edit">
          <input
            type="number"
            min={0}
            max={127}
            value={draft}
            disabled={saving}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur()
              } else if (e.key === 'Escape') {
                cancel()
                e.currentTarget.blur()
              }
            }}
          />
          {/* Numbers alone don't say which note they mean - this is what
              saves having to go cross-reference a keyboard chart while
              typing. */}
          <span className="sample-editor__preview">{draftValid ? midiToName(draftNote) : '?'}</span>
          {error && <span className="sample-editor__error">{error}</span>}
        </div>
      ) : (
        <span
          className="sample-editor__value sample-editor__value--editable"
          onClick={start}
          title="Click to edit"
        >
          {midiToName(note)}
        </span>
      )}
    </div>
  )
}

interface RangeRowProps {
  label: string
  lo: number
  hi: number
  min: number
  max: number
  format?: (n: number) => string
  onCommit: (lo: number, hi: number) => Promise<void>
}

// Live preview of what the in-progress lo/hi text currently means (e.g.
// "C4-E4"), independent of whether it's valid enough to commit yet - "?"
// stands in for a side that isn't a valid number right now.
function rangePreview(
  draftLo: string,
  draftHi: string,
  min: number,
  max: number,
  format: (n: number) => string
): string {
  const lo = Number(draftLo)
  const hi = Number(draftHi)
  const loValid = Number.isInteger(lo) && lo >= min && lo <= max
  const hiValid = Number.isInteger(hi) && hi >= min && hi <= max
  const loText = loValid ? format(lo) : '?'
  const hiText = hiValid ? format(hi) : '?'
  return loValid && hiValid && lo === hi ? loText : `${loText}-${hiText}`
}

function RangeRow({ label, lo, hi, min, max, format, onCommit }: RangeRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftLo, setDraftLo] = useState(String(lo))
  const [draftHi, setDraftHi] = useState(String(hi))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cancelingRef = useRef(false)

  function start(): void {
    setDraftLo(String(lo))
    setDraftHi(String(hi))
    setError(null)
    setEditing(true)
  }

  function cancel(): void {
    cancelingRef.current = true
    setDraftLo(String(lo))
    setDraftHi(String(hi))
    setEditing(false)
  }

  async function commit(): Promise<void> {
    if (cancelingRef.current) {
      cancelingRef.current = false
      return
    }
    const newLo = Number(draftLo)
    const newHi = Number(draftHi)
    if (
      !Number.isInteger(newLo) ||
      !Number.isInteger(newHi) ||
      newLo < min ||
      newHi > max ||
      newLo > newHi
    ) {
      setError(`${min}-${max}, lo ≤ hi`)
      return
    }
    if (newLo === lo && newHi === hi) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCommit(newLo, newHi)
      setEditing(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const fmt = format ?? String
  const display = lo === hi ? fmt(lo) : `${fmt(lo)}-${fmt(hi)}`

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      cancel()
      e.currentTarget.blur()
    }
  }

  return (
    <div className="sample-editor__row">
      <span className="sample-editor__label">{label}</span>
      {editing ? (
        <div
          className="sample-editor__edit"
          // Commit only once focus actually leaves BOTH inputs, not when
          // tabbing from the lo input to the hi one within the same row -
          // otherwise tabbing between them would commit a half-edited range.
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              commit()
            }
          }}
        >
          <input
            type="number"
            min={min}
            max={max}
            value={draftLo}
            disabled={saving}
            autoFocus
            onChange={(e) => setDraftLo(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span className="sample-editor__range-sep">-</span>
          <input
            type="number"
            min={min}
            max={max}
            value={draftHi}
            disabled={saving}
            onChange={(e) => setDraftHi(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          {/* Only for fields with a friendly name format (pitch range) -
              plain numeric fields like volume have nothing to preview. */}
          {format && <span className="sample-editor__preview">{rangePreview(draftLo, draftHi, min, max, format)}</span>}
          {error && <span className="sample-editor__error">{error}</span>}
        </div>
      ) : (
        <span
          className="sample-editor__value sample-editor__value--editable"
          onClick={start}
          title="Click to edit"
        >
          {display}
        </span>
      )}
    </div>
  )
}

interface ArticulationRowProps {
  articulationId: string
  existingArticulations: AxisValue[]
  onCommit: (id: string, label: string | undefined) => Promise<void>
}

function ArticulationRow({
  articulationId,
  existingArticulations,
  onCommit
}: ArticulationRowProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState(articulationId)
  const [newId, setNewId] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currentLabel = existingArticulations.find((a) => a.id === articulationId)?.label ?? articulationId
  const isNew = choice === NEW_ARTICULATION

  function start(): void {
    setChoice(articulationId)
    setNewId('')
    setNewLabel('')
    setError(null)
    setEditing(true)
  }

  function cancel(): void {
    setEditing(false)
    setError(null)
  }

  async function commit(): Promise<void> {
    const id = (isNew ? newId : choice).trim()
    if (!id) {
      setError('enter an id')
      return
    }
    if (id === articulationId && !(isNew && newLabel.trim())) {
      setEditing(false)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onCommit(id, isNew ? newLabel.trim() || undefined : undefined)
      setEditing(false)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="sample-editor__row">
        <span className="sample-editor__label">articulation</span>
        <span
          className="sample-editor__value sample-editor__value--editable"
          onClick={start}
          title="Click to edit"
        >
          {currentLabel}
        </span>
      </div>
    )
  }

  return (
    <div className="sample-editor__row sample-editor__row--editing">
      <span className="sample-editor__label">articulation</span>
      <div className="sample-editor__edit sample-editor__edit--articulation">
        <select value={choice} disabled={saving} onChange={(e) => setChoice(e.target.value)}>
          {existingArticulations.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
          <option value={NEW_ARTICULATION}>+ New…</option>
        </select>
        {isNew && (
          <>
            <input
              type="text"
              placeholder="id"
              value={newId}
              disabled={saving}
              onChange={(e) => setNewId(e.target.value)}
            />
            <input
              type="text"
              placeholder="label"
              value={newLabel}
              disabled={saving}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </>
        )}
        <button
          type="button"
          className="sample-editor__confirm"
          onClick={commit}
          disabled={saving}
          aria-label="Save"
        >
          ✓
        </button>
        <button
          type="button"
          className="sample-editor__cancel"
          onClick={cancel}
          disabled={saving}
          aria-label="Cancel"
        >
          ×
        </button>
        {error && <span className="sample-editor__error">{error}</span>}
      </div>
    </div>
  )
}
