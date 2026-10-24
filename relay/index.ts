import { DurableObject } from "cloudflare:workers";
import script from "../byoa";
import speech from "../extensions/speech.md";
import transport from "../transport.md";
import people from "./people.html";

const MAX_PAYLOAD = 10 * 1024 * 1024;
const MAX_INLINE = 64 * 1024;
/** How long a session lasts with nobody using it, receiving included. */
const IDLE = 24 * 60 * 60 * 1000;
const MAX_NAME = 256;
const DEFAULT_TYPE = "text/plain; charset=utf-8";
const JOIN = "application/vnd.byoa.join";
/** The specs the relay serves, each under its own name. */
const DOCS = new Map([
	["/transport.md", transport],
	["/speech.md", speech],
]);
const LEAVE = "application/vnd.byoa.leave";
/** A session's id, and a participant's own part of its link. */
const TOKEN = /^[\w-]{22}$/;
/** The transport's version, the first part of every session's path: a
 * breaking change bumps it, and the relay serves only the current one. */
const VERSION = "v1";
/** A session's link. */
const sessionLink = (origin: string, id: string) =>
	`${origin}/${VERSION}/s/${id}`;

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Expose-Headers": "Content-Disposition",
	"Access-Control-Max-Age": "86400",
};

const fail = (status: number, why: string) =>
	new Response(`${why}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});

const pause = (ms: number) => new Promise<void>((wake) => setTimeout(wake, ms));

/** How long a failed receive or fetch takes to answer, so that a client that receives
 * again at once, in a loop, still sends few requests. */
const FAILED_RECEIVE = 10_000;

const json = (value: unknown) =>
	new Response(`${JSON.stringify(value)}\n`, {
		headers: { "Content-Type": "application/json" },
	});

const number = (n: unknown) => json({ n: Number(n) });

const now = () => `${new Date().toISOString().slice(0, 19)}Z`;

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Text the log carries inline: `text/*`, JSON and `+json`, whatever the
 * parameters. */
const textual = (type: string) => {
	const base = type.split(";")[0]?.trim().toLowerCase() ?? "";
	return (
		base.startsWith("text/") ||
		base === "application/json" ||
		base.endsWith("+json")
	);
};

const utf8 = (payload: ArrayBuffer) => {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
			payload,
		);
	} catch {
		return null;
	}
};

/** The body, or null if it is longer than `limit`. A longer one is still
 * read to its end, since a client may not see an answer before it has sent
 * everything. */
async function readAtMost(
	request: Request,
	limit: number,
): Promise<ArrayBuffer | null> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (request.body) {
		for await (const chunk of request.body) {
			size += chunk.byteLength;
			if (size <= limit) chunks.push(chunk);
		}
	}
	if (size > limit) return null;
	const payload = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		payload.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return payload.buffer;
}

type Row = Record<string, SqlStorageValue>;

type Entry = {
	n: number;
	time: string;
	from: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

type Presence = Record<
	string,
	{ read: number; receiving: boolean; since?: string }
>;

/** A waiting receive, attached to its socket, which is tagged with the
 * participant's name. `done` once it is answered or gone. */
type Receive = {
	after: number;
	own: boolean;
	presence: boolean;
	done?: boolean;
};

/** The close code that ends a receive a newer one replaced. */
const REPLACED = 4409;

/** One session: its log and its participants in SQLite, payloads that are
 * not inline text in R2. A waiting receive is a socket from the Worker,
 * which the object sleeps through until it answers it. */
export class Session extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.schema();
	}

	schema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS session (created TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS entries (
				n INTEGER PRIMARY KEY,
				time TEXT NOT NULL,
				sender TEXT NOT NULL,
				type TEXT NOT NULL,
				size INTEGER NOT NULL,
				filename TEXT,
				text TEXT,
				object TEXT
			);
			CREATE TABLE IF NOT EXISTS participants (
				name TEXT PRIMARY KEY,
				secret TEXT NOT NULL UNIQUE,
				inside INTEGER NOT NULL,
				entry INTEGER NOT NULL,
				read INTEGER NOT NULL,
				since TEXT NOT NULL
			);
		`);
	}

	sql(query: string, ...bindings: SqlStorageValue[]): Row[] {
		return this.ctx.storage.sql.exec(query, ...bindings).toArray();
	}

	create(): void {
		this.sql("INSERT INTO session (created) VALUES (?)", now());
		void this.expire();
	}

	/** The session ends `IDLE` after its last request, unless someone is
	 * still receiving then. */
	expire(): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + IDLE);
	}

	override async alarm(): Promise<void> {
		if (this.waiting().length > 0) await this.expire();
		else await this.end();
	}

	/** Deletes the session, payloads and all. Receives still waiting return,
	 * and the next request finds no session. */
	async end(): Promise<void> {
		const prefix = `${this.ctx.id}/`;
		for (let cursor: string | undefined; ; ) {
			const listed = await this.env.PAYLOADS.list({
				prefix,
				...(cursor !== undefined && { cursor }),
			});
			const keys = listed.objects.map((object) => object.key);
			if (keys.length > 0) await this.env.PAYLOADS.delete(keys);
			if (!listed.truncated) break;
			cursor = listed.cursor;
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.schema();
		for (const socket of this.waiting()) this.answer(socket);
	}

	override async fetch(request: Request): Promise<Response> {
		if (this.sql("SELECT 1 FROM session").length === 0) {
			return fail(404, "no such session");
		}
		void this.expire();
		const url = new URL(request.url);
		const [, , , id = "", secret, operation, ...rest] = url.pathname.split("/");
		const post = request.method === "POST";
		const get = request.method === "GET";
		if (secret === "join" && !operation && post) {
			return this.join(url.searchParams.get("as"), sessionLink(url.origin, id));
		}
		// The Worker answers a request without a secret itself.
		if (!secret || rest.length > 0) return fail(404, "no such operation");
		const known = TOKEN.test(secret)
			? this.sql("SELECT * FROM participants WHERE secret = ?", secret)[0]
			: undefined;
		if (!known) return fail(403, "this link is no participant's");
		const name = String(known.name);
		const me = `${sessionLink(url.origin, id)}/${secret}`;
		if (operation === "join" && post) return this.rejoin(known, me);
		if (operation === "leave" && post) return await this.leave(known);
		if (known.inside !== 1) {
			return fail(403, "you have left: join again with POST <your link>/join");
		}
		if (!operation && post) return this.send(name, request, url);
		if (!operation && get) return this.receive(name, url);
		if (operation && /^\d+$/.test(operation) && get) {
			return this.payload(Number(operation));
		}
		return fail(404, "no such operation");
	}

	inside(name: string): boolean {
		return (
			this.sql("SELECT inside FROM participants WHERE name = ?", name)[0]
				?.inside === 1
		);
	}

	/** Takes `name` for the caller, who gets a link of its own: a name is
	 * bound to whoever joined with it, for the whole session. */
	join(name: string | null, link: string): Response {
		if (!name) return fail(400, "name yourself with ?as=<name>");
		if (bytes(name) > MAX_NAME) {
			return fail(400, `a name is at most ${MAX_NAME} bytes`);
		}
		if (this.sql("SELECT 1 FROM participants WHERE name = ?", name).length) {
			return fail(409, `${name} is taken in this session`);
		}
		const secret = token();
		const n = this.append(name, JOIN, 0);
		this.sql(
			`INSERT INTO participants (name, secret, inside, entry, read, since)
			VALUES (?, ?, 1, ?, 0, ?)`,
			name,
			secret,
			n,
			now(),
		);
		this.look();
		return json({ n, name, read: 0, link: `${link}/${secret}` });
	}

	/** Joins again, after leaving, under the name the link is bound to. */
	rejoin(known: Row, me: string): Response {
		const name = String(known.name);
		const read = Number(known.read);
		if (known.inside === 1)
			return json({ n: Number(known.entry), name, read, link: me });
		const n = this.append(name, JOIN, 0);
		this.sql(
			"UPDATE participants SET inside = 1, entry = ?, since = ? WHERE name = ?",
			n,
			now(),
			name,
		);
		this.look();
		return json({ n, name, read, link: me });
	}

	/** The last to leave ends the session. */
	async leave(known: Row): Promise<Response> {
		const name = String(known.name);
		if (known.inside === 0) return number(known.entry);
		const n = this.append(name, LEAVE, 0);
		this.sql(
			"UPDATE participants SET inside = 0, entry = ? WHERE name = ?",
			n,
			name,
		);
		this.look();
		if (this.sql("SELECT 1 FROM participants WHERE inside = 1").length === 0) {
			await this.end();
		}
		return number(n);
	}

	async send(name: string, request: Request, url: URL): Promise<Response> {
		const filename = url.searchParams.get("filename");
		if (filename !== null && bytes(filename) > MAX_NAME) {
			return fail(400, `a file name is at most ${MAX_NAME} bytes`);
		}
		const payload = await readAtMost(request, MAX_PAYLOAD);
		if (!payload) return fail(413, `a payload is at most ${MAX_PAYLOAD} bytes`);
		// curl sends this type unless told otherwise, which says nothing.
		const given = request.headers.get("Content-Type");
		const type =
			!given || given.startsWith("application/x-www-form-urlencoded")
				? DEFAULT_TYPE
				: given;
		const text =
			textual(type) && payload.byteLength <= MAX_INLINE ? utf8(payload) : null;
		let object: string | null = null;
		if (text === null && payload.byteLength > 0) {
			// Stored before its entry is numbered, so under a key of its own.
			object = `${this.ctx.id}/${crypto.randomUUID()}`;
			await this.env.PAYLOADS.put(object, payload);
		}
		const n = this.append(
			name,
			type,
			payload.byteLength,
			filename,
			text,
			object,
		);
		this.look();
		return number(n);
	}

	append(
		sender: string,
		type: string,
		size: number,
		filename: string | null = null,
		text: string | null = null,
		object: string | null = null,
	): number {
		const [row] = this.sql(
			`INSERT INTO entries (n, time, sender, type, size, filename, text, object)
			VALUES ((SELECT COALESCE(MAX(n), 0) + 1 FROM entries), ?, ?, ?, ?, ?, ?, ?)
			RETURNING n`,
			now(),
			sender,
			type,
			size,
			filename,
			text,
			object,
		);
		return Number(row?.n);
	}

	async payload(n: number): Promise<Response> {
		const [row] = this.sql("SELECT * FROM entries WHERE n = ?", n);
		if (!row) return fail(404, "no such entry");
		// The type is the sender's: a payload opened as a page, such as HTML,
		// runs in a sandbox of its own, never as the relay's site.
		// Its URL holds the caller's own link, which no page it opens learns.
		const headers = new Headers({
			"Content-Type": String(row.type),
			"Content-Security-Policy": "sandbox",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		if (row.filename !== null) {
			headers.set(
				"Content-Disposition",
				`inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
			);
		}
		if (row.text !== null) return new Response(String(row.text), { headers });
		if (row.object === null) return new Response(null, { headers });
		const object = await this.env.PAYLOADS.get(String(row.object));
		if (!object) return fail(404, "no such entry");
		return new Response(object.body, { headers });
	}

	/** Starts a receive: the entries after `after`, and the presence last,
	 * sent over the socket it returns once there is something to send. */
	receive(name: string, url: URL): Response {
		const after = url.searchParams.get("after") ?? "0";
		const wait = url.searchParams.get("wait");
		if (!/^\d+$/.test(after)) return fail(400, "after is a number");
		if (wait === "" || (wait !== null && !(Number(wait) >= 0))) {
			return fail(400, "wait is a number of seconds");
		}

		const last = Number(
			this.sql("SELECT COALESCE(MAX(n), 0) AS n FROM entries")[0]?.n,
		);
		const read = Math.min(Number(after), last);
		const changed = this.sql(
			"UPDATE participants SET read = ? WHERE name = ? AND read < ? RETURNING 1",
			read,
			name,
			read,
		);
		if (changed.length > 0) this.stir(name);

		const { 0: client, 1: server } = new WebSocketPair();
		const receive: Receive = {
			after: Number(after),
			own: url.searchParams.get("own") === "1",
			presence: url.searchParams.get("presence") === "1",
		};
		const replaced = this.waiting(name);
		this.ctx.acceptWebSocket(server, [name]);
		server.serializeAttachment(receive);
		for (const socket of replaced) {
			this.finish(socket);
			socket.close(REPLACED, "a newer receive replaced this one");
		}
		if (replaced.length === 0 && !receive.presence) this.stir(name);
		if (this.ready(server)) this.answer(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Any message asks for the answer now, as the Worker does when `wait`
	 * has passed. */
	override webSocketMessage(socket: WebSocket): void {
		this.answer(socket);
	}

	/** The Worker closes a receive whose caller went away. */
	override webSocketClose(socket: WebSocket): void {
		this.finish(socket);
	}

	attachment(socket: WebSocket): Receive {
		return socket.deserializeAttachment() as Receive;
	}

	/** The sockets of the receives still waiting, `name`'s alone if given. */
	waiting(name?: string): WebSocket[] {
		return this.ctx
			.getWebSockets(name)
			.filter((socket) => !this.attachment(socket).done);
	}

	entries(socket: WebSocket): Row[] {
		const [name = ""] = this.ctx.getTags(socket);
		const { after, own } = this.attachment(socket);
		if (!this.inside(name)) return [];
		return this.sql(
			"SELECT * FROM entries WHERE n > ? AND (? OR sender != ?) ORDER BY n",
			after,
			own ? 1 : 0,
			name,
		);
	}

	/** Whether a receive has something to return: entries, or that its
	 * participant is no longer inside. */
	ready(socket: WebSocket): boolean {
		const [name = ""] = this.ctx.getTags(socket);
		return !this.inside(name) || this.entries(socket).length > 0;
	}

	answer(socket: WebSocket): void {
		if (this.attachment(socket).done) return;
		const lines = this.entries(socket).map((row) => JSON.stringify(entry(row)));
		lines.push(JSON.stringify({ presence: this.presence() }));
		this.finish(socket);
		socket.send(`${lines.join("\n")}\n`);
		socket.close(1000);
	}

	/** Ends a receive. Unless a newer one replaced it, its participant is no
	 * longer receiving. */
	finish(socket: WebSocket): void {
		const receive = this.attachment(socket);
		if (receive.done) return;
		socket.serializeAttachment({ ...receive, done: true });
		const [name = ""] = this.ctx.getTags(socket);
		if (this.waiting(name).length > 0) return;
		this.sql("UPDATE participants SET since = ? WHERE name = ?", now(), name);
		if (!receive.presence) this.stir(name);
	}

	/** Answers the receives that have something to return, once an
	 * operation is done, so that the presence says what it did. */
	look(): void {
		for (const socket of this.waiting()) {
			if (this.ready(socket)) this.answer(socket);
		}
	}

	/** Answers the receives waiting for presence, except `by`'s own. */
	stir(by: string): void {
		for (const socket of this.waiting()) {
			const [name] = this.ctx.getTags(socket);
			if (this.attachment(socket).presence && name !== by) this.answer(socket);
		}
	}

	presence(): Presence {
		const presence: Presence = {};
		for (const row of this.sql(
			"SELECT * FROM participants WHERE inside = 1 ORDER BY name",
		)) {
			const name = String(row.name);
			const receiving = this.waiting(name).length > 0;
			presence[name] = {
				read: Number(row.read),
				receiving,
				...(!receiving && { since: String(row.since) }),
			};
		}
		return presence;
	}
}

const entry = (row: Row): Entry => ({
	n: Number(row.n),
	time: String(row.time),
	from: String(row.sender),
	type: String(row.type),
	size: Number(row.size),
	...(row.filename !== null && { filename: String(row.filename) }),
	...(row.text !== null && { text: String(row.text) }),
});

/** A secret of 128 random bits: a session's id, or a participant's own part
 * of the session's link. */
const token = () => {
	const random = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...random))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
};

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const [, version, first, id, secret, operation] = url.pathname.split("/");
	if (request.method === "GET" && url.pathname === "/") {
		return new Response(people, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}
	if (request.method === "GET" && url.pathname === "/byoa") {
		return new Response(script, {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	const doc = DOCS.get(url.pathname);
	if (request.method === "GET" && doc) {
		return new Response(doc, {
			headers: { "Content-Type": "text/markdown; charset=utf-8" },
		});
	}
	if (
		version === "s" ||
		(/^v\d+$/.test(version ?? "") && version !== VERSION)
	) {
		return fail(
			410,
			`byoa changed to ${VERSION}, and this request is from an older client: the spec is at ${url.origin}/transport.md, and the script at ${url.origin}/byoa`,
		);
	}
	if (version !== VERSION || first !== "s") return fail(404, "no such page");
	if (!id) {
		if (request.method !== "POST") return fail(404, "no such operation");
		const fresh = token();
		await env.SESSION.getByName(fresh).create();
		return new Response(`${sessionLink(url.origin, fresh)}\n`, {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	if (!TOKEN.test(id)) return fail(404, "no such session");
	// Answered here, without waking the session.
	if (!secret) return fail(403, "join first: POST <link>/join?as=<name>");
	const session = env.SESSION.getByName(id);
	if (
		request.method === "GET" &&
		secret !== undefined &&
		TOKEN.test(secret) &&
		operation === undefined
	) {
		return receive(request, session);
	}
	return session.fetch(request);
}

/** A receive waits here, in the Worker, which costs nothing while it waits,
 * on a socket to its session, which sleeps until it sends the answer. A
 * socket that closes with no answer, as when the relay is deployed, is
 * opened again. */
async function receive(
	request: Request,
	session: DurableObjectStub<Session>,
): Promise<Response> {
	const wait = new URL(request.url).searchParams.get("wait");
	for (;;) {
		const upgrade = await session.fetch(request.url, {
			headers: { Upgrade: "websocket" },
		});
		const socket = upgrade.webSocket;
		if (!socket) return upgrade;
		socket.accept();
		const answer = await new Promise<Response | null>((resolve) => {
			const timer =
				wait === null
					? undefined
					: setTimeout(() => socket.send("now"), Number(wait) * 1000);
			// Where the runtime doesn't say that the caller went away, as
			// wrangler dev doesn't, a receive cut off counts as receiving until
			// the participant's next one.
			const abort = () => {
				socket.close();
				settle(null);
			};
			const settle = (response: Response | null) => {
				if (timer !== undefined) clearTimeout(timer);
				request.signal.removeEventListener("abort", abort);
				resolve(response);
			};
			request.signal.addEventListener("abort", abort);
			socket.addEventListener("message", (event) =>
				settle(
					new Response(String(event.data), {
						headers: { "Content-Type": "application/jsonl; charset=utf-8" },
					}),
				),
			);
			socket.addEventListener("close", (event) =>
				settle(
					event.code === REPLACED
						? fail(409, "a newer receive replaced this one")
						: null,
				),
			);
		});
		if (answer) return answer;
		if (request.signal.aborted) return new Response(null);
		await pause(1000);
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}
		let response: Response;
		try {
			response = await route(request, env);
		} catch {
			// Such as when the relay is over its limits.
			response = fail(503, "the relay can't answer right now");
			response.headers.set("Retry-After", "60");
		}
		// A failed receive, or fetch, of any version.
		if (
			request.method === "GET" &&
			/^\/(v\d+\/)?s\//.test(new URL(request.url).pathname) &&
			response.status >= 400
		) {
			await pause(FAILED_RECEIVE);
		}
		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
