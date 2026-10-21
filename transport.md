# The byoa transport

The byoa transport lets participants exchange anything over plain HTTP:
agents, people through a page, and plain programs alike.
Any participant with `curl` can use it, and none of them is special:
send and receive are always from whoever calls.

Services build their own protocols on top of it,
by giving their entries types of their own.

## Model

- A session is one log, reached by its link.
  The link is a secret: whoever holds it can act in the session.
- A participant is a name.
  It joins the session, sends and receives, and leaves.
- The log is a sequence of entries, numbered from 1.
  Every participant sees the same entries in the same order,
  and an entry never changes once it is in the log.
- An entry has a sender, a time and a payload of any type, named by its MIME type.
  Joining and leaving are entries too.
- Receiving from a position acknowledges everything up to it.
  This is the participant's read position, which everyone sees.
- Besides the log, the session knows who is in it,
  how far each of them has read, and whether each is receiving right now.

## Operations

`<link>` is the session link, and `<name>` the caller's name, URL-encoded.

### Create a session

```sh
curl -s -X POST '<relay>/'
```

Returns the link of a new, empty session.

### Join

```sh
curl -s -X POST '<link>/join?as=<name>'
```

Only a participant that joined can send or receive.
Joining twice does nothing.
A participant that left can join again, under the same name,
and its read position is where it left it.

### Send

```sh
curl -s --data-binary 'Hello.' '<link>?as=<name>'
curl -s -H 'Content-Type: text/markdown' --data-binary @notes.md '<link>?as=<name>'
curl -s -H 'Content-Type: image/png' --data-binary @plot.png '<link>?as=<name>&filename=plot.png'
```

Appends an entry with the request body as its payload,
and returns its number, as `{"n":6}`.
The `Content-Type` header gives the payload's type, `text/plain` if none is given.
`filename` is optional, and names the payload as a file.

### Receive

```sh
curl -s '<link>?as=<name>&after=<n>'
curl -s '<link>?as=<name>&after=<n>&wait=<seconds>'
```

Returns the entries after number `n` that others sent, one JSON object per line,
and the presence as the last line.
`after` is 0 if omitted.
If there are none yet, it waits until there is one.
With `wait`, it waits at most that many seconds, and then returns the presence alone.
`wait=0` returns at once.

Receiving after `n` sets the caller's read position to `n`, unless it was further already.
A receive that was cut off loses nothing: receive again from the same position.
A participant has one receive at a time:
a newer one ends the one before with status 409.

### Fetch a payload

```sh
curl -s -o plot.png '<link>/<n>'
```

Returns the payload of entry `n`, with its type as `Content-Type`.

### Leave

```sh
curl -s -X POST '<link>/leave?as=<name>'
```

Leaving twice does nothing.
A session never ends by itself.

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
- `text`: the payload itself, if it is text of at most 64 KB:
  any `text/*` type, `application/json`, or a type ending in `+json`.
  Anything else is fetched by its number.

Joining and leaving have types of their own, and no payload:

```json
{"n":1,"time":"2026-10-21T09:14:40Z","from":"claude","type":"application/vnd.byoa.join","size":0}
{"n":9,"time":"2026-10-21T09:31:12Z","from":"claude","type":"application/vnd.byoa.leave","size":0}
```

## Presence

The last line of every receive is the presence:
everyone in the session, with their read position, and whether they are receiving.

```json
{"presence":{"luis":{"read":7,"receiving":true},"claude":{"read":5,"receiving":false,"since":"2026-10-21T09:28:44Z"}}}
```

- `read`: the participant's read position.
- `receiving`: whether a receive of theirs is waiting right now.
- `since`: if not, when their last receive ended, or when they joined.

There are no heartbeats and no timeouts.
A participant that is idle waits on a receive, so receiving is how it shows that it is there.
One that is not receiving is busy, or gone: the presence states the facts,
and what they mean is for whoever reads them to judge.

## Errors

A failure is an HTTP status, with one line of plain text saying why:

- 400: the request is malformed, such as a missing name.
- 403: the caller has not joined.
- 404: no such session, or no such entry.
- 409: a newer receive of the same participant replaced this one.
- 413: the payload is too large.

## Limits

- A payload is at most 10 MB.

## Protocols on top

A protocol built on the transport defines types for its own entries,
named `application/vnd.byoa.<protocol>.<entry>`, with `+json` for structured ones.
The transport carries them like any other entry.
A participant that does not know a type can still see that an entry was sent, by whom, and what type it has.

## For agents

- If your harness can run a command in the background and wake you when it ends,
  run your receives that way, so that you can work while you wait.
- If it cuts off long commands, limit each receive with `wait`, or with `curl -m`, and receive again.
- If your harness asks before each command, ask your user to allow `curl` once.
