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
const SILENCE_THRESHOLD_DBFS: f64 = -40.0;
// Minimum silent gap to count as a real split point - shorter dips (a
// dynamic swell momentarily dropping) must not fragment one note in two.
const MIN_SILENCE_MS: f64 = 250.0;
// Minimum surviving chunk length - filters out stray clicks/bleed that
// briefly cross the threshold.
const MIN_CHUNK_MS: f64 = 120.0;
// Silence re-added around each trimmed chunk's edges so the attack
// transient and a touch of natural decay aren't clipped flush to the
// threshold crossing.
const PAD_MS: f64 = 30.0;

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

// Frame ranges [start, end) of the non-silent chunks, in source order,
// padded and guaranteed non-overlapping.
fn detect_chunks(raw: &RawSamples, spec: &WavSpec) -> Vec<(usize, usize)> {
    let channels = spec.channels as usize;
    let total_frames = raw.len() / channels;
    if total_frames == 0 {
        return Vec::new();
    }

    let window_frames = ((spec.sample_rate as f64 * ANALYSIS_WINDOW_MS / 1000.0) as usize).max(1);
    let threshold = 10f64.powf(SILENCE_THRESHOLD_DBFS / 20.0);
    let window_count = total_frames.div_ceil(window_frames);

    let mut window_silent = vec![false; window_count];
    for (w, silent) in window_silent.iter_mut().enumerate() {
        let start = w * window_frames;
        let end = (start + window_frames).min(total_frames);
        let mut sum_sq = 0f64;
        for frame in start..end {
            let peak = frame_peak(raw, frame, channels, spec.bits_per_sample);
            sum_sq += peak * peak;
        }
        let rms = (sum_sq / (end - start) as f64).sqrt();
        *silent = rms < threshold;
    }

    let min_silence_windows = ((MIN_SILENCE_MS / ANALYSIS_WINDOW_MS).ceil() as usize).max(1);
    let min_chunk_frames = ((spec.sample_rate as f64 * MIN_CHUNK_MS / 1000.0) as usize).max(1);
    let pad_frames = (spec.sample_rate as f64 * PAD_MS / 1000.0) as usize;

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

        let start_frame = raw_start.saturating_sub(pad_frames).max(prev_end_frame);
        let end_frame = (raw_end + pad_frames).min(total_frames).min(next_raw_start);

        if end_frame > start_frame && (end_frame - start_frame) >= min_chunk_frames {
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
    let dest_dir = sfz_path
        .parent()
        .ok_or_else(|| "sfz path has no parent directory".to_string())?;

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

    let existing: HashSet<String> = fs::read_dir(dest_dir)
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
            let candidate = format!("{:03}_{}.wav", index, safe_base);
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
            file_name,
            duration_sec: (end_frame - start_frame) as f64 / spec.sample_rate as f64
        });
    }

    Ok(summaries)
}
