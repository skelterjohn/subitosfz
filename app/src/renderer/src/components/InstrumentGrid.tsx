import { useMemo, useState } from 'react'
import {
  axisValues,
  cellKey,
  seedDemoCells,
  type Axis,
  type CellStore
} from '../model/instrument'
import { resolveCoordinate, VIEWS } from '../model/views'
import './InstrumentGrid.css'

const AXIS_LABEL: Record<Axis, string> = {
  note: 'Note',
  articulation: 'Articulation',
  velocity: 'Velocity'
}

export default function InstrumentGrid(): React.JSX.Element {
  const [viewIndex, setViewIndex] = useState(0)
  const [fixedValues, setFixedValues] = useState<Record<Axis, string>>(() => ({
    note: axisValues('note')[0].id,
    articulation: axisValues('articulation')[0].id,
    velocity: axisValues('velocity')[0].id
  }))
  const [cells, setCells] = useState<CellStore>(() => seedDemoCells())

  const view = VIEWS[viewIndex]
  const rowValues = useMemo(() => axisValues(view.rows), [view.rows])
  const colValues = useMemo(() => axisValues(view.cols), [view.cols])
  const fixedAxisValues = useMemo(() => axisValues(view.fixed), [view.fixed])
  const fixedId = fixedValues[view.fixed]

  function rotate(): void {
    setViewIndex((i) => (i + 1) % VIEWS.length)
  }

  function setFixed(id: string): void {
    setFixedValues((prev) => ({ ...prev, [view.fixed]: id }))
  }

  // Placeholder interaction until real recording is wired up: clicking a
  // cell just cycles its take count, so the grid is visibly interactive.
  function clickCell(rowId: string, colId: string): void {
    const coord = resolveCoordinate(view, rowId, colId, fixedId)
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

  return (
    <div className="instrument-grid">
      <div className="instrument-grid__toolbar">
        <button type="button" onClick={rotate}>
          ⟳ Rotate
        </button>
        <span className="instrument-grid__view-label">{view.label}</span>
        <label className="instrument-grid__fixed-select">
          Viewing {AXIS_LABEL[view.fixed]}:
          <select value={fixedId} onChange={(e) => setFixed(e.target.value)}>
            {fixedAxisValues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="instrument-grid__scroll">
        <table className="instrument-grid__table">
          <thead>
            <tr>
              <th className="instrument-grid__corner">{AXIS_LABEL[view.rows]}</th>
              {colValues.map((col) => (
                <th key={col.id}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowValues.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                {colValues.map((col) => {
                  const coord = resolveCoordinate(view, row.id, col.id, fixedId)
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
                        title={`${row.label} / ${col.label} / ${AXIS_LABEL[view.fixed]}: ${
                          fixedAxisValues.find((v) => v.id === fixedId)?.label
                        }`}
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
