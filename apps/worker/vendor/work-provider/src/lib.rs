//! Work's provider contracts and discovery; independent of Tauri, databases and OS credentials.
pub mod catalog;
pub mod discovery;
pub mod types;

pub use catalog::{catalog, definition};
pub use discovery::{prepare, HttpResponse, ProviderHttp, MAX_RESPONSE_BYTES};
pub use types::*;

pub mod generation;
pub mod limits;
pub mod tools;
pub mod usage;

pub mod pricing;
