//! Every session: its log and its participants in SQLite, and the receives
//! waiting on it in memory.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use tokio::sync::oneshot;

use crate::{Fail, fail};

pub const MAX_NAME: usize = 256;
const MAX_INLINE: usize = 64 * 1024;
/// How long a session lasts with nobody using it, receiving included, in seconds.
const IDLE: i64 = 24 * 60 * 60;
const JOIN: &str = "application/vnd.polylogue.join";
const LEAVE: &str = "application/vnd.polylogue.leave";

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        used INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entries (
        session TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
        n INTEGER NOT NULL,
        time TEXT NOT NULL,
        sender TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        filename TEXT,
        text TEXT,
        payload BLOB,
        PRIMARY KEY (session, n)
    );
    CREATE TABLE IF NOT EXISTS participants (
        session TEXT NOT NULL REFERENCES sessions ON DELETE CASCADE,
        name TEXT NOT NULL,
        secret TEXT NOT NULL,
        inside INTEGER NOT NULL,
        entry INTEGER NOT NULL,
        read INTEGER NOT NULL,
        since TEXT NOT NULL,
        PRIMARY KEY (session, name),
        UNIQUE (session, secret)
    );
";

pub struct Sessions {
    db: Connection,
    /// The receives still waiting, by session and name: one per participant.
    waiting: HashMap<String, BTreeMap<String, Waiting>>,
    receives: u64,
}

/// What a receive asks for.
pub struct Receive {
    /// The entries after this number, or with none, after the caller's read
    /// position.
    pub after: Option<i64>,
    pub own: bool,
    pub presence: bool,
    /// The starts of the types it skips, in lower case: their entries
    /// neither end its wait nor are returned.
    pub skip: Vec<String>,
}

impl Receive {
    fn skips(&self, kind: &str) -> bool {
        let kind = kind.to_ascii_lowercase();
        self.skip
            .iter()
            .any(|start| kind.starts_with(start.as_str()))
    }
}

struct Waiting {
    id: u64,
    /// The receive's `after`, resolved.
    after: i64,
    receive: Receive,
    answer: oneshot::Sender<Answer>,
}

pub enum Answer {
    Lines(String),
    Replaced,
}

/// One waiting receive, as its caller holds it.
pub struct Ticket {
    session: String,
    name: String,
    id: u64,
}

struct Participant {
    name: String,
    inside: bool,
    entry: i64,
    read: i64,
}

#[derive(Serialize)]
pub struct Joined {
    n: i64,
    name: String,
    read: i64,
    link: String,
}

#[derive(Serialize)]
struct Entry {
    n: i64,
    time: String,
    from: String,
    #[serde(rename = "type")]
    kind: String,
    size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Serialize)]
struct Presence {
    read: i64,
    receiving: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
}

pub struct Payload {
    pub kind: String,
    pub filename: Option<String>,
    pub body: Vec<u8>,
}

/// A secret of 128 random bits: a session's id, or a participant's own part
/// of the session's link.
fn token() -> String {
    let mut random = [0; 16];
    getrandom::fill(&mut random).expect("the system has randomness");
    URL_SAFE_NO_PAD.encode(random)
}

pub fn is_token(text: &str) -> bool {
    text.len() == 22
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Text the log carries inline: `text/*`, JSON and `+json`, whatever the
/// parameters.
fn textual(kind: &str) -> bool {
    let base = kind
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    base.starts_with("text/") || base == "application/json" || base.ends_with("+json")
}

fn participant(row: &Row) -> rusqlite::Result<Participant> {
    Ok(Participant {
        name: row.get("name")?,
        inside: row.get("inside")?,
        entry: row.get("entry")?,
        read: row.get("read")?,
    })
}

impl Sessions {
    /// The sessions in the database at `path`, or in memory without one.
    pub fn open(path: Option<&Path>) -> rusqlite::Result<Self> {
        let db = match path {
            Some(path) => Connection::open(path)?,
            None => Connection::open_in_memory()?,
        };
        db.execute_batch(SCHEMA)?;
        Ok(Self {
            db,
            waiting: HashMap::new(),
            receives: 0,
        })
    }

    pub fn create(&mut self) -> Result<String, Fail> {
        let id = token();
        self.db.execute(
            "INSERT INTO sessions (id, used) VALUES (?, unixepoch())",
            [&id],
        )?;
        Ok(id)
    }

    /// Marks the session as used, which keeps it for another `IDLE`.
    pub fn enter(&self, session: &str) -> Result<(), Fail> {
        let used = self.db.execute(
            "UPDATE sessions SET used = unixepoch() WHERE id = ?",
            [session],
        )?;
        if used == 0 {
            return Err(fail(404, "no such session"));
        }
        Ok(())
    }

    /// Ends every session nobody used for `IDLE`, unless someone is still
    /// receiving in it.
    pub fn expire(&mut self) -> Result<(), Fail> {
        let idle = self
            .db
            .prepare("SELECT id FROM sessions WHERE used <= unixepoch() - ?")?
            .query_map([IDLE], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for session in idle {
            if self.waiting.contains_key(&session) {
                self.enter(&session)?;
            } else {
                self.end(&session)?;
            }
        }
        Ok(())
    }

    /// Deletes the session, payloads and all. Receives still waiting return.
    fn end(&mut self, session: &str) -> Result<(), Fail> {
        self.db
            .execute("DELETE FROM sessions WHERE id = ?", [session])?;
        for name in self.names_waiting(session) {
            self.answer(session, &name)?;
        }
        Ok(())
    }

    fn caller(&self, session: &str, secret: &str) -> Result<Participant, Fail> {
        self.db
            .prepare_cached("SELECT * FROM participants WHERE session = ? AND secret = ?")?
            .query_row([session, secret], participant)
            .optional()?
            .ok_or_else(|| fail(403, "this link is no participant's"))
    }

    /// The caller, if it is in the session.
    pub fn inside(&self, session: &str, secret: &str) -> Result<String, Fail> {
        let caller = self.caller(session, secret)?;
        if !caller.inside {
            return Err(fail(
                403,
                "you have left: join again with POST <your link>/join",
            ));
        }
        Ok(caller.name)
    }

    fn is_inside(&self, session: &str, name: &str) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .prepare_cached("SELECT inside FROM participants WHERE session = ? AND name = ?")?
            .query_row([session, name], |row| row.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// Takes `name` for the caller, who gets a link of its own: a name is
    /// bound to whoever joined with it, for the whole session.
    pub fn join(&mut self, session: &str, name: Option<&str>, link: &str) -> Result<Joined, Fail> {
        let name = name
            .filter(|name| !name.is_empty())
            .ok_or_else(|| fail(400, "name yourself with ?as=<name>"))?;
        if name.len() > MAX_NAME {
            return Err(fail(400, format!("a name is at most {MAX_NAME} bytes")));
        }
        let secret = token();
        let transaction = self.db.unchecked_transaction()?;
        let taken = transaction
            .prepare_cached("SELECT 1 FROM participants WHERE session = ? AND name = ?")?
            .exists([session, name])?;
        if taken {
            return Err(fail(409, format!("{name} is taken in this session")));
        }
        let n = self.append(session, name, JOIN, &[], None)?;
        transaction.execute(
            "INSERT INTO participants (session, name, secret, inside, entry, read, since)
             VALUES (?, ?, ?, TRUE, ?, 0, strftime('%Y-%m-%dT%H:%M:%SZ'))",
            params![session, name, secret, n],
        )?;
        transaction.commit()?;
        self.look(session)?;
        Ok(Joined {
            n,
            name: name.to_owned(),
            read: 0,
            link: format!("{link}/{secret}"),
        })
    }

    /// Joins again, after leaving, under the name the link is bound to.
    pub fn rejoin(&mut self, session: &str, secret: &str, me: &str) -> Result<Joined, Fail> {
        let caller = self.caller(session, secret)?;
        let mut n = caller.entry;
        if !caller.inside {
            let transaction = self.db.unchecked_transaction()?;
            n = self.append(session, &caller.name, JOIN, &[], None)?;
            transaction.execute(
                "UPDATE participants SET inside = TRUE, entry = ?, since = strftime('%Y-%m-%dT%H:%M:%SZ')
                 WHERE session = ? AND name = ?",
                params![n, session, caller.name],
            )?;
            transaction.commit()?;
            self.look(session)?;
        }
        Ok(Joined {
            n,
            name: caller.name,
            read: caller.read,
            link: me.to_owned(),
        })
    }

    /// The last to leave ends the session.
    pub fn leave(&mut self, session: &str, secret: &str) -> Result<i64, Fail> {
        let caller = self.caller(session, secret)?;
        if !caller.inside {
            return Ok(caller.entry);
        }
        let transaction = self.db.unchecked_transaction()?;
        let n = self.append(session, &caller.name, LEAVE, &[], None)?;
        transaction.execute(
            "UPDATE participants SET inside = FALSE, entry = ? WHERE session = ? AND name = ?",
            params![n, session, caller.name],
        )?;
        transaction.commit()?;
        self.look(session)?;
        let anyone = self
            .db
            .prepare_cached("SELECT 1 FROM participants WHERE session = ? AND inside")?
            .exists([session])?;
        if !anyone {
            self.end(session)?;
        }
        Ok(n)
    }

    pub fn send(
        &mut self,
        session: &str,
        secret: &str,
        kind: &str,
        filename: Option<&str>,
        payload: &[u8],
    ) -> Result<i64, Fail> {
        let name = self.inside(session, secret)?;
        let n = self.append(session, &name, kind, payload, filename)?;
        self.look(session)?;
        Ok(n)
    }

    /// Appends an entry, with its payload inline as text where it is short
    /// text, and as bytes otherwise.
    fn append(
        &self,
        session: &str,
        sender: &str,
        kind: &str,
        payload: &[u8],
        filename: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let text = (textual(kind) && payload.len() <= MAX_INLINE)
            .then(|| std::str::from_utf8(payload).ok())
            .flatten()
            .map(|text| text.strip_prefix('\u{feff}').unwrap_or(text));
        let bytes = (text.is_none() && !payload.is_empty()).then_some(payload);
        self.db
            .prepare_cached(
                "INSERT INTO entries (session, n, time, sender, type, size, filename, text, payload)
                 VALUES (?1, (SELECT COALESCE(MAX(n), 0) + 1 FROM entries WHERE session = ?1),
                         strftime('%Y-%m-%dT%H:%M:%SZ'), ?2, ?3, ?4, ?5, ?6, ?7)
                 RETURNING n",
            )?
            .query_row(
                params![session, sender, kind, payload.len() as i64, filename, text, bytes],
                |row| row.get(0),
            )
    }

    pub fn payload(&self, session: &str, secret: &str, n: i64) -> Result<Payload, Fail> {
        self.inside(session, secret)?;
        self.db
            .prepare_cached(
                "SELECT type, filename, COALESCE(CAST(text AS BLOB), payload, X'') FROM entries
                 WHERE session = ? AND n = ?",
            )?
            .query_row(params![session, n], |row| {
                Ok(Payload {
                    kind: row.get(0)?,
                    filename: row.get(1)?,
                    body: row.get(2)?,
                })
            })
            .optional()?
            .ok_or_else(|| fail(404, "no such entry"))
    }

    /// Starts a receive, which is answered once it has something to return.
    /// Receiving after `n` moves the read position up to `n`, never beyond
    /// the last entry; with no `n`, it receives after the read position.
    pub fn receive(
        &mut self,
        session: &str,
        secret: &str,
        receive: Receive,
    ) -> Result<(Ticket, oneshot::Receiver<Answer>), Fail> {
        let name = self.inside(session, secret)?;
        let after = match receive.after {
            Some(after) => after,
            None => self
                .db
                .prepare_cached("SELECT read FROM participants WHERE session = ? AND name = ?")?
                .query_row(params![session, name], |row| row.get(0))?,
        };
        let last: i64 = self
            .db
            .prepare_cached("SELECT COALESCE(MAX(n), 0) FROM entries WHERE session = ?")?
            .query_row([session], |row| row.get(0))?;
        let moved = self.db.execute(
            "UPDATE participants SET read = ?1 WHERE session = ?2 AND name = ?3 AND read < ?1",
            params![after.min(last), session, name],
        )?;
        if moved > 0 {
            self.stir(session, &name)?;
        }

        self.receives += 1;
        let id = self.receives;
        let presence = receive.presence;
        let (answer, answered) = oneshot::channel();
        let replaced = self.waiting.entry(session.to_owned()).or_default().insert(
            name.clone(),
            Waiting {
                id,
                after,
                receive,
                answer,
            },
        );
        match replaced {
            Some(replaced) => _ = replaced.answer.send(Answer::Replaced),
            None if !presence => self.stir(session, &name)?,
            None => {}
        }
        if self.ready(session, &name)? {
            self.answer(session, &name)?;
        }
        let ticket = Ticket {
            session: session.to_owned(),
            name,
            id,
        };
        Ok((ticket, answered))
    }

    /// Answers a receive now, as when its wait has passed.
    pub fn answer_now(&mut self, ticket: &Ticket) -> Result<(), Fail> {
        if self.holds(ticket) {
            self.answer(&ticket.session, &ticket.name)?;
        }
        Ok(())
    }

    /// Drops a receive whose caller went away.
    pub fn abandon(&mut self, ticket: &Ticket) -> Result<(), Fail> {
        if self.holds(ticket)
            && let Some(waiting) = self.take(&ticket.session, &ticket.name)
        {
            self.finish(&ticket.session, &ticket.name, &waiting.receive)?;
        }
        Ok(())
    }

    fn holds(&self, ticket: &Ticket) -> bool {
        self.waiting
            .get(&ticket.session)
            .and_then(|waiting| waiting.get(&ticket.name))
            .is_some_and(|waiting| waiting.id == ticket.id)
    }

    fn take(&mut self, session: &str, name: &str) -> Option<Waiting> {
        let waiting = self.waiting.get_mut(session)?;
        let taken = waiting.remove(name);
        if waiting.is_empty() {
            self.waiting.remove(session);
        }
        taken
    }

    fn names_waiting(&self, session: &str) -> Vec<String> {
        self.waiting
            .get(session)
            .map(|waiting| waiting.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Whether a receive has something to return: entries, or that its
    /// participant is no longer inside.
    fn ready(&self, session: &str, name: &str) -> rusqlite::Result<bool> {
        let Some(waiting) = self.waiting.get(session).and_then(|w| w.get(name)) else {
            return Ok(false);
        };
        if !self.is_inside(session, name)? {
            return Ok(true);
        }
        let mut kinds = self.db.prepare_cached(
            "SELECT type FROM entries WHERE session = ? AND n > ? AND (? OR sender != ?) ORDER BY n",
        )?;
        let mut rows = kinds.query(params![session, waiting.after, waiting.receive.own, name])?;
        while let Some(row) = rows.next()? {
            if !waiting.receive.skips(&row.get::<_, String>(0)?) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Answers `name`'s receive with the entries it asks for, and the
    /// presence last.
    fn answer(&mut self, session: &str, name: &str) -> Result<(), Fail> {
        self.answer_all(session, &[name.to_owned()])
    }

    /// Answers the receives of `names` together: they all carry the presence
    /// from before any of them ended, so that none shows another as gone
    /// only because the same operation answered it first.
    fn answer_all(&mut self, session: &str, names: &[String]) -> Result<(), Fail> {
        let mut answers = Vec::new();
        for name in names {
            if let Some(lines) = self.entries_for(session, name)? {
                answers.push((name, lines));
            }
        }
        let presence = serde_json::json!({ "presence": self.presence(session)? });
        let mut taken = Vec::new();
        for (name, mut lines) in answers {
            lines += &presence.to_string();
            lines.push('\n');
            if let Some(waiting) = self.take(session, name) {
                _ = waiting.answer.send(Answer::Lines(lines));
                taken.push((name, waiting.receive));
            }
        }
        for (name, receive) in taken {
            self.finish(session, name, &receive)?;
        }
        Ok(())
    }

    /// The entries `name`'s waiting receive asks for, one line each, and
    /// acknowledges them; none if it isn't waiting.
    fn entries_for(&mut self, session: &str, name: &str) -> Result<Option<String>, Fail> {
        let Some(waiting) = self.waiting.get(session).and_then(|w| w.get(name)) else {
            return Ok(None);
        };
        let mut lines = String::new();
        if self.is_inside(session, name)? {
            let (after, own) = (waiting.after, waiting.receive.own);
            let mut entries = self.db.prepare_cached(
                "SELECT n, time, sender, type, size, filename, text FROM entries
                 WHERE session = ? AND n > ? AND (? OR sender != ?) ORDER BY n",
            )?;
            let mut rows = entries.query(params![session, after, own, name])?;
            while let Some(row) = rows.next()? {
                if waiting.receive.skips(&row.get::<_, String>(3)?) {
                    continue;
                }
                let entry = Entry {
                    n: row.get(0)?,
                    time: row.get(1)?,
                    from: row.get(2)?,
                    kind: row.get(3)?,
                    size: row.get(4)?,
                    filename: row.get(5)?,
                    text: row.get(6)?,
                };
                lines += &serde_json::to_string(&entry).expect("an entry is JSON");
                lines.push('\n');
            }
            drop(rows);
            drop(entries);
            // A receive from the read position acknowledges what it returns,
            // and what it skips, since its caller keeps no position of its
            // own.
            if waiting.receive.after.is_none() {
                self.db.execute(
                    "UPDATE participants SET read = last FROM
                     (SELECT COALESCE(MAX(n), 0) AS last FROM entries WHERE session = ?1)
                     WHERE session = ?1 AND name = ?2 AND read < last",
                    params![session, name],
                )?;
            }
        }
        Ok(Some(lines))
    }

    /// Ends a receive: its participant is no longer receiving.
    fn finish(&mut self, session: &str, name: &str, receive: &Receive) -> Result<(), Fail> {
        self.db.execute(
            "UPDATE participants SET since = strftime('%Y-%m-%dT%H:%M:%SZ') WHERE session = ? AND name = ?",
            [session, name],
        )?;
        if !receive.presence {
            self.stir(session, name)?;
        }
        Ok(())
    }

    /// Answers the receives that have something to return, once an operation
    /// is done, so that the presence says what it did.
    fn look(&mut self, session: &str) -> Result<(), Fail> {
        let mut ready = Vec::new();
        for name in self.names_waiting(session) {
            if self.ready(session, &name)? {
                ready.push(name);
            }
        }
        self.answer_all(session, &ready)
    }

    /// Answers the receives waiting for presence, except `by`'s own.
    fn stir(&mut self, session: &str, by: &str) -> Result<(), Fail> {
        let stirred: Vec<String> = self
            .waiting
            .get(session)
            .into_iter()
            .flatten()
            .filter(|(name, waiting)| waiting.receive.presence && name.as_str() != by)
            .map(|(name, _)| name.clone())
            .collect();
        self.answer_all(session, &stirred)
    }

    fn presence(&self, session: &str) -> rusqlite::Result<BTreeMap<String, Presence>> {
        let waiting = self.waiting.get(session);
        self.db
            .prepare_cached(
                "SELECT name, read, since FROM participants WHERE session = ? AND inside",
            )?
            .query_map([session], |row| {
                let name: String = row.get(0)?;
                let receiving = waiting.is_some_and(|waiting| waiting.contains_key(&name));
                let presence = Presence {
                    read: row.get(1)?,
                    receiving,
                    since: if receiving { None } else { row.get(2)? },
                };
                Ok((name, presence))
            })?
            .collect()
    }
}
