use std::fs::{self, File};
use std::future::Future;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use redis::aio::{ConnectionManager, ConnectionManagerConfig, MultiplexedConnection};
use redis::{AsyncConnectionConfig, Client, TlsCertificates};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

pub const COMMAND_BUDGET: Duration = Duration::from_millis(200);
pub const TEST_BUDGET: Duration = Duration::from_secs(30);

pub async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(TEST_BUDGET, work)
        .await
        .expect("transport test exceeded 30 seconds")
}

pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

pub struct Directory(pub PathBuf);

impl Directory {
    pub fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "dialcache-transport-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub struct Server {
    child: Child,
    pub port: u16,
}

impl Server {
    pub fn start(directory: &Path, name: &str, port: u16, extra: &str, sentinel: bool) -> Self {
        let config = directory.join(format!("{name}.conf"));
        fs::write(
            &config,
            format!(
                "bind 127.0.0.1\nport {port}\nprotected-mode yes\ndir {}\nloglevel warning\n{extra}\n",
                directory.display()
            ),
        )
        .unwrap();
        let log = File::create(directory.join(format!("{name}.log"))).unwrap();
        let mut command = Command::new("redis-server");
        command.arg(&config);
        if sentinel {
            command.arg("--sentinel");
        } else {
            command.args(["--save", "", "--appendonly", "no"]);
        }
        let child = command
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .expect("redis-server with TLS support must be installed");
        Self { child, port }
    }

    pub fn client(&self) -> Client {
        Client::open(format!("redis://127.0.0.1:{}", self.port)).unwrap()
    }

    pub fn stop(&mut self) {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }

    pub fn signal(&self, signal: &str) {
        assert!(Command::new("kill")
            .args([signal, &self.child.id().to_string()])
            .status()
            .unwrap()
            .success());
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn config() -> AsyncConnectionConfig {
    AsyncConnectionConfig::new()
        .set_connection_timeout(Some(COMMAND_BUDGET))
        .set_response_timeout(Some(COMMAND_BUDGET))
        .set_concurrency_limit(16)
}

pub async fn connect(client: &Client) -> redis::RedisResult<MultiplexedConnection> {
    client
        .get_multiplexed_async_connection_with_config(&config())
        .await
}

pub async fn ready(client: &Client) -> MultiplexedConnection {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(mut connection) = connect(client).await {
            if redis::cmd("PING")
                .query_async::<String>(&mut connection)
                .await
                .is_ok()
            {
                return connection;
            }
        }
        assert!(Instant::now() < until, "local server did not become ready");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub async fn manager(client: &Client) -> ConnectionManager {
    client
        .get_connection_manager_with_config(
            ConnectionManagerConfig::new()
                .set_connection_timeout(Some(COMMAND_BUDGET))
                .set_response_timeout(Some(COMMAND_BUDGET))
                .set_number_of_retries(1)
                .set_min_delay(Duration::from_millis(10))
                .set_max_delay(Duration::from_millis(20)),
        )
        .await
        .unwrap()
}

pub async fn manager_ready(manager: &mut ConnectionManager) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        if redis::cmd("PING")
            .query_async::<String>(manager)
            .await
            .is_ok()
        {
            return;
        }
        assert!(Instant::now() < until, "manager did not reconnect");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub fn openssl(directory: &Path, args: &[&str]) {
    let mut child = Command::new("openssl")
        .args(args)
        .current_dir(directory)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("openssl must be installed");
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "openssl failed: {args:?}");
            break;
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            panic!("openssl exceeded 10 seconds");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

pub struct Certificates {
    pub directory: Directory,
}

impl Certificates {
    pub fn new() -> Self {
        static CRYPTO: Once = Once::new();
        CRYPTO.call_once(|| {
            rustls::crypto::ring::default_provider()
                .install_default()
                .expect("install the test TLS crypto provider");
        });
        let directory = Directory::new();
        for ca in ["ca", "other-ca"] {
            openssl(
                &directory.0,
                &[
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    &format!("{ca}.key"),
                    "-out",
                    &format!("{ca}.crt"),
                    "-subj",
                    &format!("/CN={ca} local test CA"),
                    "-days",
                    "1",
                    "-addext",
                    "basicConstraints=critical,CA:TRUE",
                ],
            );
        }
        for (name, extension) in [
            (
                "server",
                "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n",
            ),
            ("client", "extendedKeyUsage=clientAuth\n"),
        ] {
            openssl(
                &directory.0,
                &[
                    "req",
                    "-new",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    &format!("{name}.key"),
                    "-out",
                    &format!("{name}.csr"),
                    "-subj",
                    &format!("/CN={name}"),
                ],
            );
            fs::write(directory.0.join(format!("{name}.ext")), extension).unwrap();
            openssl(
                &directory.0,
                &[
                    "x509",
                    "-req",
                    "-in",
                    &format!("{name}.csr"),
                    "-CA",
                    "ca.crt",
                    "-CAkey",
                    "ca.key",
                    "-CAcreateserial",
                    "-out",
                    &format!("{name}.crt"),
                    "-days",
                    "1",
                    "-extfile",
                    &format!("{name}.ext"),
                ],
            );
        }
        Self { directory }
    }

    pub fn start(&self, port: u16, client_auth: bool) -> Server {
        Server::start(
            &self.directory.0, "tls", 0,
            &format!(
                "tls-port {port}\ntls-cert-file server.crt\ntls-key-file server.key\ntls-ca-cert-file ca.crt\ntls-auth-clients {}\n",
                if client_auth { "yes" } else { "no" }
            ),
            false,
        )
    }

    pub fn client(&self, host: &str, port: u16, ca: &str, client_auth: bool) -> Client {
        Client::build_with_tls(
            format!("rediss://{host}:{port}"),
            TlsCertificates {
                root_cert: Some(fs::read(self.directory.0.join(format!("{ca}.crt"))).unwrap()),
                client_tls: client_auth.then(|| redis::ClientTlsConfig {
                    client_cert: fs::read(self.directory.0.join("client.crt")).unwrap(),
                    client_key: fs::read(self.directory.0.join("client.key")).unwrap(),
                }),
            },
        )
        .unwrap()
    }
}

pub struct ResponseGate {
    pub port: u16,
    hold: Arc<AtomicBool>,
    pub held: Arc<Notify>,
    release: Arc<Notify>,
    task: JoinHandle<()>,
}

impl ResponseGate {
    pub async fn start(target: u16) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = Arc::new(AtomicBool::new(false));
        let held = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let (h, seen, resume) = (hold.clone(), held.clone(), release.clone());
        let task = tokio::spawn(async move {
            let (client, _) = listener.accept().await.unwrap();
            let backend = tokio::net::TcpStream::connect(("127.0.0.1", target))
                .await
                .unwrap();
            let (mut client_read, mut client_write) = client.into_split();
            let (mut backend_read, mut backend_write) = backend.into_split();
            let requests = tokio::io::copy(&mut client_read, &mut backend_write);
            let replies = async move {
                let mut buffer = [0; 8192];
                loop {
                    let count = backend_read.read(&mut buffer).await?;
                    if count == 0 {
                        break;
                    }
                    if h.swap(false, Ordering::SeqCst) {
                        let prefix = count.min(2);
                        client_write.write_all(&buffer[..prefix]).await?;
                        seen.notify_one();
                        resume.notified().await;
                        client_write.write_all(&buffer[prefix..count]).await?;
                    } else {
                        client_write.write_all(&buffer[..count]).await?;
                    }
                }
                Ok::<(), std::io::Error>(())
            };
            tokio::select! {
                _ = requests => {}
                _ = replies => {}
            }
        });
        Self {
            port,
            hold,
            held,
            release,
            task,
        }
    }

    pub fn client(&self) -> Client {
        Client::open(format!("redis://127.0.0.1:{}", self.port)).unwrap()
    }

    pub fn hold_next(&self) {
        self.hold.store(true, Ordering::SeqCst);
    }

    pub fn release(&self) {
        self.release.notify_one();
    }
}

impl Drop for ResponseGate {
    fn drop(&mut self) {
        self.task.abort();
    }
}
