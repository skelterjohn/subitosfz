import type { Axis, CellCoordinate } from './instrument'

export interface RotationView {
  label: string
  rows: Axis
  cols: Axis
  fixed: Axis
}

// The three 2D projections of the note x articulation x velocity cube,
// cycled through by the "rotate" control. See docs/design.md.
export const VIEWS: RotationView[] = [
  { label: 'note × articulation', rows: 'note', cols: 'articulation', fixed: 'velocity' },
  { label: 'note × velocity', rows: 'note', cols: 'velocity', fixed: 'articulation' },
  { label: 'articulation × velocity', rows: 'articulation', cols: 'velocity', fixed: 'note' }
]

export function resolveCoordinate(
  view: RotationView,
  rowId: string,
  colId: string,
  fixedId: string
): CellCoordinate {
  const byAxis: Record<Axis, string> = {
    [view.rows]: rowId,
    [view.cols]: colId,
    [view.fixed]: fixedId
  } as Record<Axis, string>

  return {
    note: byAxis.note,
    articulation: byAxis.articulation,
    velocity: byAxis.velocity
  }
}
