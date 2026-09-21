use std::env;
use std::time::Duration;

use dialcache::{BoxError, DialCache, KeySpec, Policy, RedisAdapter};
use redis::AsyncConnectionConfig;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1/".to_owned());
    // Connection establishment, command deadlines and concurrency belong to
    // the application. This connection does not automatically retry commands.
    let config = AsyncConnectionConfig::new()
        .set_connection_timeout(Some(Duration::from_secs(2)))
        .set_response_timeout(Some(Duration::from_millis(250)))
        .set_concurrency_limit(64);
    let connection = redis::Client::open(url)?
        .get_multiplexed_async_connection_with_config(&config)
        .await?;
    let cache = DialCache::builder()
        .namespace("dialcache-example")
        .remote(RedisAdapter::new(connection))
        .build()?;
    let names = cache
        .use_case::<u64, String>("user", "displayName")
        .policy(Policy::default().remote_ttl_sec(300))
        .tracked(true)
        .key(|id: &u64| KeySpec::new(id))
        .source(|_scope, id| async move {
            println!("Loading user {id} from the source");
            // Replace this with your database or API call.
            Ok(format!("User {id}"))
        })
        .register()?;

    let request = cache.enable_guard();
    let name = names.get(request.scope(), 42).await?;
    println!("Hello, {name}!");
    drop(request);

    // Invalidate the demo's tracked Redis entry. In an application, call this
    // after successfully updating the source. Zero adds no future time buffer.
    // Existing request/process-local entries retain their normal lifetimes.
    cache.invalidate("user", 42_u64, 0).await?;
    Ok(())
}
