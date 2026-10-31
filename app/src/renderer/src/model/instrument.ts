// Core data model for the instrument grid: note x articulation x velocity
// layer, as described in docs/design.md. This is placeholder in-memory data
// for UI development - no persistence or real recordings wired up yet.

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

// E2 (40) to E6 (88): a reasonable default range covering standard guitar
// plus headroom for high harmonics. Easy to make configurable per-instrument
// later.
const LOW_MIDI = 40
const HIGH_MIDI = 88

export const NOTE_AXIS: AxisValue[] = Array.from(
  { length: HIGH_MIDI - LOW_MIDI + 1 },
  (_, i) => {
    const midi = LOW_MIDI + i
    return { id: String(midi), label: midiToName(midi) }
  }
).reverse() // high to low, so the grid reads top-to-bottom like a keyboard

export const ARTICULATION_AXIS: AxisValue[] = ['normal', 'pizzicato', 'harmonics'].map((a) => ({
  id: a,
  label: a
}))

export const VELOCITY_AXIS: AxisValue[] = ['soft', 'loud'].map((v) => ({ id: v, label: v }))

export function axisValues(axis: Axis): AxisValue[] {
  switch (axis) {
    case 'note':
      return NOTE_AXIS
    case 'articulation':
      return ARTICULATION_AXIS
    case 'velocity':
      return VELOCITY_AXIS
  }
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
  // Round-robin take count. Real takes (audio + loudness measurement) come
  // later; for now this is just enough to distinguish "has recordings" from
  // "empty" in the UI.
  takeCount: number
}

export type CellStore = Map<string, CellData>

// A handful of pre-filled cells purely so the grid has something to look at
// while the UI is being built - not meant to represent a real instrument.
export function seedDemoCells(): CellStore {
  const store: CellStore = new Map()
  const seeds: Array<[number, string, string, number]> = [
    [76, 'normal', 'soft', 2],
    [76, 'normal', 'loud', 3],
    [74, 'normal', 'soft', 1],
    [74, 'normal', 'loud', 2],
    [72, 'normal', 'soft', 2],
    [72, 'pizzicato', 'soft', 1],
    [72, 'harmonics', 'loud', 1],
    [67, 'normal', 'loud', 1]
  ]
  for (const [midi, articulation, velocity, takeCount] of seeds) {
    store.set(cellKey({ note: String(midi), articulation, velocity }), { takeCount })
  }
  return store
}
