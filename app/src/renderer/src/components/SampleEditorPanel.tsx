import { midiToName, type CellRecord } from '../model/instrument'
import './SampleEditorPanel.css'

interface Props {
  cell: CellRecord | null
}

// Right-hand companion to the grid: the grid picks *which* sound (by
// criteria), this panel shows the raw criteria for that one cell. The
// actual samples (and playback) live in the take list below the grid -
// this is deliberately just the selection criteria, not a count or a
// representative path that would duplicate what's shown there.
export default function SampleEditorPanel({ cell }: Props): React.JSX.Element {
  if (!cell) {
    return (
      <div className="sample-editor">
        <div className="sample-editor__empty">select a cell to inspect its criteria</div>
      </div>
    )
  }

  // Friendly labels/values here, not literal opcode names or MIDI numbers -
  // the raw opcodes (pitch_keycenter, lokey, hikey, lovel, hivel, sw_last,
  // and everything else) are already available verbatim per-take below, so
  // this panel can read like a summary instead of a second copy of that.
  const pitchRange =
    cell.loKey === cell.hiKey
      ? midiToName(cell.loKey)
      : `${midiToName(cell.loKey)}-${midiToName(cell.hiKey)}`
  const volumeRange = cell.loVel === cell.hiVel ? String(cell.loVel) : `${cell.loVel}-${cell.hiVel}`

  const fields: Array<[string, string]> = [
    ['pitch', midiToName(Number(cell.note))],
    ['pitch range', pitchRange],
    ['volume', volumeRange],
    ['articulation', cell.articulation]
  ]

  return (
    <div className="sample-editor">
      <div className="sample-editor__fields">
        {fields.map(([label, value]) => (
          <div className="sample-editor__row" key={label}>
            <span className="sample-editor__label">{label}</span>
            <span className="sample-editor__value" title={value}>
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
