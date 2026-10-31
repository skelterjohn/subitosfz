import { useMemo, useState } from 'react'
import { axisValues, type Axis, type AxisValue, type CellRecord, type Instrument } from '../model/instrument'
import { layoutForFixed } from '../model/views'
import './InstrumentGrid.css'

const AXIS_LABEL: Record<Axis, string> = {
  note: 'note',
  articulation: 'articulation',
  velocity: 'velocity'
}

interface Props {
  instrument: Instrument
}

interface PlacedCell extends CellRecord {
  colIndex: number
  rowStart: number
  rowEnd: number
}

export default function InstrumentGrid({ instrument }: Props): React.JSX.Element {
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
  const rowValues = useMemo(() => axisValues(instrument, layout.rows), [instrument, layout.rows])
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
  function pivotRow(value: AxisValue): void {
    setFixedValues((prev) => ({ ...prev, [layout.rows]: value.id }))
    setFixedAxis(layout.rows)
  }

  function pivotCol(value: AxisValue): void {
    setFixedValues((prev) => ({ ...prev, [layout.cols]: value.id }))
    setFixedAxis(layout.cols)
  }

  const fixedLabel = fixedAxisValues.find((v) => v.id === fixedId)?.label

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    rowValues.forEach((r, i) => map.set(r.id, i))
    return map
  }, [rowValues])

  const colIndexById = useMemo(() => {
    const map = new Map<string, number>()
    colValues.forEach((c, i) => map.set(c.id, i))
    return map
  }, [colValues])

  // Only the note axis has a "range" concept to stretch across (key is a
  // continuous MIDI scale; articulation/velocity are discrete sets) - and
  // thanks to the canonical axis order, note is only ever rows, never cols,
  // whenever it's visible at all. Overlapping spans are possible (two
  // regions whose key ranges happen to cross) and are left to render in
  // arbitrary draw order, same as SFZ itself does for overlapping regions.
  const placedCells: PlacedCell[] = useMemo(() => {
    const out: PlacedCell[] = []
    for (const cell of instrument.cells) {
      if (cell[layout.fixed] !== fixedId) continue
      const colIndex = colIndexById.get(cell[layout.cols])
      if (colIndex === undefined) continue

      let rowStart: number | undefined
      let rowEnd: number | undefined
      if (layout.rows === 'note') {
        // rowValues is sorted high-to-low, so the higher key has the
        // smaller (earlier) row index.
        rowStart = rowIndexById.get(String(cell.hiKey))
        rowEnd = rowIndexById.get(String(cell.loKey))
      } else {
        const idx = rowIndexById.get(cell[layout.rows])
        rowStart = idx
        rowEnd = idx
      }
      if (rowStart === undefined || rowEnd === undefined) continue

      out.push({ ...cell, colIndex, rowStart, rowEnd })
    }
    return out
  }, [instrument.cells, layout, fixedId, rowIndexById, colIndexById])

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
            gridTemplateRows: `auto repeat(${rowValues.length}, 28px)`
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

          {rowValues.map((row, i) => (
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
          {rowValues.map((row, rowIdx) =>
            colValues.map((col, colIdx) => (
              <div
                key={`${row.id}-${col.id}`}
                className="instrument-grid__cell"
                style={{ gridColumn: colIdx + 2, gridRow: rowIdx + 2 }}
              />
            ))
          )}

          {placedCells.map((cell, i) => {
            const rowLabel =
              cell.rowStart === cell.rowEnd
                ? rowValues[cell.rowStart]?.label
                : `${rowValues[cell.rowStart]?.label}–${rowValues[cell.rowEnd]?.label}`
            return (
              <div
                key={i}
                className="instrument-grid__cell is-filled"
                style={{
                  gridColumn: cell.colIndex + 2,
                  gridRow: `${cell.rowStart + 2} / ${cell.rowEnd + 3}`
                }}
                title={`${rowLabel} / ${colValues[cell.colIndex]?.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel}`}
              >
                {cell.takeCount}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
