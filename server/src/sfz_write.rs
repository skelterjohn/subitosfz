// The app's first (and deliberately narrow) .sfz write capability: append
// one new <region> to an existing file as plain text, then re-parse.
//
// sfz_parse.rs is a lossy, flattening parser by design (block structure
// isn't retained once regions are cascaded) - there is no general
// "reconstruct the whole file" round-trip anywhere, and building one is a
// separate, bigger undertaking than this needs. Appending new text is
// additive and never touches what's already there, so it doesn't need one.
use std::fs;
use std::path::Path;

use crate::sfz_parse::{self, ParsedSfz};

pub fn append_region(
    sfz_path: &Path,
    sample_path: &str,
    note: u8,
    articulation_id: &str,
    articulation_label: Option<&str>,
    velocity: u8
) -> Result<ParsedSfz, String> {
    let dir = sfz_path
        .parent()
        .ok_or_else(|| "sfz path has no parent directory".to_string())?;
    let resolved_sample = dir.join(sample_path);
    if !resolved_sample.is_file() {
        return Err(format!("sample file not found: {}", resolved_sample.display()));
    }

    let mut text = fs::read_to_string(sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;
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
    // key= alone is enough (SFZ shorthand for lokey=hikey=pitch_keycenter),
    // but lokey/hikey are written explicitly too so region_key_range (and
    // the UI's own "region" opcode section) see them directly rather than
    // falling back to deriving them from key=.
    text.push_str(&format!("key={note}\n"));
    text.push_str(&format!("lokey={note}\n"));
    text.push_str(&format!("hikey={note}\n"));
    text.push_str(&format!("lovel={velocity}\n"));
    text.push_str(&format!("hivel={velocity}\n"));
    text.push_str(&format!("sw_last={articulation_id}\n"));
    text.push_str(&format!("sw_label={label}\n"));

    fs::write(sfz_path, text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(sfz_path)
}

// Byte offset where new text should land within the target region's own
// span - right before the next <...> header line (mirrors sfz_parse's
// flush_region, which flushes on ANY header token, not just <region>), or
// at the end of the file if the target is the last region. A header is
// only recognized as the first whitespace-separated word of a line (after
// stripping a trailing `//` comment) - true of everything this app's own
// writers emit and the common hand-authored convention, but not a full
// reimplementation of sfz_parse's word-level tokenizer.
fn region_insertion_offset(text: &str, target_index: usize) -> Result<usize, String> {
    let mut region_count = 0usize;
    let mut in_target = false;
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
                return Ok(offset);
            }
            if first_word == Some("<region>") {
                if region_count == target_index {
                    in_target = true;
                }
                region_count += 1;
            }
        }

        offset += line.len();
    }

    if in_target {
        Ok(offset)
    } else {
        let plural = if region_count == 1 { "" } else { "s" };
        Err(format!(
            "region index {target_index} out of range (file has {region_count} region{plural})"
        ))
    }
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
    sfz_path: &Path,
    region_index: usize,
    name: &str,
    value: &str
) -> Result<ParsedSfz, String> {
    let name = name.trim();
    validate_opcode(name, value)?;

    if name == "sample" {
        let dir = sfz_path
            .parent()
            .ok_or_else(|| "sfz path has no parent directory".to_string())?;
        let resolved = dir.join(value);
        if !resolved.is_file() {
            return Err(format!("sample file not found: {}", resolved.display()));
        }
    }

    let mut text = fs::read_to_string(sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;
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

    fs::write(sfz_path, &text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(sfz_path)
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
    sfz_path: &Path,
    region_indices: &[usize],
    opcodes: &[(String, String)]
) -> Result<ParsedSfz, String> {
    for (name, value) in opcodes {
        validate_opcode(name, value)?;
    }

    let mut text = fs::read_to_string(sfz_path).map_err(|e| format!("failed to read sfz file: {e}"))?;

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

    fs::write(sfz_path, &text).map_err(|e| format!("failed to write sfz file: {e}"))?;

    sfz_parse::parse(sfz_path)
}
