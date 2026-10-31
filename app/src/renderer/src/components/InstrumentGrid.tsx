import { useMemo, useState } from 'react'
import {
  axisValues,
  midiToName,
  type Axis,
  type AxisValue,
  type CellRecord,
  type Instrument
} from '../model/instrument'
import { layoutForFixed } from '../model/views'
import './InstrumentGrid.css'

const AXIS_LABEL: Record<Axis, string> = {
  note: 'note',
  articulation: 'articulation',
  velocity: 'velocity'
}

interface Props {
  instrument: Instrument
  onPlayCell: (cell: CellRecord) => void
}

// A row on screen. For the note axis this is a *compressed* key range, not
// one row per semitone - see computeNoteSegments.
interface DisplayRow {
  id: string
  label: string
  loKey?: number
  hiKey?: number
}

// Partitions a set of cells' [loKey, hiKey] ranges into the maximal
// sub-ranges where the *set* of covering cells doesn't change - the same
// idea as the velocity axis already being one row per distinct lovel/hivel
// bucket, just computed (velocity buckets are opcodes; key coverage has to
// be derived from overlapping ranges). Standard sweep-line partitioning:
// every range contributes a "starts here" and "ends just after here"
// breakpoint, and consecutive breakpoints bound one segment.
function computeNoteSegments(cells: CellRecord[]): Array<{ lo: number; hi: number }> {
  if (cells.length === 0) return []
  const breakpoints = new Set<number>()
  for (const c of cells) {
    breakpoints.add(c.loKey)
    breakpoints.add(c.hiKey + 1)
  }
  const sorted = Array.from(breakpoints).sort((a, b) => a - b)
  const segments: Array<{ lo: number; hi: number }> = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i]
    const hi = sorted[i + 1] - 1
    if (hi >= lo) segments.push({ lo, hi })
  }
  return segments
}

// One visual block: a run of consecutive rows, within one column, where the
// set of matching cells is constant. 0 matches never gets a block (the
// background layer already covers that). 1 match is a normal filled cell.
// 2+ matches means two or more cells both claim this span - a genuine
// ambiguity (SFZ would play all of them at once - see the overlap
// discussion), flagged in red rather than picking one arbitrarily.
interface Block {
  rowStart: number
  rowEnd: number
  colIndex: number
  matches: CellRecord[]
}

export default function InstrumentGrid({ instrument, onPlayCell }: Props): React.JSX.Element {
  // The layout (which axis is rows/cols/fixed) is entirely derived from
  // which axis is currently pinned - see layoutForFixed - so there's no
  // path-dependent state to get out of sync with the canonical axis order.
  const [fixedAxis, setFixedAxis] = useState<Axis>('velocity')
  const [fixedValues, setFixedValues] = useState<Record<Axis, string>>(() => ({
    note: axisValues(instrument, 'note')[0]?.id ?? '',
    articulation: axisValues(instrument, 'articulation')[0]?.id ?? '',
    velocity: axisValues(instrument, 'velocity')[0]?.id ?? ''
  }))

  const layout = useMemo(() => layoutForFixed(fixedAxis), [fixedAxis])
  const colValues = useMemo(() => axisValues(instrument, layout.cols), [instrument, layout.cols])
  const fixedAxisValues = useMemo(
    () => axisValues(instrument, layout.fixed),
    [instrument, layout.fixed]
  )
  const fixedId = fixedValues[layout.fixed]

  function setFixedValue(id: string): void {
    setFixedValues((prev) => ({ ...prev, [layout.fixed]: id }))
  }

  // Clicking a row/column header pivots: its axis becomes the new fixed
  // axis, pinned to the clicked value. The resulting rows/cols assignment
  // is recomputed from the canonical axis order, not preserved from before.
  // For a compressed note row spanning several keys, pivoting lands on the
  // bottom of that range (arbitrary but predictable).
  function pivotRow(row: DisplayRow): void {
    const value = row.loKey !== undefined ? String(row.loKey) : row.id
    setFixedValues((prev) => ({ ...prev, [layout.rows]: value }))
    setFixedAxis(layout.rows)
  }

  function pivotCol(value: AxisValue): void {
    setFixedValues((prev) => ({ ...prev, [layout.cols]: value.id }))
    setFixedAxis(layout.cols)
  }

  const fixedLabel = fixedAxisValues.find((v) => v.id === fixedId)?.label

  // Only cells visible in the current pivot slice matter for row
  // computation and placement.
  const relevantCells = useMemo(
    () => instrument.cells.filter((c) => c[layout.fixed] === fixedId),
    [instrument.cells, layout.fixed, fixedId]
  )

  const displayRows: DisplayRow[] = useMemo(() => {
    if (layout.rows === 'note') {
      return computeNoteSegments(relevantCells)
        .reverse() // high to low, so the grid reads top-to-bottom like a keyboard
        .map((s) => ({
          id: `${s.lo}-${s.hi}`,
          label: s.lo === s.hi ? midiToName(s.hi) : `${midiToName(s.hi)}–${midiToName(s.lo)}`,
          loKey: s.lo,
          hiKey: s.hi
        }))
    }
    return axisValues(instrument, layout.rows)
  }, [instrument, layout.rows, relevantCells])

  // Builds one block per (column, run-of-rows-with-the-same-match-set).
  // Outside the note axis this always degenerates to single-row blocks of
  // 0 or 1 match, since note/articulation/velocity are grouped by exact id
  // already - overlap can only arise from key-range math.
  const blocks: Block[] = useMemo(() => {
    const out: Block[] = []
    colValues.forEach((col, colIndex) => {
      let runStart = -1
      let runMatches: CellRecord[] = []

      const flush = (endIdxExclusive: number): void => {
        if (runStart !== -1 && runMatches.length > 0) {
          out.push({ rowStart: runStart, rowEnd: endIdxExclusive - 1, colIndex, matches: runMatches })
        }
      }

      displayRows.forEach((row, rowIdx) => {
        const matches =
          layout.rows === 'note'
            ? relevantCells.filter(
                (c) =>
                  c[layout.cols] === col.id &&
                  c.loKey <= (row.loKey as number) &&
                  c.hiKey >= (row.hiKey as number)
              )
            : relevantCells.filter((c) => c[layout.rows] === row.id && c[layout.cols] === col.id)

        const sameAsRun =
          runMatches.length === matches.length && runMatches.every((m, i) => m === matches[i])
        if (!sameAsRun) {
          flush(rowIdx)
          runStart = rowIdx
          runMatches = matches
        }
      })
      flush(displayRows.length)
    })
    return out
  }, [colValues, displayRows, layout, relevantCells])

  const isEmpty =
    instrument.noteAxis.length === 0 &&
    instrument.articulationAxis.length === 0 &&
    instrument.velocityAxis.length === 0

  if (isEmpty) {
    return (
      <div className="instrument-grid">
        <div className="instrument-grid__empty">
          no instrument loaded - click open to choose an .sfz file
        </div>
      </div>
    )
  }

  return (
    <div className="instrument-grid">
      <div className="instrument-grid__toolbar">
        <span className="instrument-grid__pivot-label">
          pivot: {AXIS_LABEL[layout.fixed]}{' '}
          <select
            className="instrument-grid__pivot-select"
            value={fixedId}
            onChange={(e) => setFixedValue(e.target.value)}
          >
            {fixedAxisValues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </span>
      </div>

      <div className="instrument-grid__scroll">
        <div
          className="instrument-grid__spangrid"
          style={{
            gridTemplateColumns: `max-content repeat(${colValues.length}, 44px)`,
            gridTemplateRows: `auto repeat(${displayRows.length}, 28px)`
          }}
        >
          <div className="instrument-grid__corner" style={{ gridColumn: 1, gridRow: 1 }}>
            {AXIS_LABEL[layout.rows]}
          </div>

          {colValues.map((col, i) => (
            <div
              key={col.id}
              className="instrument-grid__col-header"
              style={{ gridColumn: i + 2, gridRow: 1 }}
              onClick={() => pivotCol(col)}
              title={`Pivot: ${AXIS_LABEL[layout.cols]} [${col.label}]`}
            >
              {col.label}
            </div>
          ))}

          {displayRows.map((row, i) => (
            <div
              key={row.id}
              className="instrument-grid__row-header"
              style={{ gridColumn: 1, gridRow: i + 2 }}
              onClick={() => pivotRow(row)}
              title={`Pivot: ${AXIS_LABEL[layout.rows]} [${row.label}]`}
            >
              {row.label}
            </div>
          ))}

          {/* Base background layer so gaps stay visible even with no data there. */}
          {displayRows.map((row, rowIdx) =>
            colValues.map((col, colIdx) => (
              <div
                key={`${row.id}-${col.id}`}
                className="instrument-grid__cell"
                style={{ gridColumn: colIdx + 2, gridRow: rowIdx + 2 }}
              />
            ))
          )}

          {blocks.map((block, i) => {
            const rowLabel =
              block.rowStart === block.rowEnd
                ? displayRows[block.rowStart]?.label
                : `${displayRows[block.rowStart]?.label}–${displayRows[block.rowEnd]?.label}`
            const isOverlap = block.matches.length > 1
            const cell = block.matches[0]
            return (
              <div
                key={i}
                className={
                  isOverlap
                    ? 'instrument-grid__cell is-overlap'
                    : 'instrument-grid__cell is-filled'
                }
                style={{
                  gridColumn: block.colIndex + 2,
                  gridRow: `${block.rowStart + 2} / ${block.rowEnd + 3}`
                }}
                title={
                  isOverlap
                    ? `${rowLabel} / ${colValues[block.colIndex]?.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel} - ${block.matches.length} overlapping sounds claim this range`
                    : `${rowLabel} / ${colValues[block.colIndex]?.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel} - click to play`
                }
                onClick={() => onPlayCell(cell)}
              >
                {isOverlap ? (
                  <span className="instrument-grid__cell-count">!</span>
                ) : (
                  <>
                    {layout.rows === 'note' && (
                      <span className="instrument-grid__cell-note">
                        {midiToName(Number(cell.note))}
                      </span>
                    )}
                    <span className="instrument-grid__cell-count">{cell.takeCount}</span>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
