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

  // Labels are the literal SFZ opcode names, not display-friendly
  // paraphrases. Values lead with the literal number too (what's actually in
  // the opcode), with the note name alongside only as a reading aid - not a
  // substitute for it.
  const fields: Array<[string, string]> = [
    ['pitch_keycenter', `${cell.note} (${midiToName(Number(cell.note))})`],
    ['sw_last', cell.articulation],
    ['lokey', `${cell.loKey} (${midiToName(cell.loKey)})`],
    ['hikey', `${cell.hiKey} (${midiToName(cell.hiKey)})`],
    ['lovel', String(cell.loVel)],
    ['hivel', String(cell.hiVel)]
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
