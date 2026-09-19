//! Language-neutral replay infrastructure shared by the Rust conformance
//! binaries: strict JSON, the protocol schema interpreter, the coordinator
//! transport, corpus/inventory discovery, the JSONL report and the witness
//! evidence check. Cache drivers plug into [`transport::Coordinator::execute`].
//!
//! Each `tests/*.rs` binary includes this directory as a module and uses a
//! different subset of it, so unused-item lints are silenced here rather than
//! per binary.
#![allow(dead_code)]

pub mod core_driver;
pub mod driver;
pub mod gate;
pub mod inventory;
pub mod json;
pub mod local_clock;
pub mod report;
pub mod scenarios;
pub mod schema;
pub mod transport;
pub mod witness;
