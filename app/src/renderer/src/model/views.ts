import type { Axis, CellCoordinate } from './instrument'

// Which axis is on rows, which is on columns, and which is pinned ("pivot")
// to a single value and hidden from the grid. See docs/design.md's rotate
// concept, now driven by clicking header cells instead of a rotate control.
export interface AxisLayout {
  rows: Axis
  cols: Axis
  fixed: Axis
}

// Of the two axes not currently pinned, the one earlier in this order is
// always rows - a fixed rule rather than something that depends on click
// history, so "note" is the y-axis whenever it's visible, etc.
export const AXIS_ORDER: Axis[] = ['note', 'articulation', 'velocity']

export function layoutForFixed(fixed: Axis): AxisLayout {
  const [rows, cols] = AXIS_ORDER.filter((a) => a !== fixed)
  return { rows, cols, fixed }
}

export function resolveCoordinate(
  layout: AxisLayout,
  rowId: string,
  colId: string,
  fixedId: string
): CellCoordinate {
  const byAxis: Record<Axis, string> = {
    [layout.rows]: rowId,
    [layout.cols]: colId,
    [layout.fixed]: fixedId
  } as Record<Axis, string>

  return {
    note: byAxis.note,
    articulation: byAxis.articulation,
    velocity: byAxis.velocity
  }
}
