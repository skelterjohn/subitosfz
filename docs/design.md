# Instrument grid: design approach

This describes the core data model and UI concept for building an instrument in
Subito sfz, and how it maps onto the SFZ format we're targeting.

## SFZ background (the parts that matter here)

An `.sfz` file is plain text: a `<region>` is one sample plus its playback
rules, and `<group>`/`<master>`/`<global>` headers let shared settings cascade
down to the regions beneath them. Three SFZ mechanisms map directly onto the
three variables a real instrument needs:

- **Articulation** (normal / pizzicato / harmonics / ...) is handled by
  **keyswitching**: a dedicated range of MIDI keys (`sw_lokey`/`sw_hikey`)
  that don't themselves sound, but set which articulation is "selected"
  (`sw_last` on each region, `sw_default` for the initial state). Each
  articulation is a genuinely separate recording, not a processed variant of
  another.
- **Dynamics** (soft / loud) are handled by **velocity layers**: multiple
  regions on the same key with different `lovel`/`hivel` ranges, each
  pointing at a distinct recording captured at that playing intensity (not a
  volume-scaled copy of another layer, since playing harder changes timbre,
  not just loudness). `xfin_*`/`xfout_*` opcodes can crossfade between
  layers instead of hard-switching.
- **Round robin** (multiple takes of the *same* note/articulation/dynamic, to
  avoid a machine-gunned repeated note sounding identical every time) is
  handled by `seq_position`/`seq_length` across several regions that are
  otherwise identical.
- **Trimming** dead air before/after a take is expressed as `offset=`/`end=`
  sample-frame markers on the region, rather than re-encoding a shorter
  audio file — trimming can be non-destructive metadata.

## Data model: a 3D grid

The instrument is modeled as a cube with three axes:

- **Note** (row) — the MIDI key/pitch being recorded
- **Articulation** (column) — normal, pizzicato, harmonics, etc. (user-defined
  set, not fixed by the tool)
- **Velocity layer** (depth) — soft, hard, etc. (also user-defined)

Each cell at the intersection of all three holds **one or more round-robin
takes** — round robin is *not* a fourth axis, it's a list living inside a
cell, since round-robin takes are interchangeable alternates for the exact
same (note, articulation, velocity) rather than something a player selects.

This lines up with SFZ directly: each take in a cell becomes one `<region>`;
cells sharing an articulation share keyswitch opcodes (naturally placed on a
`<group>`); cells sharing a note share `key=`/`pitch_keycenter=`.

## UI: 2D views with a "rotate" control

Because a literal 3D grid is hard to skim, the UI only ever shows a 2D
projection of the cube, with a **rotate** control to switch which two axes
are on screen and which one becomes a fixed "currently viewing" slice:

1. **Note × Articulation** (velocity fixed/implied) — the default view, best
   for seeing overall instrument coverage.
2. **Note × Velocity** for one articulation — best for checking dynamic-layer
   completeness within a single articulation.
3. **Articulation × Velocity** for one note — best for checking that a
   specific note has every articulation/dynamic combination captured.

Rotating changes the grid's rows/columns and the fixed-slice selector (e.g.
"Viewing: Pizzicato"); it does not require any 3D rendering. The goal of the
grid+rotate UI is to make it easy to see what's still missing, from whichever
angle is most useful at the time.

## Open questions / not yet decided

- Exact UI for drilling into a cell to manage its round-robin takes.
- How articulation/velocity-layer sets are defined per-instrument (fixed
  presets vs. fully user-defined names).
- Recording workflow details (covered separately as we design mic capture
  and post-processing).
