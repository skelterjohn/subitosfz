// Core data model for the instrument grid: note x articulation x velocity
// layer, as described in docs/design.md.

export type Axis = 'note' | 'articulation' | 'velocity'

export interface AxisValue {
  id: string
  label: string
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function midiToName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

export interface CellCoordinate {
  note: string
  articulation: string
  velocity: string
}

export function cellKey(coord: CellCoordinate): string {
  return `${coord.note}|${coord.articulation}|${coord.velocity}`
}

export interface CellData {
  // Round-robin take count - for a loaded file, the number of regions that
  // mapped to this (note, articulation, velocity) combination.
  takeCount: number
}

export type CellStore = Map<string, CellData>

// Everything the grid needs to render: the three axes' actual values, and
// the cell data keyed against them.
export interface Instrument {
  noteAxis: AxisValue[]
  articulationAxis: AxisValue[]
  velocityAxis: AxisValue[]
  cells: CellStore
}

export function axisValues(instrument: Instrument, axis: Axis): AxisValue[] {
  switch (axis) {
    case 'note':
      return instrument.noteAxis
    case 'articulation':
      return instrument.articulationAxis
    case 'velocity':
      return instrument.velocityAxis
  }
}

// Shown before any .sfz has been opened - genuinely empty, not padded out
// with a default range/articulation/velocity set.
export function emptyInstrument(): Instrument {
  return { noteAxis: [], articulationAxis: [], velocityAxis: [], cells: new Map() }
}

// Shape returned by POST /sfz/parse.
export interface ParsedSfzResponse {
  notes: number[]
  articulations: Array<{ id: string; label: string }>
  velocities: Array<{ lovel: number; hivel: number }>
  cells: Array<{ note: number; articulation: string; velocityIndex: number; takeCount: number }>
}

export function instrumentFromParsedSfz(parsed: ParsedSfzResponse): Instrument {
  const noteAxis: AxisValue[] = [...parsed.notes]
    .sort((a, b) => b - a) // high to low, matching demoInstrument's convention
    .map((midi) => ({ id: String(midi), label: midiToName(midi) }))

  const articulationAxis: AxisValue[] = parsed.articulations.map((a) => ({
    id: a.id,
    label: a.label
  }))

  const velocityAxis: AxisValue[] = parsed.velocities.map((v, i) => ({
    id: String(i),
    label: `${v.lovel}-${v.hivel}`
  }))

  const cells: CellStore = new Map()
  for (const c of parsed.cells) {
    cells.set(
      cellKey({
        note: String(c.note),
        articulation: c.articulation,
        velocity: String(c.velocityIndex)
      }),
      { takeCount: c.takeCount }
    )
  }

  return { noteAxis, articulationAxis, velocityAxis, cells }
}
