// Silence-based chunking for a purpose-recorded "long take": given one WAV
// containing many successive independent sounds, split it into individual
// non-silent segments and write each out as its own standalone WAV file
// into the project directory (the .sfz's own folder) - the first step of
// turning a recording into samples the grid can assign pitch/articulation/
// velocity to. Chunks are bit-identical slices of the source (same spec,
// same sample type), never re-quantized - only the *analysis* used to find
// chunk boundaries works in normalized float.
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use serde::Serialize;

use crate::sf2::sanitize_filename;

const ANALYSIS_WINDOW_MS: f64 = 10.0;
// The silence threshold is adaptive, not fixed: a decaying note fades
// gradually and a single fixed dBFS line (e.g. -40) cuts it off wherever it
// happens to cross that line, which is usually well before the note is
// actually inaudible against this recording's own background noise. Instead
// we estimate the noise floor from the quietest windows in the file (most
// of a long take is silence between notes) and only call a window silent
// once it's back down near that floor.
//
// Percentile of window RMS values (sorted ascending) used as the floor
// estimate - low enough to sit in the true noise floor, not so low (e.g.
// the literal minimum) that one freak near-zero window skews it.
const NOISE_FLOOR_PERCENTILE: f64 = 0.15;
// How far above the estimated floor a window must be to still count as
// "sound" - small enough that a decay is allowed to ring down close to the
// floor before being called silent, large enough to not trigger on floor
// noise itself.
const NOISE_FLOOR_MARGIN_DB: f64 = 9.0;
// Clamp the resulting threshold so a bad floor estimate (e.g. a very clean
// or very noisy recording) can't produce something pathological: never so
// low that background noise alone reads as signal forever, never so high
// that we regress past the old fixed-threshold behavior.
const SILENCE_THRESHOLD_MIN_DBFS: f64 = -70.0;
const SILENCE_THRESHOLD_MAX_DBFS: f64 = -35.0;
// A separate, larger margin above the floor that a run must actually PEAK
// above to be accepted as a real sound at all - distinct from
// NOISE_FLOOR_MARGIN_DB above, which only decides where a chunk's
// boundaries sit once it's already been accepted. Needed because lowering
// the boundary threshold enough to track a decay tail down near the floor
// also makes the detector sensitive enough to pick up ordinary ambient
// noise (room tone, pre-roll hiss/thumps) as if it were a note - a run has
// to clearly stand out from the floor, not just nudge above it, to count.
const PEAK_ACCEPTANCE_MARGIN_DB: f64 = 22.0;
// Minimum silent gap to count as a real split point - shorter dips (a
// dynamic swell momentarily dropping) must not fragment one note in two.
const MIN_SILENCE_MS: f64 = 250.0;
// Minimum surviving chunk length - filters out stray clicks/bleed that
// briefly cross the threshold.
const MIN_CHUNK_MS: f64 = 120.0;
// Silence re-added around each trimmed chunk's edges so the attack
// transient and a touch of natural decay aren't clipped flush to the
// threshold crossing. Asymmetric: an attack crosses the threshold sharply
// so it needs very little lead-in, while a decay fades gradually below
// threshold while still audibly ringing, so it needs a much longer tail.
const PAD_START_MS: f64 = 12.0;
const PAD_END_MS: f64 = 150.0;

#[derive(Serialize)]
pub struct ChunkSummary {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "durationSec")]
    pub duration_sec: f64,
}

enum RawSamples {
    Int(Vec<i32>),
    Float(Vec<f32>),
}

impl RawSamples {
    fn len(&self) -> usize {
        match self {
            RawSamples::Int(v) => v.len(),
            RawSamples::Float(v) => v.len(),
        }
    }
}

// Normalized peak (~[-1, 1]) across all channels of one frame, for
// *analysis only* - never used for the bytes written back out, which
// always come straight from the original interleaved samples untouched.
fn frame_peak(raw: &RawSamples, frame_index: usize, channels: usize, bits_per_sample: u16) -> f64 {
    let mut peak = 0f64;
    for ch in 0..channels {
        let idx = frame_index * channels + ch;
        let v = match raw {
            RawSamples::Int(v) => {
                let full_scale = (1i64 << (bits_per_sample - 1)) as f64;
                v[idx] as f64 / full_scale
            }
            RawSamples::Float(v) => v[idx] as f64,
        };
        peak = peak.max(v.abs());
    }
    peak
}

fn rms_to_dbfs(rms: f64) -> f64 {
    if rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

// Estimates this recording's own background noise floor from its quietest
// analysis windows - see the NOISE_FLOOR_* constants for why detection is
// adaptive rather than built around a single fixed dBFS line.
fn noise_floor_dbfs(window_rms: &[f64]) -> f64 {
    let mut sorted = window_rms.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let floor_index = ((sorted.len() as f64 * NOISE_FLOOR_PERCENTILE) as usize).min(sorted.len() - 1);
    rms_to_dbfs(sorted[floor_index])
}

fn silence_threshold_dbfs(floor_dbfs: f64) -> f64 {
    (floor_dbfs + NOISE_FLOOR_MARGIN_DB).clamp(SILENCE_THRESHOLD_MIN_DBFS, SILENCE_THRESHOLD_MAX_DBFS)
}

// Linear RMS threshold a fixed margin above the estimated floor - the
// boundary threshold used to classify individual windows as silent/not.
// Only exercised directly by tests against synthetic window-RMS data;
// detect_chunks below inlines the same two calls itself since it also needs
// the intermediate floor_dbfs for the peak-acceptance gate.
#[cfg(test)]
fn adaptive_silence_threshold(window_rms: &[f64]) -> f64 {
    10f64.powf(silence_threshold_dbfs(noise_floor_dbfs(window_rms)) / 20.0)
}

// Frame ranges [start, end) of the non-silent chunks, in source order,
// padded and guaranteed non-overlapping.
fn detect_chunks(raw: &RawSamples, spec: &WavSpec) -> Vec<(usize, usize)> {
    let channels = spec.channels as usize;
    let total_frames = raw.len() / channels;
    if total_frames == 0 {
        return Vec::new();
    }

    let window_frames = ((spec.sample_rate as f64 * ANALYSIS_WINDOW_MS / 1000.0) as usize).max(1);
    let window_count = total_frames.div_ceil(window_frames);

    let mut window_rms = vec![0f64; window_count];
    for (w, rms) in window_rms.iter_mut().enumerate() {
        let start = w * window_frames;
        let end = (start + window_frames).min(total_frames);
        let mut sum_sq = 0f64;
        for frame in start..end {
            let peak = frame_peak(raw, frame, channels, spec.bits_per_sample);
            sum_sq += peak * peak;
        }
        *rms = (sum_sq / (end - start) as f64).sqrt();
    }

    let floor_dbfs = noise_floor_dbfs(&window_rms);
    let threshold = 10f64.powf(silence_threshold_dbfs(floor_dbfs) / 20.0);
    let window_silent: Vec<bool> = window_rms.iter().map(|&rms| rms < threshold).collect();
    // A run must peak at least this far above the floor to be accepted as a
    // real sound, not just a window-by-window nudge over the (much lower)
    // boundary threshold above - see PEAK_ACCEPTANCE_MARGIN_DB.
    let peak_acceptance_dbfs = floor_dbfs + PEAK_ACCEPTANCE_MARGIN_DB;

    let min_silence_windows = ((MIN_SILENCE_MS / ANALYSIS_WINDOW_MS).ceil() as usize).max(1);
    let min_chunk_frames = ((spec.sample_rate as f64 * MIN_CHUNK_MS / 1000.0) as usize).max(1);
    let pad_start_frames = (spec.sample_rate as f64 * PAD_START_MS / 1000.0) as usize;
    let pad_end_frames = (spec.sample_rate as f64 * PAD_END_MS / 1000.0) as usize;

    // First pass: raw (unpadded) non-silent runs, as window-index ranges,
    // merging across any silent gap shorter than min_silence_windows so a
    // momentary dip mid-note doesn't split one sound into two.
    let mut raw_runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < window_count {
        if window_silent[i] {
            i += 1;
            continue;
        }
        let run_start = i;
        let mut run_end = i + 1;
        loop {
            let gap_start = run_end;
            let mut gap_end = run_end;
            while gap_end < window_count && window_silent[gap_end] {
                gap_end += 1;
            }
            if gap_end >= window_count || (gap_end - gap_start) >= min_silence_windows {
                break;
            }
            // Short gap - absorb it and keep extending the run past it.
            run_end = gap_end;
            while run_end < window_count && !window_silent[run_end] {
                run_end += 1;
            }
        }
        raw_runs.push((run_start, run_end));
        i = run_end;
    }

    // Second pass: pad each run's frame range, clamped against the
    // *previously emitted* chunk's actual end and the *next run's* raw
    // (unpadded) start, so padding from neighboring chunks can never
    // overlap even when the silent gap between them is shorter than
    // 2 * PAD_MS.
    let mut chunks: Vec<(usize, usize)> = Vec::new();
    let mut prev_end_frame = 0usize;
    for (idx, &(ws, we)) in raw_runs.iter().enumerate() {
        let raw_start = ws * window_frames;
        let raw_end = (we * window_frames).min(total_frames);
        let next_raw_start = raw_runs
            .get(idx + 1)
            .map(|&(nws, _)| nws * window_frames)
            .unwrap_or(total_frames);

        let start_frame = raw_start.saturating_sub(pad_start_frames).max(prev_end_frame);
        let end_frame = (raw_end + pad_end_frames).min(total_frames).min(next_raw_start);

        let run_peak_dbfs = rms_to_dbfs(window_rms[ws..we].iter().cloned().fold(0f64, f64::max));
        let is_real_sound = run_peak_dbfs >= peak_acceptance_dbfs;

        if is_real_sound && end_frame > start_frame && (end_frame - start_frame) >= min_chunk_frames {
            chunks.push((start_frame, end_frame));
            prev_end_frame = end_frame;
        } else {
            // Dropped as too short - still advance the floor so a
            // subsequent run's left-padding can't reach back into it.
            prev_end_frame = raw_end.max(prev_end_frame);
        }
    }

    chunks
}

pub fn chunk_wav(sfz_path: &Path, source_path: &Path, base_name: &str) -> Result<Vec<ChunkSummary>, String> {
    let project_dir = sfz_path
        .parent()
        .ok_or_else(|| "sfz path has no parent directory".to_string())?;

    // Chunks from one long take live together in their own subdirectory,
    // named after the source recording - keeps imports from different
    // sessions from piling every .wav into the project root, and keeps two
    // takes that happen to share a sample-naming prefix (the editable
    // base_name) from colliding on disk.
    let source_stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "source path has no file name".to_string())?;
    let subdir_name = sanitize_filename(source_stem);
    let dest_dir = project_dir.join(&subdir_name);
    fs::create_dir_all(&dest_dir).map_err(|e| format!("failed to create destination directory: {e}"))?;

    let mut reader = WavReader::open(source_path).map_err(|e| format!("failed to open wav: {e}"))?;
    let spec = reader.spec();
    let raw = match spec.sample_format {
        SampleFormat::Int => RawSamples::Int(
            reader
                .samples::<i32>()
                .collect::<Result<Vec<i32>, _>>()
                .map_err(|e| format!("failed to read samples: {e}"))?
        ),
        SampleFormat::Float => RawSamples::Float(
            reader
                .samples::<f32>()
                .collect::<Result<Vec<f32>, _>>()
                .map_err(|e| format!("failed to read samples: {e}"))?
        )
    };

    let ranges = detect_chunks(&raw, &spec);
    if ranges.is_empty() {
        return Err("no non-silent audio found in the source file".to_string());
    }

    let existing: HashSet<String> = fs::read_dir(&dest_dir)
        .map_err(|e| format!("failed to read destination directory: {e}"))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();

    let safe_base = sanitize_filename(base_name);
    let channels = spec.channels as usize;
    let mut summaries = Vec::new();
    let mut index = 1u32;

    for (start_frame, end_frame) in ranges {
        let file_name = loop {
            let candidate = format!("{}_{:03}.wav", safe_base, index);
            index += 1;
            if !existing.contains(&candidate) {
                break candidate;
            }
        };

        let mut writer = WavWriter::create(dest_dir.join(&file_name), spec)
            .map_err(|e| format!("failed to create wav: {e}"))?;
        match &raw {
            RawSamples::Int(samples) => {
                for &s in &samples[start_frame * channels..end_frame * channels] {
                    writer
                        .write_sample(s)
                        .map_err(|e| format!("failed to write sample: {e}"))?;
                }
            }
            RawSamples::Float(samples) => {
                for &s in &samples[start_frame * channels..end_frame * channels] {
                    writer
                        .write_sample(s)
                        .map_err(|e| format!("failed to write sample: {e}"))?;
                }
            }
        }
        writer.finalize().map_err(|e| e.to_string())?;

        summaries.push(ChunkSummary {
            // Relative to the project dir (sfz_path's parent), not just the
            // subdirectory - this is what ends up in sample= and every
            // other place downstream that resolves it against the project
            // root (readAudioFile, deleteSampleFile, the drawer's diff).
            file_name: format!("{subdir_name}/{file_name}"),
            duration_sec: (end_frame - start_frame) as f64 / spec.sample_rate as f64
        });
    }

    Ok(summaries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_spec(sample_rate: u32) -> WavSpec {
        WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float
        }
    }

    #[test]
    fn ambient_noise_bump_is_not_mistaken_for_a_note() {
        // Reproduces a real regression: lowering the boundary threshold to
        // track decay tails also made a quiet, 1.5s ambient pre-roll bump
        // (peaking ~16dB above floor, well below a real attack) get
        // detected as a leading "silent" chunk. It must now be rejected
        // entirely by the peak-acceptance gate.
        let sample_rate = 44_100u32;
        let floor_amp = 10f64.powf(-56.0 / 20.0) as f32;
        let bump_amp = 10f64.powf(-40.0 / 20.0) as f32; // ~16dB above floor

        let mut samples: Vec<f32> = Vec::new();
        samples.extend(std::iter::repeat(floor_amp).take(sample_rate as usize));
        samples.extend(std::iter::repeat(bump_amp).take((sample_rate as f64 * 1.5) as usize));
        samples.extend(std::iter::repeat(floor_amp).take(sample_rate as usize * 3));

        let raw = RawSamples::Float(samples);
        let chunks = detect_chunks(&raw, &make_spec(sample_rate));
        assert!(chunks.is_empty(), "ambient bump should not produce any chunks, got {chunks:?}");
    }

    #[test]
    fn a_real_attack_well_above_the_bump_level_is_still_accepted() {
        let sample_rate = 44_100u32;
        let floor_amp = 10f64.powf(-56.0 / 20.0) as f32;
        let note_amp = 10f64.powf(-20.0 / 20.0) as f32; // clearly a real note

        let mut samples: Vec<f32> = Vec::new();
        samples.extend(std::iter::repeat(floor_amp).take(sample_rate as usize));
        samples.extend(std::iter::repeat(note_amp).take(sample_rate as usize));
        samples.extend(std::iter::repeat(floor_amp).take(sample_rate as usize));

        let raw = RawSamples::Float(samples);
        let chunks = detect_chunks(&raw, &make_spec(sample_rate));
        assert_eq!(chunks.len(), 1, "a real attack should still be detected, got {chunks:?}");
    }

    #[test]
    fn adaptive_threshold_tracks_below_the_old_fixed_threshold_for_a_quiet_recording() {
        // Mostly background noise around -55dBFS (typical room/preamp
        // floor), plus a block of loud "note" windows.
        let mut window_rms = vec![10f64.powf(-55.0 / 20.0); 200];
        window_rms.extend(vec![10f64.powf(-6.0 / 20.0); 20]);

        let threshold_dbfs = rms_to_dbfs(adaptive_silence_threshold(&window_rms));

        // Should sit near this recording's own floor plus the margin, well
        // below the old fixed -40dBFS line - this is what lets a decaying
        // note keep being tracked much closer to its true noise floor
        // instead of being cut off at an arbitrary level.
        assert!(threshold_dbfs < -40.0, "threshold {threshold_dbfs} should be below the old fixed -40dBFS");
        assert!(threshold_dbfs > -55.0, "threshold {threshold_dbfs} should still sit above the floor itself");
    }

    #[test]
    fn adaptive_threshold_is_capped_for_a_noisy_recording() {
        // A recording whose background itself sits at -20dBFS (heavy hiss/
        // room tone) must not push the threshold above the ceiling - that
        // would start misclassifying real signal as silence.
        let window_rms = vec![10f64.powf(-20.0 / 20.0); 200];
        let threshold_dbfs = rms_to_dbfs(adaptive_silence_threshold(&window_rms));
        assert!(threshold_dbfs <= SILENCE_THRESHOLD_MAX_DBFS);
    }

    #[test]
    fn decay_tail_is_tracked_further_than_the_old_fixed_threshold_would_allow() {
        // One second of near-silence (floor), a loud onset, then an
        // exponential decay back toward the floor, then more near-silence.
        let sample_rate = 44_100u32;
        let floor_amp = 10f64.powf(-55.0 / 20.0) as f32;
        let mut samples: Vec<f32> = Vec::new();

        let lead_in_frames = sample_rate as usize; // 1s of floor noise
        samples.extend(std::iter::repeat(floor_amp).take(lead_in_frames));

        let decay_frames = sample_rate as usize * 2; // 2s decay
        let peak_amp = 0.5f32;
        let tau = decay_frames as f64 / 6.0; // ~6 time constants over the window
        for i in 0..decay_frames {
            let amp = (peak_amp as f64 * (-(i as f64) / tau).exp()).max(floor_amp as f64) as f32;
            samples.push(amp);
        }

        let tail_frames = sample_rate as usize; // 1s of floor noise
        samples.extend(std::iter::repeat(floor_amp).take(tail_frames));

        let raw = RawSamples::Float(samples);
        let spec = WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 32,
            sample_format: SampleFormat::Float
        };

        let chunks = detect_chunks(&raw, &spec);
        assert_eq!(chunks.len(), 1, "expected exactly one detected note, got {chunks:?}");
        let (start, end) = chunks[0];
        let detected_decay_frames = end - start;

        // At the old fixed -40dBFS threshold, the run would end once the
        // decay first drops below 0.01 amplitude - solve exp(-i/tau) = 0.02
        // (0.01 / peak_amp) for i.
        let old_threshold_crossing = (-tau * (0.01f64 / peak_amp as f64).ln()) as usize;

        assert!(
            detected_decay_frames > old_threshold_crossing,
            "adaptive detection ({detected_decay_frames} frames) should track the decay further than the old fixed threshold would ({old_threshold_crossing} frames)"
        );
    }
}
