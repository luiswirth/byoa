//! The byoa relay as a program: it listens at `BYOA_ADDRESS`, by default
//! 127.0.0.1:8790, and keeps its sessions in the database at
//! `BYOA_DATABASE`, or in memory without one.

use std::env;
use std::error::Error;
use std::path::PathBuf;

use byoa_relay::Relay;
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let address = env::var("BYOA_ADDRESS").unwrap_or_else(|_| "127.0.0.1:8790".to_owned());
    let database = env::var_os("BYOA_DATABASE").map(PathBuf::from);
    let relay = Relay::open(database.as_deref())?;
    tokio::spawn(relay.clone().expire());
    let listener = TcpListener::bind(&address).await?;
    axum::serve(listener, relay.router()).await?;
    Ok(())
}
