# Post-processing

This describes the loudness/level-consistency processing applied to
recordings, and how it's scoped against the note x articulation x
velocity-layer grid described in [design.md](design.md).

## Scope of "consistent"

There are two distinct levels of loudness matching, and they work
differently:

1. **Round-robin takes within a cell** (same note, articulation, *and*
   velocity layer) are always matched to each other automatically. Any
   difference between them is just recording noise, not musical information,
   so there's no reason to ever leave them inconsistent or to ask the user
   about it.
2. **Cells across an axis** (different notes, different articulations, or
   different velocity layers) are *never* auto-normalized, because that
   variation is often the real, physical character of the instrument - a
   forte low note and a forte high note are expected to have genuinely
   different effective loudness. Flattening that away by default would make
   the instrument sound artificial. Matching across this level is an
   explicit, user-triggered action instead (see below).

## Visual volume indicator

Every cell in the grid always displays a loudness/energy indicator (its
round-robin-averaged measured loudness), independent of whether any
normalization has been applied. This is how the user notices when a span
needs attention - a dip or spike in the per-cell indicator going down an
axis is what prompts a "normalize this" action, rather than the tool
deciding on its own that something is wrong.

## Loudness normalization

- Measured as **integrated loudness** (ITU-R BS.1770 / EBU R128 style LUFS),
  not peak or RMS - two takes at the same peak dB can sound very differently
  loud depending on their transient/sustain shape, and LUFS tracks what we
  actually perceive.
- Round-robin takes within a cell are always gain-adjusted toward a shared
  target (their own average) so they sit at a consistent level with each
  other.
- Cross-cell normalization is **user-triggered and anchor-based**:
  1. The user clicks an axis (note, articulation, or velocity) to select it
     as the "direction" a normalization span runs in.
  2. The user right-clicks a specific cell and chooses "Normalize this
     span." That cell becomes the **reference** - it stays unchanged - and
     every other cell sharing the same coordinates on the other two axes
     (i.e. the line of cells running through it along the selected axis)
     gets gain-adjusted up or down to match the reference cell's loudness.
  3. This can be repeated per-span wherever the user actually wants
     consistency; it's never applied globally across an entire axis at once.

## Manual percent nudge

Separate from anchor-based span normalization, a lighter manual tool exists
for by-feel adjustments: a percentage gain change (e.g. "+2%") applied to
whatever is currently **selected** in the grid, rather than force-matching
it to a reference cell. Typical use: the pitch-axis volume indicator shows
one note sitting slightly below its neighbors in a way that doesn't look
like genuine instrument character, just an uneven take, so it gets nudged up
a couple percent to sit naturally between the notes on either side of it.

The scope of a nudge is always just "the current selection in the current
2D view" - it never reaches into a hidden third axis on its own. That keeps
it consistent with everything else in the UI, but it also means the two ways
to select a target compose naturally with rotation:

- Right-click a single **axis label** (e.g. one note's row) to nudge just
  that line of cells within the current view.
- Rotate to the view where the axis you care about is the fixed/depth
  parameter (e.g. "Articulation x Velocity for a single note"), then select
  the **entire visible grid**, to nudge that note's level across every
  articulation and velocity at once. Reaching "the whole note everywhere" is
  achieved by rotating to the right view first, not by a special case in the
  nudge action itself.

## Basic compression

- A single-band compressor (threshold/ratio/attack/release internally),
  applied per-take to tame that one recording's own inconsistent transients
  (e.g. an unusually hot pick attack) before loudness normalization runs.
- Given the low-friction goal, expose close to no raw parameters - most
  likely a single "amount" dial (off -> gentle -> strong) mapped internally
  to sensible compressor settings, rather than manual threshold/ratio/attack/
  release controls.
- Processing order: compress each take first, then normalize the cell's
  loudness second.

## Pitch-axis visualization (diagnostic, not corrective)

Even though loudness is deliberately *not* normalized across notes, the user
still wants visibility into how level trends across the pitch axis for a
fixed (articulation, velocity) slice - both to see the instrument's natural
loudness curve across its range, and to spot genuine problems (a bad mic
placement, a dropped take) that break the pattern in a way physical dynamics
wouldn't.

- A chart with **pitch (note) on the x-axis and measured loudness (LUFS) on
  the y-axis**, for one fixed articulation + velocity layer at a time -
  naturally pairs with the "Note x Velocity for one articulation" rotated
  view from design.md, or a dedicated strip alongside a single grid row.
- Purely informational: nothing about the audio changes because of this
  view. It's there so an unexpected dip/spike relative to neighboring notes
  is obvious at a glance, distinct from the instrument's expected smooth
  loudness curve across its range.
- Could extend later to show other per-take diagnostics (peak level,
  duration) alongside loudness, but loudness is the primary signal to start
  with.

## Open questions

- Chart placement/interaction in the UI (overlay on the grid vs. a separate
  panel you open per articulation+velocity slice).
- Whether a span normalization can be undone/reset back to each cell's
  original measured loudness, and whether re-running it on an overlapping
  span (different axis, shared cells) composes or conflicts.
- Whether to flag outlier notes automatically (take that deviates sharply
  from its pitch-axis neighbors) as a future nice-to-have, not core v1.
- Where per-take loudness measurements get cached, since they're real DSP
  work done in the Rust sidecar and shouldn't be recomputed on every UI
  render.
