//! The byoa relay: the transport that `transport.md` specifies, over plain
//! HTTP, with every session in one SQLite database.

mod sessions;

use std::borrow::Cow;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{
    CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HOST, REFERRER_POLICY, RETRY_AFTER,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use http_body_util::BodyExt;
use serde::Serialize;
use tokio::time::{sleep, timeout};

use sessions::{Answer, MAX_NAME, Receive, Sessions, Ticket, is_token};

/// The transport's version, the first part of every session's path: a
/// breaking change bumps it, and the relay serves only the current one.
const VERSION: &str = "v1";
const MAX_PAYLOAD: usize = 10 * 1024 * 1024;
/// How long a failed receive or fetch takes to answer, so that a client that
/// receives again at once, in a loop, still sends few requests.
const FAILED_RECEIVE: Duration = Duration::from_secs(10);
const PLAIN: &str = "text/plain; charset=utf-8";
const MARKDOWN: &str = "text/markdown; charset=utf-8";

const PEOPLE: &str = include_str!("people.html");
const SCRIPT: &str = include_str!("../byoa");
const TRANSPORT: &str = include_str!("../transport.md");
const SPEECH: &str = include_str!("../extensions/speech.md");

const CORS: [(&str, &str); 5] = [
    ("access-control-allow-origin", "*"),
    ("access-control-allow-methods", "GET, POST"),
    ("access-control-allow-headers", "Content-Type"),
    ("access-control-expose-headers", "Content-Disposition"),
    ("access-control-max-age", "86400"),
];

/// A failed request: its status, and one line saying why.
pub struct Fail {
    status: StatusCode,
    why: Cow<'static, str>,
}

fn fail(status: u16, why: impl Into<Cow<'static, str>>) -> Fail {
    Fail {
        status: StatusCode::from_u16(status).expect("a status is valid"),
        why: why.into(),
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(_: rusqlite::Error) -> Self {
        fail(503, "the relay can't answer right now")
    }
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            [(CONTENT_TYPE, PLAIN)],
            format!("{}\n", self.why),
        )
            .into_response();
        if self.status == StatusCode::SERVICE_UNAVAILABLE {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static("60"));
        }
        response
    }
}

pub struct Relay {
    sessions: Mutex<Sessions>,
}

impl Relay {
    /// The relay with its sessions in the database at `path`, or in memory
    /// without one.
    pub fn open(path: Option<&Path>) -> rusqlite::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            sessions: Mutex::new(Sessions::open(path)?),
        }))
    }

    pub fn router(self: Arc<Self>) -> Router {
        Router::new().fallback(handle).with_state(self)
    }

    /// Ends the sessions nobody used for a day, checking every minute.
    pub async fn expire(self: Arc<Self>) {
        loop {
            sleep(Duration::from_secs(60)).await;
            _ = self.sessions().expire();
        }
    }

    fn sessions(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// A waiting receive, which its caller abandons by going away.
struct Waiting<'a> {
    relay: &'a Relay,
    ticket: Ticket,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        _ = self.relay.sessions().abandon(&self.ticket);
    }
}

async fn handle(State(relay): State<Arc<Relay>>, request: Request) -> Response {
    let receiving = request.method() == Method::GET && in_session(request.uri().path());
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        route(&relay, request)
            .await
            .unwrap_or_else(IntoResponse::into_response)
    };
    if receiving && !response.status().is_success() {
        sleep(FAILED_RECEIVE).await;
    }
    for (name, value) in CORS {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

/// Whether a path is a session's, of any version.
fn in_session(path: &str) -> bool {
    let path = path.trim_start_matches('/');
    let path = match path.split_once('/') {
        Some((version, rest)) if is_version(version) => rest,
        _ => path,
    };
    path.starts_with("s/")
}

fn is_version(segment: &str) -> bool {
    segment
        .strip_prefix('v')
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// The number in a path or a query, which saturates rather than overflows.
fn number(text: &str) -> Option<i64> {
    (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().unwrap_or(i64::MAX))
}

/// The origin the caller reached the relay at, which every link it gets
/// starts with.
fn origin(headers: &HeaderMap) -> String {
    let header = |name| {
        headers
            .get(name)
            .and_then(|value: &HeaderValue| value.to_str().ok())
    };
    let scheme = header("x-forwarded-proto").unwrap_or("http");
    let host = header(HOST.as_str()).unwrap_or("localhost");
    format!("{scheme}://{host}")
}

fn param<'a>(query: &'a str, key: &str) -> Option<Cow<'a, str>> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, value)| value)
}

fn text(body: impl Into<Body>, kind: &'static str) -> Response {
    ([(CONTENT_TYPE, kind)], body.into()).into_response()
}

fn json(value: &impl Serialize) -> Response {
    let body = serde_json::to_string(value).expect("an answer is JSON");
    text(format!("{body}\n"), "application/json")
}

fn numbered(n: i64) -> Response {
    json(&serde_json::json!({ "n": n }))
}

fn gone(origin: &str) -> Fail {
    fail(
        410,
        format!(
            "byoa changed to {VERSION}, and this request is from an older client: \
             the spec is at {origin}/transport.md, and the script at {origin}/byoa"
        ),
    )
}

async fn route(relay: &Relay, request: Request) -> Result<Response, Fail> {
    let (parts, body) = request.into_parts();
    let origin = origin(&parts.headers);
    let query = parts.uri.query().unwrap_or("");
    let segments: Vec<&str> = parts.uri.path().split('/').skip(1).collect();
    let get = parts.method == Method::GET;
    match segments.as_slice() {
        [""] if get => Ok(text(PEOPLE, "text/html; charset=utf-8")),
        ["byoa"] if get => Ok(text(SCRIPT, PLAIN)),
        ["transport.md"] if get => Ok(text(TRANSPORT, MARKDOWN)),
        ["speech.md"] if get => Ok(text(SPEECH, MARKDOWN)),
        ["s", ..] => Err(gone(&origin)),
        [version, ..] if is_version(version) && *version != VERSION => Err(gone(&origin)),
        [VERSION, "s"] if parts.method == Method::POST => {
            let id = relay.sessions().create()?;
            Ok(text(format!("{origin}/{VERSION}/s/{id}\n"), PLAIN))
        }
        [VERSION, "s", id, rest @ ..] => {
            let link = format!("{origin}/{VERSION}/s/{id}");
            session(
                relay,
                id,
                rest,
                &parts.method,
                &parts.headers,
                query,
                body,
                &link,
            )
            .await
        }
        [VERSION, "s"] => Err(fail(404, "no such operation")),
        _ => Err(fail(404, "no such page")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn session(
    relay: &Relay,
    id: &str,
    rest: &[&str],
    method: &Method,
    headers: &HeaderMap,
    query: &str,
    body: Body,
    link: &str,
) -> Result<Response, Fail> {
    if !is_token(id) {
        return Err(fail(404, "no such session"));
    }
    let [secret, operation @ ..] = rest else {
        return Err(fail(403, "join first: POST <link>/join?as=<name>"));
    };
    relay.sessions().enter(id)?;
    let me = format!("{link}/{secret}");
    let post = method == Method::POST;
    let get = method == Method::GET;
    match (*secret, operation) {
        ("join", []) if post => {
            let joined = relay
                .sessions()
                .join(id, param(query, "as").as_deref(), link)?;
            Ok(json(&joined))
        }
        (_, []) if post => send(relay, id, secret, headers, query, body).await,
        (_, []) if get => receive(relay, id, secret, query).await,
        (_, ["join"]) if post => {
            let joined = relay.sessions().rejoin(id, secret, &me)?;
            Ok(json(&joined))
        }
        (_, ["leave"]) if post => {
            let n = relay.sessions().leave(id, secret)?;
            Ok(numbered(n))
        }
        (_, [n]) if get && number(n).is_some() => {
            let n = number(n).unwrap_or_default();
            payload(relay, id, secret, n)
        }
        _ => Err(fail(404, "no such operation")),
    }
}

async fn send(
    relay: &Relay,
    id: &str,
    secret: &str,
    headers: &HeaderMap,
    query: &str,
    body: Body,
) -> Result<Response, Fail> {
    let filename = param(query, "filename");
    if filename.as_ref().is_some_and(|name| name.len() > MAX_NAME) {
        return Err(fail(
            400,
            format!("a file name is at most {MAX_NAME} bytes"),
        ));
    }
    relay.sessions().inside(id, secret)?;
    let payload = read_at_most(body, MAX_PAYLOAD)
        .await?
        .ok_or_else(|| fail(413, format!("a payload is at most {MAX_PAYLOAD} bytes")))?;
    // curl sends this type unless told otherwise, which says nothing.
    let kind = headers
        .get(CONTENT_TYPE)
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .filter(|kind| !kind.starts_with("application/x-www-form-urlencoded"))
        .unwrap_or_else(|| PLAIN.to_owned());
    let n = relay
        .sessions()
        .send(id, secret, &kind, filename.as_deref(), &payload)?;
    Ok(numbered(n))
}

/// The body, or none if it is longer than `limit`. A longer one is still read
/// to its end, since a client may not see an answer before it has sent
/// everything.
async fn read_at_most(mut body: Body, limit: usize) -> Result<Option<Vec<u8>>, Fail> {
    let mut payload = Vec::new();
    let mut size = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| fail(400, "the payload was cut off"))?;
        if let Some(data) = frame.data_ref() {
            size += data.len();
            if size <= limit {
                payload.extend_from_slice(data);
            }
        }
    }
    Ok((size <= limit).then_some(payload))
}

async fn receive(relay: &Relay, id: &str, secret: &str, query: &str) -> Result<Response, Fail> {
    let after = match param(query, "after") {
        None => None,
        Some(after) => Some(number(&after).ok_or_else(|| fail(400, "after is a number"))?),
    };
    // A wait too long to represent is no limit.
    let wait = match param(query, "wait") {
        None => None,
        Some(wait) => match wait.parse::<f64>() {
            Ok(seconds) if seconds >= 0.0 => Duration::try_from_secs_f64(seconds).ok(),
            _ => return Err(fail(400, "wait is a number of seconds")),
        },
    };
    let flag = |key| param(query, key).is_some_and(|value| value == "1");
    let skip = form_urlencoded::parse(query.as_bytes())
        .filter(|(key, _)| key == "skip")
        .map(|(_, kind)| kind.to_ascii_lowercase())
        .collect::<Vec<_>>();
    if skip.iter().any(String::is_empty) {
        return Err(fail(400, "skip is a type, or the start of one"));
    }
    let receive = Receive {
        after,
        own: flag("own"),
        presence: flag("presence"),
        skip,
    };
    let (ticket, mut answered) = relay.sessions().receive(id, secret, receive)?;
    let waiting = Waiting { relay, ticket };
    let answer = match wait {
        None => answered.await,
        Some(wait) => match timeout(wait, &mut answered).await {
            Ok(answer) => answer,
            Err(_) => {
                relay.sessions().answer_now(&waiting.ticket)?;
                answered.await
            }
        },
    };
    match answer.map_err(|_| fail(503, "the relay can't answer right now"))? {
        Answer::Lines(lines) => Ok(text(lines, "application/jsonl; charset=utf-8")),
        Answer::Replaced => Err(fail(409, "a newer receive replaced this one")),
    }
}

fn payload(relay: &Relay, id: &str, secret: &str, n: i64) -> Result<Response, Fail> {
    let payload = relay.sessions().payload(id, secret, n)?;
    let mut response = payload.body.into_response();
    let headers = response.headers_mut();
    // The type is the sender's: a payload opened as a page, such as HTML,
    // runs in a sandbox of its own, never as the relay's site. Its URL holds
    // the caller's own link, which no page it opens learns.
    let kind = HeaderValue::from_str(&payload.kind)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    headers.insert(CONTENT_TYPE, kind);
    headers.insert(CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if let Some(filename) = payload.filename {
        let disposition = format!("inline; filename*=UTF-8''{}", uri_component(&filename));
        if let Ok(disposition) = HeaderValue::from_str(&disposition) {
            headers.insert(CONTENT_DISPOSITION, disposition);
        }
    }
    Ok(response)
}

/// Percent-encodes every byte but the unreserved ones, as JavaScript's
/// `encodeURIComponent` does.
fn uri_component(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
