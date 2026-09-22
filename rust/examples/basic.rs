use std::sync::Arc;
use std::time::Duration;

use dialcache::{BoxError, DialCache, KeySpec, Policy};
use serde::{Deserialize, Serialize};

// Results need serialization and comparison for the default codec and shadow
// comparator. They do not need Clone: cached callers share an Arc<User>.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct User {
    id: u64,
    name: String,
}

async fn load_user(id: u64) -> Result<User, BoxError> {
    println!("Loading user {id} from the source");
    // Replace this with your database or API call.
    tokio::time::sleep(Duration::from_millis(10)).await;
    Ok(User {
        id,
        name: "Ada".to_owned(),
    })
}

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    // Application startup: build the cache and register each use case once.
    let cache = DialCache::builder().namespace("my-app").build()?;
    let users = cache
        .use_case::<u64, User>("user", "byId")
        .policy(Policy::default().request_local(true).local_ttl_sec(30))
        .key(|id: &u64| KeySpec::new(id))
        .source(|_scope, id| load_user(id))
        .register()?;

    // Request handler: pass this scope to all cached calls in the request.
    let request = cache.enable_guard();
    let user: Arc<User> = users.get(request.scope(), 42).await?;
    let again = users.get(request.scope(), 42).await?;
    assert!(Arc::ptr_eq(&user, &again));
    println!("Hello, {}! Repeated calls share the same value.", user.name);
    drop(request); // Closes the request cache; the returned Arc remains usable.

    // Another request can still use the 30-second process-local entry.
    let next_request = cache.enable_guard();
    let next = users.get(next_request.scope(), 42).await?;
    assert!(Arc::ptr_eq(&user, &next));
    println!("The next request reused the process-local entry.");
    Ok(())
}
