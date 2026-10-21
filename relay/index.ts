import { DurableObject } from "cloudflare:workers";
import spec from "../transport.md";

const MAX_PAYLOAD = 10 * 1024 * 1024;
const MAX_INLINE = 64 * 1024;
/** How long a session lasts without a new entry. */
const IDLE = 30 * 24 * 60 * 60 * 1000;
const MAX_NAME = 256;
const DEFAULT_TYPE = "text/plain; charset=utf-8";
const JOIN = "application/vnd.byoa.join";
const LEAVE = "application/vnd.byoa.leave";

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

const number = (n: unknown) =>
	new Response(`${JSON.stringify({ n: Number(n) })}\n`, {
		headers: { "Content-Type": "application/json" },
	});

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

/** A receive that is waiting. `wake` makes it look again, and `stirred`
 * says that someone's presence changed while it waited. */
type Receive = {
	name: string;
	presence: boolean;
	wake: () => void;
	stirred: boolean;
};

/** One session: its log and its participants in SQLite, payloads that are
 * not inline text in R2. Who is receiving lives only in memory, since no
 * receive outlives the object. */
export class Session extends DurableObject<Env> {
	receives = new Map<string, Receive>();

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

	/** The session ends `IDLE` after its last entry, or its creation. */
	expire(): Promise<void> {
		return this.ctx.storage.setAlarm(Date.now() + IDLE);
	}

	override async alarm(): Promise<void> {
		await this.end();
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
		for (const receive of this.receives.values()) receive.wake();
	}

	override async fetch(request: Request): Promise<Response> {
		if (this.sql("SELECT 1 FROM session").length === 0) {
			return fail(404, "no such session");
		}
		const url = new URL(request.url);
		const [, , operation, ...rest] = url.pathname.split("/");
		const name = url.searchParams.get("as");
		if (!name) return fail(400, "name yourself with ?as=<name>");
		if (bytes(name) > MAX_NAME) {
			return fail(400, `a name is at most ${MAX_NAME} bytes`);
		}
		const post = request.method === "POST";
		const get = request.method === "GET";
		if (rest.length > 0) return fail(404, "no such operation");
		if (operation === "join" && post) return this.join(name);
		if (operation === "leave" && post) return await this.leave(name);
		if (!this.inside(name)) return fail(403, "you have not joined");
		if (!operation && post) return this.send(name, request, url);
		if (!operation && get) return this.receive(name, request, url);
		if (operation && /^\d+$/.test(operation) && get) {
			return this.payload(Number(operation));
		}
		return fail(404, "no such operation");
	}

	participant(name: string): Row | undefined {
		return this.sql("SELECT * FROM participants WHERE name = ?", name)[0];
	}

	inside(name: string): boolean {
		return this.participant(name)?.inside === 1;
	}

	join(name: string): Response {
		const known = this.participant(name);
		if (known?.inside === 1) return number(known.entry);
		const n = this.append(name, JOIN, 0);
		this.sql(
			`INSERT INTO participants (name, inside, entry, read, since)
			VALUES (?, 1, ?, 0, ?)
			ON CONFLICT (name) DO UPDATE SET inside = 1, entry = ?, since = ?`,
			name,
			n,
			now(),
			n,
			now(),
		);
		return number(n);
	}

	/** The last to leave ends the session. */
	async leave(name: string): Promise<Response> {
		const known = this.participant(name);
		if (!known) return fail(403, "you have not joined");
		if (known.inside === 0) return number(known.entry);
		const n = this.append(name, LEAVE, 0);
		this.sql(
			"UPDATE participants SET inside = 0, entry = ? WHERE name = ?",
			n,
			name,
		);
		this.receives.get(name)?.wake();
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
		for (const receive of this.receives.values()) receive.wake();
		void this.expire();
		return Number(row?.n);
	}

	async payload(n: number): Promise<Response> {
		const [row] = this.sql("SELECT * FROM entries WHERE n = ?", n);
		if (!row) return fail(404, "no such entry");
		const headers = new Headers({ "Content-Type": String(row.type) });
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

	/** The entries after `after`, and the presence last. Waits until there
	 * is something to return, at most `wait` seconds. */
	async receive(name: string, request: Request, url: URL): Promise<Response> {
		const after = url.searchParams.get("after") ?? "0";
		const wait = url.searchParams.get("wait");
		if (!/^\d+$/.test(after)) return fail(400, "after is a number");
		const seconds = wait === null ? Number.POSITIVE_INFINITY : Number(wait);
		if (wait === "" || !(seconds >= 0)) {
			return fail(400, "wait is a number of seconds");
		}
		const own = url.searchParams.get("own") === "1";
		const deadline = Date.now() + seconds * 1000;

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

		const receive: Receive = {
			name,
			presence: url.searchParams.get("presence") === "1",
			wake: () => {},
			stirred: false,
		};
		const replaced = this.receives.get(name);
		this.receives.set(name, receive);
		if (replaced) replaced.wake();
		else if (!receive.presence) this.stir(name);
		// Where the runtime doesn't say that the caller went away, as wrangler
		// dev doesn't, a receive cut off counts as receiving until the
		// participant's next one.
		const abort = () => receive.wake();
		request.signal.addEventListener("abort", abort);

		try {
			for (;;) {
				if (this.receives.get(name) !== receive) {
					return fail(409, "a newer receive replaced this one");
				}
				const entries = this.inside(name)
					? this.sql(
							"SELECT * FROM entries WHERE n > ? AND (? OR sender != ?) ORDER BY n",
							Number(after),
							own ? 1 : 0,
							name,
						)
					: [];
				if (
					entries.length > 0 ||
					receive.stirred ||
					!this.inside(name) ||
					request.signal.aborted ||
					Date.now() >= deadline
				) {
					const lines = entries.map((row) => JSON.stringify(entry(row)));
					lines.push(JSON.stringify({ presence: this.presence() }));
					return new Response(`${lines.join("\n")}\n`, {
						headers: { "Content-Type": "application/jsonl; charset=utf-8" },
					});
				}
				await new Promise<void>((resolve) => {
					receive.wake = resolve;
					if (Number.isFinite(deadline)) {
						const timer = setTimeout(resolve, deadline - Date.now());
						receive.wake = () => {
							clearTimeout(timer);
							resolve();
						};
					}
				});
			}
		} finally {
			request.signal.removeEventListener("abort", abort);
			if (this.receives.get(name) === receive) {
				this.receives.delete(name);
				this.sql(
					"UPDATE participants SET since = ? WHERE name = ?",
					now(),
					name,
				);
				if (!receive.presence) this.stir(name);
			}
		}
	}

	/** Wakes the receives waiting for presence, except `by`'s own. */
	stir(by: string): void {
		for (const receive of this.receives.values()) {
			if (receive.presence && receive.name !== by) {
				receive.stirred = true;
				receive.wake();
			}
		}
	}

	presence(): Presence {
		const presence: Presence = {};
		for (const row of this.sql(
			"SELECT * FROM participants WHERE inside = 1 ORDER BY name",
		)) {
			const name = String(row.name);
			const receiving = this.receives.has(name);
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

/** A session's id, its whole secret: 128 random bits. */
const newId = () => {
	const random = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...random))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
};

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const [, id] = url.pathname.split("/");
	if (!id) {
		if (request.method === "GET") {
			return new Response(spec, {
				headers: { "Content-Type": "text/markdown; charset=utf-8" },
			});
		}
		if (request.method === "POST") {
			const fresh = newId();
			await env.SESSION.getByName(fresh).create();
			return new Response(`${url.origin}/${fresh}\n`, {
				headers: { "Content-Type": "text/plain; charset=utf-8" },
			});
		}
		return fail(404, "no such operation");
	}
	if (!/^[\w-]{22}$/.test(id)) return fail(404, "no such session");
	return env.SESSION.getByName(id).fetch(request);
}

export default {
	async fetch(request, env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS });
		}
		const response = await route(request, env);
		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
		return new Response(response.body, {
			status: response.status,
			headers,
		});
	},
} satisfies ExportedHandler<Env>;
