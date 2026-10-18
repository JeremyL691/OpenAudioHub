use std::process::ExitCode;

use oah::{AppState, Config, db};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("OAH_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            return ExitCode::from(2);
        }
    };
    if let Some(dir) = config.database_path.parent()
        && let Err(e) = std::fs::create_dir_all(dir)
    {
        eprintln!("cannot create data folder {}: {e}", dir.display());
        return ExitCode::from(2);
    }
    let pool = match db::open(&config.database_path).await {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "cannot open database {}: {e}",
                config.database_path.display()
            );
            return ExitCode::from(2);
        }
    };
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        [] | ["serve"] => {}
        ["reset-password", email] => {
            let result = oah::cli::reset_password(&pool, email).await;
            pool.close().await;
            return match result {
                Ok(password) => {
                    println!("New password for {email}: {password}");
                    println!("All sessions of this account were signed out.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("reset-password: {e}");
                    ExitCode::FAILURE
                }
            };
        }
        _ => {
            eprintln!("usage: oah-server [serve]\n       oah-server reset-password <email>");
            return ExitCode::from(2);
        }
    }
    let listener = match tokio::net::TcpListener::bind(config.listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on {}: {e}", config.listen);
            return ExitCode::from(2);
        }
    };
    tracing::info!(addr = %config.listen, "listening");
    let state = AppState::new(config, pool.clone());
    oah::start_workers(&state);
    let app = oah::app(state);
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await;
    pool.close().await;
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("server error: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler can be installed");
        tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = ctrl_c.await;
    tracing::info!("shutting down");
}
