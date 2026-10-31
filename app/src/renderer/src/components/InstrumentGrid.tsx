import { useMemo, useState } from 'react'
import {
  axisValues,
  cellKey,
  seedDemoCells,
  type Axis,
  type AxisValue,
  type CellStore
} from '../model/instrument'
import { layoutForFixed, resolveCoordinate } from '../model/views'
import './InstrumentGrid.css'

const AXIS_LABEL: Record<Axis, string> = {
  note: 'note',
  articulation: 'articulation',
  velocity: 'velocity'
}

export default function InstrumentGrid(): React.JSX.Element {
  // The layout (which axis is rows/cols/fixed) is entirely derived from
  // which axis is currently pinned - see layoutForFixed - so there's no
  // path-dependent state to get out of sync with the canonical axis order.
  const [fixedAxis, setFixedAxis] = useState<Axis>('velocity')
  const [fixedValues, setFixedValues] = useState<Record<Axis, string>>(() => ({
    note: axisValues('note')[0].id,
    articulation: axisValues('articulation')[0].id,
    velocity: axisValues('velocity')[0].id
  }))
  const [cells, setCells] = useState<CellStore>(() => seedDemoCells())

  const layout = useMemo(() => layoutForFixed(fixedAxis), [fixedAxis])
  const rowValues = useMemo(() => axisValues(layout.rows), [layout.rows])
  const colValues = useMemo(() => axisValues(layout.cols), [layout.cols])
  const fixedAxisValues = useMemo(() => axisValues(layout.fixed), [layout.fixed])
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

  // Placeholder interaction until real recording is wired up: clicking a
  // cell just cycles its take count, so the grid is visibly interactive.
  function clickCell(rowId: string, colId: string): void {
    const coord = resolveCoordinate(layout, rowId, colId, fixedId)
    const key = cellKey(coord)
    setCells((prev) => {
      const next = new Map(prev)
      const current = next.get(key)?.takeCount ?? 0
      const takeCount = (current + 1) % 4
      if (takeCount === 0) {
        next.delete(key)
      } else {
        next.set(key, { takeCount })
      }
      return next
    })
  }

  const fixedLabel = fixedAxisValues.find((v) => v.id === fixedId)?.label

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
        <table className="instrument-grid__table">
          <thead>
            <tr>
              <th className="instrument-grid__corner">{AXIS_LABEL[layout.rows]}</th>
              {colValues.map((col) => (
                <th
                  key={col.id}
                  className="instrument-grid__header-cell"
                  onClick={() => pivotCol(col)}
                  title={`Pivot: ${AXIS_LABEL[layout.cols]} [${col.label}]`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowValues.map((row) => (
              <tr key={row.id}>
                <th
                  scope="row"
                  className="instrument-grid__header-cell"
                  onClick={() => pivotRow(row)}
                  title={`Pivot: ${AXIS_LABEL[layout.rows]} [${row.label}]`}
                >
                  {row.label}
                </th>
                {colValues.map((col) => {
                  const coord = resolveCoordinate(layout, row.id, col.id, fixedId)
                  const data = cells.get(cellKey(coord))
                  const takeCount = data?.takeCount ?? 0
                  return (
                    <td key={col.id}>
                      <button
                        type="button"
                        className={
                          takeCount > 0 ? 'instrument-grid__cell is-filled' : 'instrument-grid__cell'
                        }
                        onClick={() => clickCell(row.id, col.id)}
                        title={`${row.label} / ${col.label} / ${AXIS_LABEL[layout.fixed]}: ${fixedLabel}`}
                      >
                        {takeCount > 0 ? takeCount : ''}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
