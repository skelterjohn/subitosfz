// A curated reference of commonly-used SFZ opcodes, for the "About
// opcodes..." window (see OpcodeReferenceWindow.tsx). Deliberately broader
// than whatever this app's own editors currently know how to write - the
// opcode panel's free-text "+" controls (see SampleTakeList.tsx) accept any
// opcode name, so this exists to help with ones Subito itself never
// generates. Not the entire SFZ spec (some genuinely obscure/rarely-needed
// opcodes are left out), but enough to cover what a real instrument file is
// likely to use.
export interface OpcodeDoc {
  name: string
  description: string
}

const RAW_OPCODES: OpcodeDoc[] = [
  {
    name: 'sample',
    description:
      'Path (relative to the .sfz file) to the audio file this region plays. The only opcode required for a region to produce sound.'
  },
  {
    name: 'default_path',
    description:
      "A path prefix prepended to every sample= opcode that follows it in the file, so a whole bank of regions can share one base directory without repeating it on every line."
  },
  {
    name: 'lokey',
    description: 'Lowest MIDI key that triggers this region. Defaults to 0 (the bottom of the keyboard) if unset.'
  },
  {
    name: 'hikey',
    description: 'Highest MIDI key that triggers this region. Defaults to 127 (the top of the keyboard) if unset.'
  },
  {
    name: 'key',
    description:
      'Shorthand that sets lokey, hikey, and pitch_keycenter all to the same single note in one line - convenient, but a later, explicit lokey/hikey/pitch_keycenter line only overrides its own piece of it.'
  },
  {
    name: 'pitch_keycenter',
    description:
      "The MIDI note this sample was actually recorded at. Keys above or below it are pitch-shifted relative to this anchor, independently of how wide lokey/hikey make the region's playable range."
  },
  { name: 'lovel', description: 'Lowest MIDI velocity (1-127) that triggers this region.' },
  { name: 'hivel', description: 'Highest MIDI velocity (1-127) that triggers this region. Defaults to 127 if unset.' },
  {
    name: 'lorand',
    description:
      'Lower bound (0-1) of a random-number window used to pick among several regions that otherwise share the same key/velocity - useful for round-robin-by-chance sample variation.'
  },
  { name: 'hirand', description: 'Upper bound of the lorand/hirand random-selection window; see lorand.' },
  {
    name: 'seq_position',
    description:
      "This region's slot (1-based) in a round-robin cycle - paired with seq_length, successive note-ons at the same key/velocity advance through slots in strict order rather than randomly."
  },
  { name: 'seq_length', description: 'The total number of slots in a round-robin cycle; see seq_position.' },
  {
    name: 'trigger',
    description:
      'What kind of MIDI event fires this region - attack (ordinary note-on, the default), release (note-off), first (only the first note of a legato phrase), or legato (every note after the first).'
  },
  {
    name: 'group',
    description:
      "Assigns this region to a numbered choke group. Triggering any region in the group immediately cuts off every other currently-sounding region sharing that same group number (paired with off_by) - the classic use is an open/closed hi-hat pair."
  },
  {
    name: 'off_by',
    description: 'The group number that, when triggered, silences THIS region. Used together with group to build mutually-exclusive regions.'
  },
  {
    name: 'off_mode',
    description:
      "How a choked region (via off_by) actually stops - fast is a quick fade-out (the default), normal lets it play its own release envelope instead."
  },
  {
    name: 'polyphony',
    description:
      'Caps how many instances of this one region can sound at once; once the cap is hit, the oldest voice is stolen to make room for a new one.'
  },
  {
    name: 'note_polyphony',
    description: 'Like polyphony, but the cap applies per individual MIDI note rather than across the whole region.'
  },
  {
    name: 'note_selfmask',
    description:
      "When note_polyphony limits a note's voices, controls whether a fresh note-on mutes the still-sounding older ones (on, the default) or lets them keep ringing alongside it (off)."
  },
  {
    name: 'offset',
    description:
      "Sample frame to start playback from, letting a region begin partway into the audio file instead of at its true start - handy for trimming an unwanted lead-in without re-encoding the file."
  },
  {
    name: 'offset_random',
    description: 'Adds a random extra number of frames on top of offset on every note-on, for subtle per-hit timing variation.'
  },
  {
    name: 'end',
    description:
      'Sample frame at which playback stops (and loops back, if looping) - trims the tail of the file in place without needing a separate edited copy.'
  },
  {
    name: 'count',
    description:
      "A decrementing real-time repeat counter, mainly used to emulate older hardware samplers' finite-repeat behavior; rarely needed otherwise."
  },
  {
    name: 'loop_mode',
    description:
      'How this sample loops - no_loop (plays once to the end, the usual default), one_shot (always plays to completion regardless of note-off, e.g. drum hits), loop_continuous (loops between loop_start/loop_end for as long as the note is held), or loop_sustain (loops only while the sustain pedal/CC64 is held).'
  },
  { name: 'loop_start', description: 'Sample frame where a sustain loop begins; see loop_mode.' },
  {
    name: 'loop_end',
    description: 'Sample frame where a sustain loop ends, at which point playback jumps back to loop_start.'
  },
  {
    name: 'loop_crossfade',
    description:
      'Length, in frames, of an automatically generated crossfade across the loop seam, to smooth away an audible click or bump at the loop point.'
  },
  {
    name: 'octave_offset',
    description:
      "Shifts every key this region references (lokey/hikey/pitch_keycenter/key) up or down by whole octaves at once - handy for remapping an entire bank without rewriting every opcode."
  },
  {
    name: 'note_offset',
    description: 'Like octave_offset, but shifts by individual semitones instead of whole octaves.'
  },
  {
    name: 'transpose',
    description: "Shifts the sample's actual playback pitch by whole semitones, without changing which MIDI keys trigger the region."
  },
  {
    name: 'tune',
    description:
      'Fine-tunes playback pitch in cents (hundredths of a semitone) - useful for correcting a slightly-off recording or deliberately detuning one layer against another.'
  },
  {
    name: 'pitch_keytrack',
    description:
      'Percentage of the normal "pitch shifts per key" behavior to apply; 100 (default) tracks the keyboard normally, 0 makes every key play back at the same pitch regardless of key - common for unpitched drum hits.'
  },
  {
    name: 'pitch_veltrack',
    description:
      'How many cents incoming velocity bends playback pitch by, so harder hits can sound subtly sharper or flatter, like some real instruments do.'
  },
  {
    name: 'pitch_random',
    description: "Adds a small random pitch offset (in cents) on every note-on, so repeated notes don't sound mechanically identical."
  },
  { name: 'bend_up', description: 'The pitch-bend range, in cents, for a full upward pitch-wheel movement.' },
  { name: 'bend_down', description: 'The pitch-bend range, in cents, for a full downward pitch-wheel movement.' },
  {
    name: 'amp_veltrack',
    description:
      'Percentage controlling how much incoming velocity scales output amplitude; 100 (the default) makes louder hits play louder, 0 means velocity only decides which region gets selected (via lovel/hivel) without also re-scaling its volume - important when distinct velocity layers are already separately-recorded samples at their own natural loudness.'
  },
  {
    name: 'amp_velcurve_N',
    description:
      'One point (N is a velocity, 0-127) of a custom, non-linear velocity-to-amplitude curve, letting the overall response deviate from the plain straight-line ramp amp_veltrack otherwise produces.'
  },
  {
    name: 'amp_keytrack',
    description: 'How much output amplitude changes per key away from the reference key, in dB per key - lets higher or lower notes play back systematically louder or softer.'
  },
  {
    name: 'amp_keycenter',
    description: "The reference key amp_keytrack measures its per-key amplitude change from; defaults to pitch_keycenter if not set separately."
  },
  {
    name: 'amp_random',
    description: "Adds a small random amplitude variation (in dB) on every note-on, so repeated hits don't sound identically loud."
  },
  {
    name: 'volume',
    description: "The region's base output level, in dB, applied on top of (not instead of) whatever loudness the recording already has."
  },
  { name: 'pan', description: 'Stereo position, from -100 (full left) to 100 (full right); 0 is centered.' },
  {
    name: 'width',
    description: "For a stereo sample, how wide its own left/right image is spread, independently of where pan then places that image in the overall mix."
  },
  {
    name: 'position',
    description: 'A pan-like placement opcode intended for surround/ambisonic setups rather than plain stereo; rarely needed for a stereo-only instrument.'
  },
  {
    name: 'rt_decay',
    description:
      'Real-time decay rate, in dB per second, applied to a release-triggered region - makes a release sample fade out faster the longer the preceding note was actually held.'
  },
  {
    name: 'xfin_lovel',
    description:
      'The bottom of the velocity range over which this region fades IN, letting two velocity layers blend smoothly instead of switching abruptly at a lovel/hivel boundary.'
  },
  { name: 'xfin_hivel', description: 'The top of the xfin_lovel fade-in velocity range; see xfin_lovel.' },
  {
    name: 'xfout_lovel',
    description: "The bottom of the velocity range over which this region fades OUT, paired with a neighboring layer's xfin range for a smooth crossfade."
  },
  { name: 'xfout_hivel', description: 'The top of the xfout_lovel fade-out velocity range; see xfout_lovel.' },
  {
    name: 'xfin_lokey',
    description: 'The bottom of a key range over which this region fades IN, for crossfading between differently-sampled registers instead of velocity layers.'
  },
  { name: 'xfin_hikey', description: 'The top of the xfin_lokey fade-in key range; see xfin_lokey.' },
  {
    name: 'xfout_lokey',
    description: "The bottom of a key range over which this region fades OUT; paired with a neighboring region's xfin_lokey/xfin_hikey."
  },
  { name: 'xfout_hikey', description: 'The top of the xfout_lokey fade-out key range; see xfout_lokey.' },
  {
    name: 'xf_velcurve',
    description: 'Selects whether velocity-based crossfades (xfin/xfout_vel) follow a linear ramp or an equal-power curve, which sounds smoother for overlapping layers.'
  },
  {
    name: 'xf_keycurve',
    description: 'Same choice as xf_velcurve, but for key-range crossfades (xfin/xfout_key) instead of velocity ones.'
  },
  { name: 'ampeg_attack', description: 'Seconds for the amplitude envelope to ramp up from silence to full level after note-on.' },
  {
    name: 'ampeg_hold',
    description: 'Seconds the envelope holds at full level once the attack finishes, before decay begins.'
  },
  { name: 'ampeg_decay', description: 'Seconds for the envelope to fall from full level down to the sustain level.' },
  {
    name: 'ampeg_sustain',
    description: 'The sustain level, as a percentage of full amplitude, held for as long as the note stays on after the decay stage finishes.'
  },
  { name: 'ampeg_release', description: "Seconds for the envelope to fade from its current level to silence after note-off." },
  { name: 'ampeg_delay', description: 'Seconds to wait after note-on before the attack stage even begins.' },
  {
    name: 'ampeg_start',
    description: "The envelope's own starting level, as a percentage, for samples that should begin partway up rather than from true silence."
  },
  {
    name: 'ampeg_vel2attack',
    description: 'How many seconds incoming velocity adds to (or subtracts from) ampeg_attack, letting harder hits snap in faster or slower.'
  },
  { name: 'ampeg_vel2decay', description: 'How many seconds incoming velocity adds to (or subtracts from) ampeg_decay.' },
  {
    name: 'ampeg_vel2release',
    description: 'How many seconds incoming velocity adds to (or subtracts from) ampeg_release, so harder notes can cut off release length.'
  },
  { name: 'ampeg_vel2sustain', description: 'How many percentage points incoming velocity adds to (or subtracts from) ampeg_sustain.' },
  { name: 'ampeg_vel2delay', description: 'How many seconds incoming velocity adds to (or subtracts from) ampeg_delay.' },
  { name: 'ampeg_vel2hold', description: 'How many seconds incoming velocity adds to (or subtracts from) ampeg_hold.' },
  { name: 'cutoff', description: "The filter's center/cutoff frequency, in Hz." },
  { name: 'resonance', description: "The filter's resonance (Q), in dB, boosting the band of frequencies right around the cutoff." },
  {
    name: 'fil_type',
    description:
      'Which kind of filter to apply (e.g. lpf_2p, hpf_2p, bpf_2p, and steeper multi-pole variants) - shapes which frequencies the cutoff/resonance opcodes actually act on.'
  },
  { name: 'fil_veltrack', description: 'How many cents incoming velocity shifts the filter cutoff by, so harder hits can sound brighter.' },
  {
    name: 'fil_keytrack',
    description: "How many cents the filter cutoff rises per key played, so the filter's brightness tracks the keyboard the way many real instruments' natural resonances do."
  },
  { name: 'fil_keycenter', description: 'The reference key fil_keytrack measures its per-key cutoff shift from; defaults to pitch_keycenter.' },
  {
    name: 'cutoff2',
    description: 'The center frequency of a second, independent filter stage chained after the first, for more complex tone shaping.'
  },
  { name: 'resonance2', description: 'The resonance (Q) of the second filter stage; see cutoff2.' },
  { name: 'fil2_type', description: 'The filter shape used by the second filter stage; see cutoff2.' },
  { name: 'amplfo_freq', description: 'The rate, in Hz, of a low-frequency oscillator that tremolos the output amplitude.' },
  { name: 'amplfo_depth', description: 'The depth, in dB, of the amplitude tremolo LFO; see amplfo_freq.' },
  { name: 'pitchlfo_freq', description: "The rate, in Hz, of an LFO that vibratos the playback pitch." },
  { name: 'pitchlfo_depth', description: 'The depth, in cents, of the pitch vibrato LFO; see pitchlfo_freq.' },
  { name: 'fillfo_freq', description: 'The rate, in Hz, of an LFO that wobbles the filter cutoff frequency.' },
  { name: 'fillfo_depth', description: 'The depth, in cents, of the filter-cutoff LFO; see fillfo_freq.' },
  {
    name: 'sw_lokey',
    description:
      "The bottom of a key range reserved as keyswitch triggers rather than audible notes - pressing a key in this range doesn't sound a sample, it just updates sw_last."
  },
  { name: 'sw_hikey', description: 'The top of the sw_lokey keyswitch trigger range; see sw_lokey.' },
  {
    name: 'sw_last',
    description:
      'The most recently pressed keyswitch note. A region only plays if sw_last currently matches the value this opcode names, which is how one instrument file can offer several switchable articulations (e.g. pizzicato vs. arco).'
  },
  {
    name: 'sw_label',
    description: 'A human-readable name for a particular keyswitch value, shown by host software in place of a bare MIDI note number.'
  },
  {
    name: 'sw_default',
    description: "Which keyswitch value is active before any keyswitch key has actually been pressed yet, so the instrument starts on a sensible default articulation."
  },
  {
    name: 'sw_up',
    description: "A key that, while held, activates a different articulation than otherwise selected - reverts the instant it's released, unlike sw_last's latching switch behavior."
  },
  { name: 'sw_down', description: 'The counterpart to sw_up for the opposite/alternate momentary articulation; see sw_up.' },
  {
    name: 'sw_previous',
    description:
      'Used together with trigger=legato/first to make a region depend on which note immediately preceded it, enabling genuine note-to-note legato transitions rather than just overlapping note-ons.'
  },
  {
    name: 'effect1',
    description: "How much (0-100) of this region's signal is sent to the SFZ file's first effect bus (e.g. a shared reverb), independent of its normal direct/dry output."
  },
  { name: 'effect2', description: "Same idea as effect1, for the file's second effect bus." },
  {
    name: 'output',
    description: "Routes this region's output to a specific channel pair in a multi-output host, instead of the default stereo mix."
  },
  { name: 'lochan', description: 'Restricts this region to only respond on MIDI channels at or above this number, for multi-channel split instruments.' },
  { name: 'hichan', description: 'Restricts this region to only respond on MIDI channels at or below this number; see lochan.' },
  { name: 'lobend', description: 'Restricts this region to only play when the pitch-bend wheel is at or above this position.' },
  { name: 'hibend', description: 'Restricts this region to only play when the pitch-bend wheel is at or below this position; see lobend.' },
  {
    name: 'locc',
    description:
      'Shorthand gate requiring a specific MIDI CC (named by its own opcode suffix, e.g. locc64) to be at or above a given value at note-on for this region to trigger.'
  },
  { name: 'hicc', description: 'The upper-bound counterpart to locc; see locc.' }
]

export const OPCODE_REFERENCE: OpcodeDoc[] = [...RAW_OPCODES].sort((a, b) => a.name.localeCompare(b.name))

// Subsequence fuzzy match (every character of `query`, in order, found
// somewhere in `target`) rather than plain substring matching - lets e.g.
// "ampvel" find "amp_veltrack" without the user typing the underscore.
// Case-insensitive. Returns which indices of `target` the match actually
// consumed (for bolding them in the UI - see OpcodeReferenceWindow.tsx), or
// null if it doesn't match at all. An empty query trivially matches
// everything with nothing to highlight.
export function fuzzyMatchIndices(query: string, target: string): Set<number> | null {
  if (!query) return new Set()
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const indices = new Set<number>()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.add(ti)
      qi++
    }
  }
  return qi === q.length ? indices : null
}

export function fuzzyMatches(query: string, target: string): boolean {
  return fuzzyMatchIndices(query, target) !== null
}
