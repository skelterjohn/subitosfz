use std::io::Write;

use axum::{routing::get, Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

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

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/health", get(health))
        .layer(CorsLayer::new().allow_origin(Any).allow_methods(Any));

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
