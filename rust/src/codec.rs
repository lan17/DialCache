//! Serialized payloads and value codecs.

use std::borrow::Cow;

use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::BoxError;

/// Serializer output: UTF-8 text or opaque binary bytes.
///
/// Text payloads are stored with the frame's UTF-8 tag; binary payloads keep
/// their exact bytes. Compression envelopes wrap either form transparently.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
pub struct Payload {
    pub bytes: Vec<u8>,
    /// `true` for binary output, `false` for UTF-8 text.
    pub binary: bool,
}

impl Payload {
    pub fn text(text: impl Into<String>) -> Self {
        Payload { bytes: text.into().into_bytes(), binary: false }
    }

    pub fn binary(bytes: impl Into<Vec<u8>>) -> Self {
        Payload { bytes: bytes.into(), binary: true }
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// The bytes as text, replacing ill-formed UTF-8 in binary payloads.
    pub fn as_text(&self) -> Cow<'_, str> {
        String::from_utf8_lossy(&self.bytes)
    }
}

/// Encodes cached values to payloads and decodes them back.
///
/// Implement [`SyncCodec`] for ordinary serializers; it is adapted to this
/// asynchronous form automatically. Implement this trait directly only when
/// encoding or decoding must await. Every decode must return an independent
/// value: the cache may retain one payload and decode it more than once.
pub trait Codec<T>: Send + Sync + 'static {
    fn encode<'a>(&'a self, value: &'a T) -> BoxFuture<'a, Result<Payload, BoxError>>;
    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<T, BoxError>>;
}

/// A synchronous codec. Blanket-adapted to [`Codec`].
pub trait SyncCodec<T>: Send + Sync + 'static {
    fn encode(&self, value: &T) -> Result<Payload, BoxError>;
    fn decode(&self, payload: Payload) -> Result<T, BoxError>;
}

impl<T: Send + 'static, C: SyncCodec<T>> Codec<T> for C {
    fn encode<'a>(&'a self, value: &'a T) -> BoxFuture<'a, Result<Payload, BoxError>> {
        let result = SyncCodec::encode(self, value);
        Box::pin(std::future::ready(result))
    }

    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<T, BoxError>> {
        let result = SyncCodec::decode(self, payload);
        Box::pin(std::future::ready(result))
    }
}

/// Payload text that TypeScript writes for an `undefined` value.
pub const JSON_UNDEFINED_SENTINEL: &str = "__dialcache_json_undefined_v1__";

/// The default codec: `serde_json` text.
///
/// Values written by TypeScript's default serializer decode as long as they
/// are valid JSON for the destination type. The TypeScript `undefined`
/// sentinel decodes as JSON `null`, so an `Option<T>` destination reads it as
/// `None` and any other destination fails open to the source.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec;

impl<T: Serialize + DeserializeOwned + Send + Sync + 'static> SyncCodec<T> for JsonCodec {
    fn encode(&self, value: &T) -> Result<Payload, BoxError> {
        Ok(Payload::text(serde_json::to_string(value)?))
    }

    fn decode(&self, payload: Payload) -> Result<T, BoxError> {
        let text = payload.as_text();
        if text == JSON_UNDEFINED_SENTINEL {
            return Ok(T::deserialize(serde_json::Value::Null)?);
        }
        Ok(serde_json::from_str(&text)?)
    }
}
