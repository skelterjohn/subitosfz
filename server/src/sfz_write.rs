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
