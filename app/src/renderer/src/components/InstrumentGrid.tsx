import { useMemo, useState } from 'react'
import {
  axisValues,
  cellRange,
  isRangeAxis,
  midiToName,
  type Axis,
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
  selectedCell: CellRecord | null
  onSelectCell: (cell: CellRecord) => void
}

// A row or column on screen. For a range axis (note/velocity) this is a
// *compressed* range, not one per raw value - see computeRangeSegments.
interface DisplayUnit {
  id: string
  label: string
  lo?: number
  hi?: number
}

// Partitions a set of cells' ranges (on the given range axis) into the
// maximal sub-ranges where the *set* of covering cells doesn't change -
// the same idea as articulation already being one row per distinct value,
// just derived from overlap math instead of a direct opcode. Standard
// sweep-line partitioning: every range contributes a "starts here" and
// "ends just after here" breakpoint; consecutive breakpoints bound one
// segment.
function computeRangeSegments(
  cells: CellRecord[],
  axis: 'note' | 'velocity'
): Array<{ lo: number; hi: number }> {
  if (cells.length === 0) return []
  const breakpoints = new Set<number>()
  for (const c of cells) {
    const [lo, hi] = cellRange(c, axis)
    breakpoints.add(lo)
    breakpoints.add(hi + 1)
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

function formatRangeLabel(lo: number, hi: number, axis: 'note' | 'velocity'): string {
  if (axis === 'note') {
    return lo === hi ? midiToName(hi) : `${midiToName(hi)}–${midiToName(lo)}`
  }
  return lo === hi ? String(lo) : `${lo}-${hi}`
}

// Builds the units for one side of the grid (rows or cols). Note always
// reads high-to-low (keyboard convention); velocity reads low-to-high.
function computeDisplayUnits(
  axis: Axis,
  cells: CellRecord[],
  instrument: Instrument
): DisplayUnit[] {
  if (isRangeAxis(axis)) {
    const segments = computeRangeSegments(cells, axis)
    const ordered = axis === 'note' ? segments.slice().reverse() : segments
    return ordered.map((s) => ({
      id: `${s.lo}-${s.hi}`,
      label: formatRangeLabel(s.lo, s.hi, axis),
      lo: s.lo,
      hi: s.hi
    }))
  }
  return axisValues(instrument, axis).map((a) => ({ id: a.id, label: a.label }))
}

function unitMatches(cell: CellRecord, axis: Axis, unit: DisplayUnit): boolean {
  if (isRangeAxis(axis)) {
    const [lo, hi] = cellRange(cell, axis)
    return lo <= (unit.lo as number) && hi >= (unit.hi as number)
  }
  return cell.articulation === unit.id
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

export default function InstrumentGrid({
  instrument,
  selectedCell,
  onSelectCell
}: Props): React.JSX.Element {
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
  // is recomputed from the canonical axis order, not preserved from
  // before. For a compressed range unit spanning several values, pivoting
  // lands on the bottom of that range (arbitrary but predictable).
  function pivotRow(unit: DisplayUnit): void {
    const value = unit.lo !== undefined ? String(unit.lo) : unit.id
    setFixedValues((prev) => ({ ...prev, [layout.rows]: value }))
    setFixedAxis(layout.rows)
  }

  function pivotCol(unit: DisplayUnit): void {
    const value = unit.lo !== undefined ? String(unit.lo) : unit.id
    setFixedValues((prev) => ({ ...prev, [layout.cols]: value }))
    setFixedAxis(layout.cols)
  }

  const fixedLabel = fixedAxisValues.find((v) => v.id === fixedId)?.label

  // Only cells visible in the current pivot slice matter for row/column
  // computation and placement. Pivoting on a range axis (note or velocity)
  // needs containment, not exact match: a cell's own anchor note is its
  // pitch_keycenter, but it also covers neighboring keys via pitch-shift -
  // e.g. a cell anchored at F#5 can still be what plays when you pivot to
  // G5, if G5 falls inside that cell's key span. Same idea for velocity.
  const relevantCells = useMemo(() => {
    if (isRangeAxis(layout.fixed)) {
      const point = Number(fixedId)
      return instrument.cells.filter((c) => {
        const [lo, hi] = cellRange(c, layout.fixed as 'note' | 'velocity')
        return lo <= point && hi >= point
      })
    }
    return instrument.cells.filter((c) => c.articulation === fixedId)
  }, [instrument.cells, layout.fixed, fixedId])

  const displayRows = useMemo(
    () => computeDisplayUnits(layout.rows, relevantCells, instrument),
    [layout.rows, relevantCells, instrument]
  )
  const displayCols = useMemo(
    () => computeDisplayUnits(layout.cols, relevantCells, instrument),
    [layout.cols, relevantCells, instrument]
  )

  // Builds one block per (column, run-of-rows-with-the-same-match-set).
  const blocks: Block[] = useMemo(() => {
    const out: Block[] = []
    displayCols.forEach((col, colIndex) => {
      let runStart = -1
      let runMatches: CellRecord[] = []

      const flush = (endIdxExclusive: number): void => {
        if (runStart !== -1 && runMatches.length > 0) {
          out.push({ rowStart: runStart, rowEnd: endIdxExclusive - 1, colIndex, matches: runMatches })
        }
      }

      displayRows.forEach((row, rowIdx) => {
        const matches = relevantCells.filter(
          (c) => unitMatches(c, layout.rows, row) && unitMatches(c, layout.cols, col)
        )
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
  }, [displayCols, displayRows, layout, relevantCells])

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
            gridTemplateColumns: `max-content repeat(${displayCols.length}, 44px)`,
            gridTemplateRows: `auto repeat(${displayRows.length}, 28px)`
          }}
        >
          <div className="instrument-grid__corner" style={{ gridColumn: 1, gridRow: 1 }}>
            {AXIS_LABEL[layout.rows]}
          </div>

          {displayCols.map((col, i) => (
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
            displayCols.map((col, colIdx) => (
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
            const isSelected = !isOverlap && cell === selectedCell
            return (
              <div
                key={i}
                className={
                  isOverlap
                    ? 'instrument-grid__cell is-overlap'
                    : `instrument-grid__cell is-filled${isSelected ? ' is-selected' : ''}`
                }
                style={{
                  gridColumn: block.colIndex + 2,
                  gridRow: `${block.rowStart + 2} / ${block.rowEnd + 3}`
                }}
                title={
                  isOverlap
                    ? `${rowLabel} / ${displayCols[block.colIndex]?.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel} - ${block.matches.length} overlapping sounds claim this range`
                    : `${rowLabel} / ${displayCols[block.colIndex]?.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel} - anchor ${midiToName(Number(cell.note))} - click to select`
                }
                onClick={() => onSelectCell(cell)}
              >
                {isOverlap ? (
                  <span className="instrument-grid__cell-count">!</span>
                ) : (
                  <>
                    {/* Always shown, not just when note is a displayed axis:
                        a cell's anchor can differ from a pivoted note (it's
                        covering that note via pitch-shift), so this is the
                        only place that distinction is visible at all when
                        note is the fixed axis. */}
                    <span className="instrument-grid__cell-note">
                      {midiToName(Number(cell.note))}
                    </span>
                    <span className="instrument-grid__cell-count">{cell.samples.length}</span>
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
