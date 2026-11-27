// The app's first (and deliberately narrow) .sfz write capability: append
// one new <region> to an existing file as plain text, then re-parse.
//
// sfz_parse.rs is a lossy, flattening parser by design (block structure
// isn't retained once regions are cascaded) - there is no general
// "reconstruct the whole file" round-trip anywhere, and building one is a
// separate, bigger undertaking than this needs. Appending new text is
// additive and never touches what's already there, so it doesn't need one.
//
// Every function below except open_working_copy/save reads/writes SFZ
// *text* at a working-copy path, never the file the user actually opened -
// see those two functions' own docs for why. The working copy lives in an
// app-specific temp directory, NOT next to the real file, so anything that
// needs to resolve a sample= path (relative to wherever the project's
// actual assets live) is given the ORIGINAL path separately and derives
// the project directory from THAT, never from the working path.
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::sfz_parse::{self, ParsedSfz};

// Copies the real file to a scratch working path (overwriting any stale
// working copy already there, e.g. from a crashed previous session) and
// parses THAT copy - every edit this app makes from here on targets the
// working copy, never the original, until save() below explicitly mirrors
// it back.
pub fn open_working_copy(original_path: &Path, working_path: &Path) -> Result<ParsedSfz, String> {
    fs::copy(original_path, working_path).map_err(|e| format!("failed to open file: {e}"))?;
    sfz_parse::parse(working_path)
}

// Mirrors the working copy's current content onto the real file - the
// only point anywhere in this app where the file the user actually opened
// gets written to.
pub fn save(working_path: &Path, original_path: &Path) -> Result<(), String> {
    fs::copy(working_path, original_path).map_err(|e| format!("failed to save file: {e}"))?;
    Ok(())
}

// Creates a brand-new, empty .sfz file in an existing directory - "New" in
// the File menu. Never overwrites: an existing file at the target path is
// left untouched and reported as an error, since silently clobbering
// whatever's already there would be a much worse surprise than just asking
// for a different name. Returns the new file's path so the caller can open
// it the normal way (App.tsx's loadSfzFile) rather than this needing to
// know anything about working copies itself.
pub fn create_new(dest_dir: &Path, file_name: &str) -> Result<String, String> {
    let safe_name = crate::sf2::sanitize_filename(file_name);
    let sfz_path = dest_dir.join(format!("{safe_name}.sfz"));
    if sfz_path.exists() {
        return Err(format!("a file already exists at {}", sfz_path.display()));
    }
    fs::write(&sfz_path, "").map_err(|e| format!("failed to create file: {e}"))?;
    Ok(sfz_path.to_string_lossy().to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn append_region(
    working_sfz_path: &Path,
    original_sfz_path: &Path,
    sample_path: &str,
    note: u8,
    lokey: u8,
    hikey: u8,
    lovel: u8,
    hivel: u8,
    pan: i32,
    articulation_id: &str,
    articulation_label: Option<&str>
) -> Result<ParsedSfz, String> {
    if lokey > hikey {
        return Err(format!("lokey ({lokey}) cannot be greater than hikey ({hikey})"));
    }
    if lovel > hivel {
        return Err(format!("lovel ({lovel}) cannot be greater than hivel ({hivel})"));
    }
    if !(-100..=100).contains(&pan) {
        return Err(format!("pan ({pan}) must be between -100 and 100"));
    }

    // sample= is relative to the project directory (where the real file -
    // and the actual sample files - live), not the working copy's own
    // (temp, unrelated) directory.
    let dir = original_sfz_path
        .parent()
        .ok_or_else(|| "sfz path has no parent directory".to_string())?;
    let resolved_sample = dir.join(sample_path);
    if !resolved_sample.is_file() {
        return Err(format!("sample file not found: {}", resolved_sample.display()));
    }

    let mut text =
        fs::read_to_string(working_sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }

    // Forward-slash, regardless of host OS, matching SFZ convention and
    // the rest of this codebase's own sample= paths (see sf2.rs).
    let normalized_sample_path = sample_path.replace('\\', "/");
    let label = articulation_label.filter(|l| !l.is_empty()).unwrap_or(articulation_id);

    text.push('\n');
    text.push_str("<region>\n");
    text.push_str(&format!("sample={normalized_sample_path}\n"));
    // pitch_keycenter=note - the sample's actual recorded pitch, used for
    // pitch-shifting neighboring keys - independent of lokey/hikey, which
    // are the full key range this region plays for and may be wider than
    // just `note` itself. Deliberately NOT the `key` opcode: key is SFZ
    // shorthand for setting pitch_keycenter AND lokey AND hikey all to the
    // same value, which would collide with the explicit lokey/hikey lines
    // below the moment anyone edits this region later - this app's opcode
    // editor only ever appends a new line for an edited opcode, so a later
    // `key=` edit (e.g. just nudging the pitch) would land after these
    // lokey/hikey lines and silently collapse the key range back down to a
    // single note.
    text.push_str(&format!("pitch_keycenter={note}\n"));
    text.push_str(&format!("lokey={lokey}\n"));
    text.push_str(&format!("hikey={hikey}\n"));
    text.push_str(&format!("lovel={lovel}\n"));
    text.push_str(&format!("hivel={hivel}\n"));
    text.push_str(&format!("pan={pan}\n"));
    text.push_str(&format!("sw_last={articulation_id}\n"));
    text.push_str(&format!("sw_label={label}\n"));

    fs::write(working_sfz_path, text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(working_sfz_path)
}

// Byte range [start, end) of exactly region `target_index`'s own span -
// from the start of its own <region> header line up to (but not including)
// the next <...> header line (mirrors sfz_parse's flush_region, which
// flushes on ANY header token, not just <region>), or to the end of the
// file if it's the last region. A header is only recognized as the first
// whitespace-separated word of a line (after stripping a trailing `//`
// comment) - true of everything this app's own writers emit and the common
// hand-authored convention, but not a full reimplementation of sfz_parse's
// word-level tokenizer.
//
// `end` alone is also "the insertion offset" set_region_opcode/
// set_cell_opcodes want (append a line right before the next header); the
// full range is what delete_region needs to remove the region entirely.
fn region_span(text: &str, target_index: usize) -> Result<(usize, usize), String> {
    let mut region_count = 0usize;
    let mut in_target = false;
    let mut start = 0usize;
    let mut offset = 0usize;

    for line in text.split_inclusive('\n') {
        let code = match line.find("//") {
            Some(idx) => &line[..idx],
            None => line
        };
        let first_word = code.split_whitespace().next();
        let is_header = matches!(first_word, Some(w) if w.starts_with('<'));

        if is_header {
            if in_target {
                return Ok((start, offset));
            }
            if first_word == Some("<region>") {
                if region_count == target_index {
                    in_target = true;
                    start = offset;
                }
                region_count += 1;
            }
        }

        offset += line.len();
    }

    if in_target {
        Ok((start, offset))
    } else {
        let plural = if region_count == 1 { "" } else { "s" };
        Err(format!(
            "region index {target_index} out of range (file has {region_count} region{plural})"
        ))
    }
}

fn region_insertion_offset(text: &str, target_index: usize) -> Result<usize, String> {
    region_span(text, target_index).map(|(_, end)| end)
}

// Removes region `region_index`'s entire span (its own <region> header
// through just before the next header, or EOF) from the file - the only
// write operation in this module that deletes rather than appends. The
// region's sample= file on disk is untouched; it simply becomes an
// unreferenced .wav again, which the drawer's own unassigned-chunk scan
// (a filesystem diff, not something tracked here) picks up on its own.
//
// Deleting shifts every later region's regionIndex down by one on the next
// parse - callers that need to keep something else selected after this
// should re-find it by cell criteria (key/vel range, articulation), not by
// index.
pub fn delete_region(working_sfz_path: &Path, region_index: usize) -> Result<ParsedSfz, String> {
    let text = fs::read_to_string(working_sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;
    let (start, end) = region_span(&text, region_index)?;

    let mut new_text = String::with_capacity(text.len() - (end - start));
    new_text.push_str(&text[..start]);
    new_text.push_str(&text[end..]);

    fs::write(working_sfz_path, &new_text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(working_sfz_path)
}

// Shared by set_region_opcode and set_cell_opcodes - every opcode name/
// value this app ever writes passes through here first.
fn validate_opcode(name: &str, value: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("opcode name cannot be empty".to_string());
    }
    // Matches sfz_parse's own is_new_token_start rule - anything else
    // wouldn't be recognized as a new opcode token on next parse, and
    // would silently continue the previous line's value instead.
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("opcode name can only contain letters, digits, and underscores".to_string());
    }
    if value.contains('\n') || value.contains('\r') {
        return Err("opcode value cannot contain a line break".to_string());
    }
    if value.contains("//") {
        return Err("opcode value cannot contain \"//\" - the parser treats it as a comment".to_string());
    }
    Ok(())
}

// Sets a single opcode on an existing region, identified by its stable
// `regionIndex` (see RegionInfo.index). Editing and adding an opcode are
// the same operation here: within a region's own token loop, a later
// name=value silently overwrites an earlier one (sfz_parse.rs's
// `r.insert(key, value)`), and a region's own opcodes always win over
// inherited global/master/group ones regardless of file position
// (flush_region's merge order) - so appending a new line within the
// target region's span always becomes the winning value on next parse,
// whether that name already existed locally, only existed as an
// inherited default, or never existed on this region at all.
pub fn set_region_opcode(
    working_sfz_path: &Path,
    original_sfz_path: &Path,
    region_index: usize,
    name: &str,
    value: &str
) -> Result<ParsedSfz, String> {
    let name = name.trim();
    validate_opcode(name, value)?;

    if name == "sample" {
        // Relative to the project directory, not the working copy's own
        // (temp, unrelated) directory - see append_region.
        let dir = original_sfz_path
            .parent()
            .ok_or_else(|| "sfz path has no parent directory".to_string())?;
        let resolved = dir.join(value);
        if !resolved.is_file() {
            return Err(format!("sample file not found: {}", resolved.display()));
        }
    }

    let mut text =
        fs::read_to_string(working_sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;
    let mut offset = region_insertion_offset(&text, region_index)?;

    // Same EOF-append guard append_region already needs for its own case -
    // without it, inserting right at the end of a file that doesn't
    // already end in a newline would concatenate directly onto the last
    // existing line with no separator.
    if offset == text.len() && !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
        offset = text.len();
    }

    text.insert_str(offset, &format!("{name}={value}\n"));

    fs::write(working_sfz_path, &text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(working_sfz_path)
}

// Byte offset where a new opcode should land within the file's FIRST
// <global> section (right before the next header, or EOF) - same
// header-is-first-word-of-a-line rule as region_span. None means the file
// has no <global> header at all yet.
fn global_insertion_offset(text: &str) -> Option<usize> {
    let mut offset = 0usize;
    let mut found = false;
    let mut end = 0usize;

    for line in text.split_inclusive('\n') {
        let code = match line.find("//") {
            Some(idx) => &line[..idx],
            None => line
        };
        let first_word = code.split_whitespace().next();
        let is_header = matches!(first_word, Some(w) if w.starts_with('<'));

        if is_header {
            if found {
                return Some(end);
            }
            if first_word == Some("<global>") {
                found = true;
            }
        }
        if found {
            end = offset + line.len();
        }
        offset += line.len();
    }

    if found { Some(end) } else { None }
}

// Sets a single opcode in the file's <global> section - unlike
// set_region_opcode, this affects every region in the file, not just one.
// Editing and adding are the same append-only trick used everywhere else
// in this module: a later name=value line always wins over an earlier one
// for the same key (sfz_parse.rs's `global.insert(key, value)`), so
// appending within the <global> section's own span always becomes the
// winning value on next parse.
//
// A <global> header affects only regions parsed AFTER it (sfz_parse.rs
// accumulates `global` as it scans top-to-bottom, snapshotting it into
// each region as that region is flushed) - so a file with no <global> yet
// gets one created at the very top, guaranteeing it precedes every
// existing region regardless of where they are.
pub fn set_global_opcode(working_sfz_path: &Path, name: &str, value: &str) -> Result<ParsedSfz, String> {
    let name = name.trim();
    validate_opcode(name, value)?;

    let mut text =
        fs::read_to_string(working_sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;

    let mut insert_offset = match global_insertion_offset(&text) {
        Some(offset) => offset,
        None => {
            text.insert_str(0, "<global>\n\n");
            "<global>\n".len()
        }
    };

    if insert_offset == text.len() && !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
        insert_offset = text.len();
    }

    text.insert_str(insert_offset, &format!("{name}={value}\n"));

    fs::write(working_sfz_path, &text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(working_sfz_path)
}

// Applies the same set of opcodes to every region in `region_indices` in
// one file write - used for editing a cell's own criteria (pitch, pitch
// range, volume, articulation) from the SampleEditorPanel, where "the
// cell" is really every region across every take that currently shares
// those criteria, and an edit needs to move all of them together rather
// than splitting the group apart (which is what calling set_region_opcode
// once per region, independently, would risk - see the "accepted
// consequence" note for single-region edits in SampleTakeList.tsx).
//
// Insertion offsets are all computed up front against the ORIGINAL text,
// then applied back-to-front (highest offset first) so inserting at a
// later position never shifts the as-yet-unapplied offset of an earlier
// one - the standard approach for splicing multiple positions into one
// string in a single pass.
pub fn set_cell_opcodes(
    working_sfz_path: &Path,
    region_indices: &[usize],
    opcodes: &[(String, String)]
) -> Result<ParsedSfz, String> {
    for (name, value) in opcodes {
        validate_opcode(name, value)?;
    }

    let mut text =
        fs::read_to_string(working_sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;

    let mut offsets: Vec<usize> = region_indices
        .iter()
        .map(|&idx| region_insertion_offset(&text, idx))
        .collect::<Result<Vec<_>, _>>()?;
    offsets.sort_unstable();
    offsets.dedup();

    let block: String = opcodes
        .iter()
        .map(|(name, value)| format!("{name}={value}\n"))
        .collect();

    for &offset in offsets.iter().rev() {
        let mut insert_offset = offset;
        if insert_offset == text.len() && !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
            insert_offset = text.len();
        }
        text.insert_str(insert_offset, &block);
    }

    fs::write(working_sfz_path, &text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(working_sfz_path)
}

// --- Keyswitch variant, for "Apply to MuseScore" ---
//
// The sw_last=<id> this app's own UI writes (see append_region above) is a
// cosmetic string label used for cell-grouping in Subito's own editor, not
// a functioning SFZ keyswitch - nothing anywhere sets sw_lokey/sw_hikey
// (the opcodes that make a key range act as a switch TRIGGER rather than
// an audible note), so regions with different sw_last values today just
// play simultaneously whenever their key/vel ranges overlap (the correct,
// intentional behavior for e.g. a stereo pair's L/R regions). A real
// keyswitch needs both: a reserved trigger range, and every region tagged
// with a real numeric sw_last inside it.
//
// Rather than rewrite the user's own hand-edited .sfz (whose string
// articulation ids are for Subito's own UI, not real engine switching),
// this generates a separate sibling file purely for MuseScore playback,
// regenerated fresh on every Apply.

#[derive(Serialize)]
pub struct ArticulationNote {
    pub id: String,
    #[serde(rename = "loNote")]
    pub lo_note: u8,
    #[serde(rename = "hiNote")]
    pub hi_note: u8,
}

#[derive(Serialize)]
pub struct KeyswitchSfz {
    #[serde(rename = "derivedPath")]
    pub derived_path: String,
    pub notes: Vec<ArticulationNote>,
}

// Every <region> header position, by the same counting rule region_span
// itself uses - needed here because RegionInfo.index (from
// sfz_parse::parse) only covers regions that have both a sample= opcode
// AND resolvable note info (sfz_parse.rs's region_note/sample= gates); a
// region missing either is invisible to that map but still needs a real
// sw_last once a switch zone exists, or it would keep sounding
// unconditionally regardless of switch state.
fn count_regions(text: &str) -> usize {
    let mut count = 0usize;
    for line in text.lines() {
        let code = match line.find("//") {
            Some(idx) => &line[..idx],
            None => line,
        };
        if code.split_whitespace().next() == Some("<region>") {
            count += 1;
        }
    }
    count
}

// A region's own resolved playable range, per the real SFZ engine
// defaults (lokey defaults to 0, hikey to 127, independently) - NOT the
// same as sfz_parse.rs's own region_key_range, which collapses a lone
// lokey or hikey down to a single point for the UI grid's own display
// purposes. This needs the engine-accurate wide-open range instead, since
// it's deciding whether a region can actually sound in the reserved
// switch zone.
fn region_playable_range(opcodes: &[sfz_parse::OpcodeEntry]) -> (u8, u8) {
    let find = |name: &str| {
        opcodes
            .iter()
            .find(|o| o.name == name)
            .and_then(|o| o.value.parse::<u16>().ok())
    };
    match (find("lokey"), find("hikey")) {
        (Some(lo), Some(hi)) => (lo.min(127) as u8, hi.min(127) as u8),
        (Some(lo), None) => (lo.min(127) as u8, 127),
        (None, Some(hi)) => (0, hi.min(127) as u8),
        (None, None) => match find("key").or_else(|| find("pitch_keycenter")) {
            Some(k) => (k.min(127) as u8, k.min(127) as u8),
            None => (0, 127),
        },
    }
}

pub fn build_keyswitch_variant(original_sfz_path: &Path) -> Result<KeyswitchSfz, String> {
    let parsed = sfz_parse::parse(original_sfz_path)?;

    // Stable order: whatever parse() already returns (numeric ids first,
    // "normal" last - see sfz_parse.rs's own sort). Every distinct
    // articulation, including the implicit "normal" bucket for regions
    // with no sw_last at all, gets a reserved note.
    let ids: Vec<&str> = parsed.articulations.iter().map(|a| a.id.as_str()).collect();
    let n = ids.len();
    if n == 0 {
        return Err("this sfz has no regions to build a keyswitch zone for".to_string());
    }
    // Halved from the old single-note-per-articulation limit of 128 - the
    // zone now reserves TWO notes per articulation (see note_lo_for/
    // note_hi_for below), so it needs twice the room for the same count.
    if n > 64 {
        return Err("too many distinct articulations for a keyswitch zone (max 64)".to_string());
    }
    let n16 = n as u16;
    let zone_size = n16 * 2;

    // Prefer the BOTTOM of the MIDI range (0 upward) - the switch note(s)
    // and the chord's real note(s) are stacked into one simultaneous
    // Chord, and simultaneous notes apparently don't dispatch in document
    // order (confirmed by ear: the switch consistently landed after the
    // note it was meant to affect, with the switch note previously placed
    // at the TOP of the range - i.e. the chord's highest pitch). Falls
    // back to the top of the range only if the bottom has no room - a low
    // bass/extended-range instrument's own real notes are more likely to
    // collide there than at the very top.
    //
    // Deliberately uses the cells' own recorded ANCHOR pitches
    // (region_note() in sfz_parse.rs - what a sample was actually
    // recorded at), not parsed.notes' full lokey..hikey span. A region's
    // outermost lokey=0/hikey=127 is a standard SFZ catch-all convention
    // ("anything below my lowest sample"/"anything above my highest"),
    // not a claim the instrument truly plays those extremes - treating
    // that span as the real range to protect would make nearly every
    // realistic multi-sampled instrument report "no room" immediately.
    let lo_bound = parsed.cells.iter().map(|c| c.note).min();
    let hi_bound = parsed.cells.iter().map(|c| c.note).max();
    let (switch_lo, switch_hi): (u8, u8) = if lo_bound.map(|lo| (lo as u16) >= zone_size).unwrap_or(true) {
        (0, (zone_size - 1) as u8)
    } else if hi_bound.map(|hi| (hi as u16) < 128 - zone_size).unwrap_or(true) {
        ((128 - zone_size) as u8, 127)
    } else {
        return Err(
            "no room for a keyswitch zone - this instrument already uses the full MIDI range".to_string()
        );
    };

    // Picking the "lowest pitch in the chord" as the switch note (above)
    // was itself meant to win a dispatch-order race against the chord's
    // real note(s), on the theory that simultaneous notes dispatch in
    // pitch-ascending order - confirmed to help, but not reliably enough:
    // real scores still showed the first note after a genuine articulation
    // change sounding like the OLD one, meaning the single lowest-pitch
    // switch note sometimes still loses that race. Lacking any actual
    // documentation of MuseScore/the synth's real dispatch order, this
    // hedges both directions at once instead of betting on one: every
    // articulation gets TWO reserved notes, one packed from the bottom of
    // the zone (note_lo_for) and one from the top (note_hi_for) - each
    // chord then fires both (see inject_keyswitches), so whichever
    // extreme actually does dispatch first, a switch note is there to win
    // the race. SFZ's own sw_last only matches a single value per region,
    // so there's no way for one playable region to respond to either
    // trigger note - every affected region is instead fully DUPLICATED
    // (one copy per trigger note) rather than just getting a second
    // inserted opcode line; see the appended-regions handling below.
    let note_lo_for: HashMap<&str, u8> = ids
        .iter()
        .enumerate()
        .map(|(i, &id)| (id, switch_lo + i as u8))
        .collect();
    let note_hi_for: HashMap<&str, u8> = ids
        .iter()
        .enumerate()
        .map(|(i, &id)| (id, switch_lo + n16 as u8 + i as u8))
        .collect();

    // Every region's resolved articulation and opcodes, per sfz_parse's own
    // cascading - no need to reimplement global/master/group inheritance
    // here.
    let mut region_articulation: HashMap<usize, &str> = HashMap::new();
    let mut region_opcodes: HashMap<usize, &Vec<sfz_parse::OpcodeEntry>> = HashMap::new();
    for cell in &parsed.cells {
        for take in &cell.samples {
            for region in &take.regions {
                region_articulation.insert(region.index, cell.articulation.as_str());
                region_opcodes.insert(region.index, &region.opcodes);
            }
        }
    }

    let text = fs::read_to_string(original_sfz_path).map_err(|e| format!("failed to read file: {e}"))?;
    let total_regions = count_regions(&text);

    let mut inserts: Vec<(usize, String)> = Vec::with_capacity(total_regions);
    // Full-text duplicates of every affected region, one per region, each
    // gated on the HI trigger note instead of the LO one - appended once at
    // the very end of the file (see below) rather than spliced in-place,
    // since a whole extra region doesn't need to sit next to its original
    // the way a few extra opcode lines do.
    let mut appended_regions = String::new();
    for idx in 0..total_regions {
        let articulation_id = region_articulation.get(&idx).copied().unwrap_or("normal");
        let lo_note = *note_lo_for.get(articulation_id).unwrap_or(&switch_lo);
        let hi_note = *note_hi_for.get(articulation_id).unwrap_or(&switch_lo);
        let offset = region_insertion_offset(&text, idx)?;

        // sw_lokey/sw_hikey only mark a trigger range - they don't stop a
        // region whose OWN playable lokey/hikey also reaches into it from
        // actually sounding there too (confirmed by ear: every switch note
        // produced an audible click, a real sample firing wildly
        // pitch-shifted at the reserved pitch). A region missing from
        // region_opcodes (no sample=/note info - see count_regions) is
        // unknown, so it's treated as worst-case full-range rather than
        // silently left unclamped. Shared verbatim by both the lo and hi
        // copies of this region - it depends only on the region's own
        // playable range and the zone's position, not on which trigger
        // note is being assigned.
        let (lo, hi) = region_opcodes
            .get(&idx)
            .map(|opcodes| region_playable_range(opcodes))
            .unwrap_or((0, 127));
        let mut key_clamp = String::new();
        if switch_hi == 127 {
            // Zone at the top (switch_lo..127) - only clamp down if this
            // region's own high end reaches up into it; its own lo is
            // reasserted unchanged so a single key= region doesn't
            // accidentally widen into a range.
            if hi >= switch_lo {
                let clamped_hi = switch_lo.saturating_sub(1).min(hi);
                key_clamp.push_str(&format!("lokey={lo}\nhikey={clamped_hi}\n"));
            }
        } else if lo <= switch_hi {
            // Zone at the bottom (0..switch_hi).
            let clamped_lo = switch_hi.saturating_add(1).max(lo);
            key_clamp.push_str(&format!("lokey={clamped_lo}\nhikey={hi}\n"));
        }

        let lo_snippet =
            format!("sw_lokey={switch_lo}\nsw_hikey={switch_hi}\nsw_last={lo_note}\n{key_clamp}");
        inserts.push((offset, lo_snippet));

        // The hi-note trigger needs its own full copy of the region (not
        // just another inserted opcode line) since SFZ's sw_last only ever
        // matches ONE value per region - there's no "OR" form that would
        // let a single region answer to both trigger notes. Note that this
        // intentionally keeps the region's own ORIGINAL cosmetic
        // sw_last=<id> text opcode (see this section's own top comment) -
        // the real numeric sw_last appended after it still wins on parse,
        // same as the lo copy above.
        if let Ok((region_start, region_end)) = region_span(&text, idx) {
            appended_regions.push_str(&text[region_start..region_end]);
            if !appended_regions.ends_with('\n') {
                appended_regions.push('\n');
            }
            appended_regions.push_str(&format!(
                "sw_lokey={switch_lo}\nsw_hikey={switch_hi}\nsw_last={hi_note}\n{key_clamp}"
            ));
        }
    }
    // Descending, so each splice doesn't invalidate the offsets of
    // inserts still waiting to be applied (same discipline as
    // set_cell_opcodes above).
    inserts.sort_by(|a, b| b.0.cmp(&a.0));

    let mut new_text = text;
    for (offset, snippet) in inserts {
        new_text.insert_str(offset, &snippet);
    }
    new_text.push_str(&appended_regions);

    let stem = original_sfz_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("instrument");
    let derived_path = original_sfz_path.with_file_name(format!("{stem}.musescore.sfz"));
    fs::write(&derived_path, &new_text).map_err(|e| format!("failed to write keyswitch sfz: {e}"))?;

    let notes = ids
        .iter()
        .map(|&id| ArticulationNote {
            id: id.to_string(),
            lo_note: note_lo_for[id],
            hi_note: note_hi_for[id],
        })
        .collect();

    Ok(KeyswitchSfz {
        derived_path: derived_path.to_string_lossy().to_string(),
        notes,
    })
}
