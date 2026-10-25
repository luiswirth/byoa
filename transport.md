# The byoa transport

The byoa transport lets participants exchange anything over plain HTTP:
agents, people through a page, and plain programs alike.
Any participant with `curl` can use it, and none of them is special:
send and receive are always from whoever calls.

Extensions give entries meaning on top of it,
such as speech, at `https://byoa.senses.sh/speech.md`.

Every operation is one plain `curl` request, so this spec is all a participant needs to take part, or to write a client of its own.
The `byoa` script makes the requests for convenience: `curl -so byoa https://byoa.senses.sh/byoa`, then `sh byoa help`.
It is plain `sh` over `curl`, and its source is public at `https://github.com/luiswirth/byoa/blob/main/byoa`.

## Model

- A session is one log, reached by its link.
  The link is a secret: whoever holds it can join the session.
- A session ends when the last participant in it leaves,
  or after a day in which nobody used it: no request, and no receive waiting.
  Then it is deleted, payloads and all, and its link leads nowhere.
  A participant that goes away without leaving keeps it, and its payloads, until that day has passed.
- A participant is a name.
  It joins the session, sends and receives, and leaves.
  Joining gives it a link of its own, a secret it keeps to itself,
  and everything it does later goes to that link.
  So a name is bound to whoever joined with it, for as long as the session lasts:
  nobody else sends or receives under it, and nobody else joins under it.
  A person's name is plain, such as `luis`.
  Whatever takes part for a person, such as their agent, is named under theirs, as `luis/claude`;
  one that doesn't know whose it is takes a plain name, such as `claude`.
- The log is a sequence of entries, numbered from 1.
  Every participant sees the same entries in the same order,
  and an entry never changes once it is in the log.
- An entry has a sender, a time and a payload of any type, named by its MIME type.
  Joining and leaving are entries too.
- Receiving from a position acknowledges everything up to it;
  receiving with none gives what comes after the read position, and acknowledges it.
  This is the participant's read position, which everyone sees.
- Besides the log, the session knows who is in it,
  how far each of them has read, and whether each is receiving right now.

## Operations

`<link>` is the session link, which everyone in the session shares.
`<me>` is the caller's own link, which joining returns.
Every operation on a session except joining is on `<me>`,
and only for a participant that is in: one that joined and has not left since.
The relay knows the caller from its link, so no request names it.

The relay answers requests from any origin, so a page on any site can take part.

The transport's version, `v1`, is the first part of every session's path.
A change that a client of the version before can't speak bumps it,
and the relay serves only the current version: it answers any other with status 410.

### Create a session

```sh
curl -s -X POST '<relay>/v1/s'
```

Returns the link of a new, empty session, as one line of text.
The link is `<relay>/v1/s/<token>`, and its token is the secret.

### Join

```sh
curl -s -X POST '<link>/join?as=<name>'
```

`<name>` is URL-encoded.
Returns the number of its join entry, the name, its read position, and the caller's own link:

```json
{"n":1,"name":"luis","read":0,"link":"https://byoa.senses.sh/v1/s/<token>/<secret>"}
```

Keep the link to yourself: whoever holds it acts under your name.
A name that anyone joined under before is taken, with status 409,
so whoever starts a session joins before handing out its link.

```sh
curl -s -X POST '<me>/join'
```

Joins again after leaving, under the same name, with the same answer.
The read position is where it was left, as long as the session has not ended.
Joining again while in does nothing, and returns the same number,
so it also tells whose a link is.

### Send

```sh
curl -s --data-binary 'Hello.' '<me>'
curl -s -H 'Content-Type: text/markdown' --data-binary @notes.md '<me>'
curl -s -H 'Content-Type: image/png' --data-binary @plot.png '<me>?filename=plot.png'
```

Appends an entry with the request body as its payload,
and returns its number, as `{"n":6}`.
The `Content-Type` header gives the payload's type, `text/plain; charset=utf-8` if none is given.
curl's own default, `application/x-www-form-urlencoded`, counts as none,
so that `--data-binary` alone sends text.
A payload may be empty.
`filename` is optional, and names the payload as a file.

### Receive

```sh
curl -s '<me>'
curl -s '<me>?wait=<seconds>'
curl -s '<me>?after=<n>'
curl -s '<me>?skip=<type>'
```

Returns the entries that others sent after the caller's read position, one JSON object per line,
and the presence as the last line,
so a participant keeps nothing but its own link.
With `after`, it returns those after number `n` instead.
If there are none yet, it waits until there is one.
With `wait`, it waits at most that many seconds, and then returns the presence alone.
`wait=0` returns at once.
With `skip`, it leaves out the entries whose type starts with `<type>`, URL-encoded and in any case,
and doesn't return for them, so that it wakes the caller only for what it wants;
give it once for each type, such as `skip=audio/&skip=application/vnd.byoa.voice.trace`.
A receive that waits costs one request per entry, or per wait;
one that returns at once, in a loop, polls, and costs a request each time,
so a receive waits as long as the caller can.

Two more parameters are for pages, which show the session as it is:

- `own=1`: the caller's own entries too, as a page needs after a reload.
- `presence=1`: also return when someone's presence changes.
  Whether those who receive this way are receiving doesn't count,
  so that two of them don't wake each other forever.

Receiving after `n` sets the caller's read position to `n`, unless it was further already,
and never beyond the last entry.
Such a receive that was cut off loses nothing: receive again from the same position.
Receiving without `after` sets the read position to the last entry as it returns,
so what it returned, and what it skipped, is acknowledged, even if it was cut off on the way.
A participant has one receive at a time:
a newer one ends the one before with status 409.

### Fetch a payload

```sh
curl -s -o plot.png '<me>/<n>'
```

Returns the payload of entry `n`, with its type as `Content-Type`,
and its file name, if it has one, in `Content-Disposition`.

### Leave

```sh
curl -s -X POST '<me>/leave'
```

Returns the number of its leave entry, as `{"n":9}`.
Leaving twice does nothing, and returns the same number.
The name stays taken, and the link joins again.
A receive of the participant that is still waiting returns.
The last participant to leave ends the session.

## Entries

An entry is one line of JSON:

```json
{"n":3,"time":"2026-10-21T09:15:02Z","from":"luis","type":"text/plain; charset=utf-8","size":6,"text":"Hello."}
```

- `n`: its number.
- `time`: when it was appended, in UTC.
- `from`: the sender's name.
- `type`: the payload's MIME type.
- `size`: the payload's length in bytes.
- `filename`: the payload's file name, if it has one.
- `text`: the payload itself, if it is valid UTF-8 text of at most 64 KB:
  any `text/*` type, `application/json`, or a type ending in `+json`.
  Anything else is fetched by its number.

Joining and leaving have types of their own, and an empty payload:

```json
{"n":1,"time":"2026-10-21T09:14:40Z","from":"luis/claude","type":"application/vnd.byoa.join","size":0}
{"n":9,"time":"2026-10-21T09:31:12Z","from":"luis/claude","type":"application/vnd.byoa.leave","size":0}
```

## Presence

The last line of every receive is the presence:
everyone in the session, with their read position, and whether they are receiving.

```json
{"presence":{"luis":{"read":7,"receiving":true},"luis/claude":{"read":5,"receiving":false,"since":"2026-10-21T09:28:44Z"}}}
```

- `read`: the participant's read position.
- `receiving`: whether a receive of theirs is waiting right now.
- `since`: if not, when their last receive ended, or when they joined.

The receives that one operation answers, such as all those a new entry wakes,
carry the same presence: the one from before any of them ended.
So a page that receives its own entries still shows as receiving next to its own message.

There are no heartbeats and no timeouts.
A participant that is idle waits on a receive, so receiving is how it shows that it is there.
One that is not receiving is busy, or gone: the presence states the facts,
and what they mean is for whoever reads them to judge.

## Errors

A failure is an HTTP status, with one line of plain text saying why:

- 400: the request is malformed, such as a join with no name, an `after` that is no number, or an empty `skip`.
- 403: the caller is not in: its link is no participant's, or it left.
- 404: no such session, entry or operation.
- 409: the name is taken, or a newer receive of the same participant replaced this one.
- 410: the request is for another version of the transport.
- 413: the payload is too large.
- 503: the relay can't answer right now, such as when it is over its limits, with `Retry-After` in seconds.

A failed receive, or fetch, answers only after a pause of 10 seconds,
so that a client that receives again at once still sends few requests.

## Limits

- A payload is at most 10 MB.
- A name, and a file name, is at most 256 bytes.

## Extensions

An extension defines types for its own entries,
named `application/vnd.byoa.<extension>.<entry>`, with `+json` for structured ones.
The transport carries them like any other entry.
A participant that does not know a type can still see that an entry was sent, by whom, and what type it has.

## Secrets

The log keeps everything, so a secret, such as an API key, goes into it only encrypted to its recipient.
This is optional: a participant that can't encrypt sends no secrets, and an extension offers another way.

- `application/vnd.byoa.key`: a participant's public key, as PEM, for RSA-OAEP with SHA-256.
  It asks for secrets, and the extension says which.
  Fetch it by its number: `curl -s -o key.pem '<me>/<n>'`.
- `application/vnd.byoa.secret+json`, as `{"key":12,"name":"elevenlabs","data":"…"}`:
  a secret encrypted to the public key in entry `key`, base64 in `data`, with `name` saying what it is.
  At most 318 bytes, which a 3072-bit key allows.

Encrypt straight from where the secret is kept, so that it stays out of your transcript, which goes to your model's provider:

```sh
data=$(openssl pkeyutl -encrypt -pubin -inkey key.pem \
  -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \
  -in <file> | base64 | tr -d '\n')
curl -s -H 'Content-Type: application/vnd.byoa.secret+json' \
  --data-binary "{\"key\":<n>,\"name\":\"<name of the secret>\",\"data\":\"$data\"}" '<me>'
```
