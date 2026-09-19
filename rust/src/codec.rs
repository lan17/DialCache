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
        Payload {
            bytes: text.into().into_bytes(),
            binary: false,
        }
    }

    pub fn binary(bytes: impl Into<Vec<u8>>) -> Self {
        Payload {
            bytes: bytes.into(),
            binary: true,
        }
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
/// Encoding and decoding are asynchronous so a codec may await. For ordinary
/// synchronous serializers implement [`SyncCodec`] and wrap the codec in
/// [`FromSync`]. Every decode must return an independent value: the cache may
/// retain one payload and decode it more than once.
pub trait Codec<T>: Send + Sync + 'static {
    fn encode<'a>(&'a self, value: &'a T) -> BoxFuture<'a, Result<Payload, BoxError>>;
    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<T, BoxError>>;
}

/// A synchronous codec. Wrap it in [`FromSync`] where a [`Codec`] is expected.
pub trait SyncCodec<T>: Send + Sync + 'static {
    fn encode(&self, value: &T) -> Result<Payload, BoxError>;
    fn decode(&self, payload: Payload) -> Result<T, BoxError>;
}

/// Adapts a [`SyncCodec`] to [`Codec`].
#[derive(Debug, Clone, Copy, Default)]
pub struct FromSync<C>(pub C);

impl<T: Send + 'static, C: SyncCodec<T>> Codec<T> for FromSync<C> {
    fn encode<'a>(&'a self, value: &'a T) -> BoxFuture<'a, Result<Payload, BoxError>> {
        let result = self.0.encode(value);
        Box::pin(std::future::ready(result))
    }

    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<T, BoxError>> {
        let result = self.0.decode(payload);
        Box::pin(std::future::ready(result))
    }
}

/// Payload text that TypeScript writes for an `undefined` value.
pub const JSON_UNDEFINED_SENTINEL: &str = "__dialcache_json_undefined_v1__";

/// The default codec: `serde_json` text.
///
/// Values written by TypeScript's default serializer decode as long as they
/// are valid JSON for the destination type. The TypeScript `undefined`
/// sentinel decodes as JSON `null`: an `Option<T>` destination reads it as
/// `None`, a destination that accepts `null` (such as `serde_json::Value`)
/// decodes it, and any other destination fails open to the source.
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec;

impl JsonCodec {
    pub fn encode_value<T: Serialize>(value: &T) -> Result<Payload, BoxError> {
        Ok(Payload::text(serde_json::to_string(value)?))
    }

    pub fn decode_value<T: DeserializeOwned>(payload: &Payload) -> Result<T, BoxError> {
        let text = payload.as_text();
        if text == JSON_UNDEFINED_SENTINEL {
            return Ok(T::deserialize(serde_json::Value::Null)?);
        }
        Ok(serde_json::from_str(&text)?)
    }
}

impl<T: Serialize + DeserializeOwned + Send + Sync + 'static> Codec<T> for JsonCodec {
    fn encode<'a>(&'a self, value: &'a T) -> BoxFuture<'a, Result<Payload, BoxError>> {
        Box::pin(std::future::ready(JsonCodec::encode_value(value)))
    }

    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<T, BoxError>> {
        Box::pin(std::future::ready(JsonCodec::decode_value(&payload)))
    }
}
