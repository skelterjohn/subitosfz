use std::io::Write;
use std::path::PathBuf;

use axum::{http::StatusCode, routing::get, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

mod sf2;
mod sfz_parse;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Deserialize)]
struct Sf2PresetsRequest {
    path: String,
}

#[derive(Serialize)]
struct Sf2PresetsResponse {
    presets: Vec<sf2::PresetSummary>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn sf2_presets(
    Json(req): Json<Sf2PresetsRequest>,
) -> Result<Json<Sf2PresetsResponse>, (StatusCode, Json<ErrorResponse>)> {
    sf2::list_presets(&PathBuf::from(req.path))
        .map(|presets| Json(Sf2PresetsResponse { presets }))
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct Sf2ExportRequest {
    path: String,
    #[serde(rename = "presetIndex")]
    preset_index: usize,
    #[serde(rename = "destDir")]
    dest_dir: String,
    #[serde(rename = "instrumentName")]
    instrument_name: String,
}

async fn sf2_export(
    Json(req): Json<Sf2ExportRequest>,
) -> Result<Json<sf2::ExportResult>, (StatusCode, Json<ErrorResponse>)> {
    sf2::export_preset(
        &PathBuf::from(req.path),
        req.preset_index,
        &PathBuf::from(req.dest_dir),
        &req.instrument_name,
    )
    .map(Json)
    .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[derive(Deserialize)]
struct SfzParseRequest {
    path: String,
}

async fn sfz_parse_handler(
    Json(req): Json<SfzParseRequest>,
) -> Result<Json<sfz_parse::ParsedSfz>, (StatusCode, Json<ErrorResponse>)> {
    sfz_parse::parse(&PathBuf::from(req.path))
        .map(Json)
        .map_err(|error| (StatusCode::BAD_REQUEST, Json(ErrorResponse { error })))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .route("/sf2/presets", post(sf2_presets))
        .route("/sf2/export", post(sf2_export))
        .route("/sfz/parse", post(sfz_parse_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
        );

    // Bind to port 0 so the OS picks a free port, then announce it on stdout
    // so the Electron parent process knows where to send requests.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("failed to bind local port");
    let port = listener.local_addr().unwrap().port();

    println!("SUBITOSFZ_SERVER_PORT={port}");
    std::io::stdout().flush().ok();

    axum::serve(listener, app).await.expect("server error");
}
