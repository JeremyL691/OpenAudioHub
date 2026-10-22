//! Ask AI over a recording's transcript (spec/recording-chat.md).
//! The conversation, its questions and answers, the chosen model and effort, and the citations.

pub mod capabilities;
pub mod citations;
pub mod context;
pub mod hub;
pub mod revision;
pub mod run;
pub mod store;
pub mod stream;

pub mod routes;

#[cfg(test)]
mod tests;
