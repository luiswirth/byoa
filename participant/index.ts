/** A participant's side of a polylogue session, as `transport.md` describes it, for
 * a page or a script. One `Session` per participant: it owns its one receive,
 * and hands every entry and every change of presence to all who subscribed. */

export type Entry = {
	n: number;
	time: string;
	from: string;
	type: string;
	size: number;
	filename?: string;
	text?: string;
};

export type Presence = Record<
	string,
	{ read: number; receiving: boolean; since?: string }
>;

export type Subscriber = {
	entry?(entry: Entry): void;
	presence?(presence: Presence): void;
	/** The receive stopped for good: the participant left, another page
	 * receives as it, or the session is gone. */
	end?(why: string): void;
};

export const JOIN = "application/vnd.polylogue.join";
export const LEAVE = "application/vnd.polylogue.leave";

/** A request the relay refused: its message is the relay's line why, as a
 * page can show it, and `status` tells the cases apart, such as 409 for a
 * name that is taken. */
export class RelayError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function checked(response: Response): Promise<Response> {
	if (!response.ok) {
		const why = (await response.text()).trim();
		throw new RelayError(
			response.status,
			why || `The relay answered ${response.status}.`,
		);
	}
	return response;
}

/** Creates a session on the relay at `relay`, and returns its link. */
export async function create(relay: string): Promise<string> {
	const response = await fetch(`${relay.replace(/\/$/, "")}/v1/s`, {
		method: "POST",
	});
	return (await (await checked(response)).text()).trim();
}

export class Session {
	/** The session's link, which everyone in it shares. */
	readonly link: string;
	readonly name: string;
	/** The participant's own link, a secret of its own: joining returns it,
	 * and every later request goes to it. Keep it to join again as the same
	 * participant, as after a reload: the name is taken for anyone else. */
	me: string | null;
	/** Every entry received so far, the participant's own included, in
	 * order. */
	readonly log: Entry[] = [];
	presence: Presence = {};
	#subscribers = new Set<Subscriber>();
	#receiving: AbortController | null = null;
	/** Set by `close`, so that a `join` still on its way starts no receive. */
	#closed = false;

	/** `me`, if given, is the participant's own link from an earlier join. */
	constructor(link: string, name: string, me: string | null = null) {
		this.link = link.replace(/\/$/, "");
		this.name = name;
		this.me = me;
	}

	/** Joins, again with the own link if it has one, and starts receiving.
	 * Returns the join entry's number. */
	async join(): Promise<number> {
		this.#closed = false;
		const url = this.me
			? `${this.me}/join`
			: `${this.link}/join?as=${encodeURIComponent(this.name)}`;
		const response = await fetch(url, { method: "POST" });
		const { n, link } = (await (await checked(response)).json()) as {
			n: number;
			link: string;
		};
		this.me = link;
		if (!this.#closed) this.#receive();
		return n;
	}

	/** Stops receiving, and leaves. Returns the leave entry's number. */
	async leave(): Promise<number> {
		this.close();
		return this.#post("/leave");
	}

	/** Stops receiving without leaving, as when the page closes. */
	close(): void {
		this.#closed = true;
		this.#receiving?.abort();
		this.#receiving = null;
	}

	/** Sends a payload, of type `type` or the body's own, and returns its
	 * entry's number. */
	send(
		body: string | Blob | ArrayBuffer,
		{ type, filename }: { type?: string; filename?: string } = {},
	): Promise<number> {
		const headers: Record<string, string> = {};
		const given = type ?? (body instanceof Blob ? body.type : "");
		if (given) headers["Content-Type"] = given;
		return this.#post("", body, headers, filename ? { filename } : {});
	}

	/** Hands `subscriber` the log so far and the presence, then everything
	 * that comes. Returns what unsubscribes it. */
	subscribe(subscriber: Subscriber): () => void {
		for (const entry of this.log) subscriber.entry?.(entry);
		subscriber.presence?.(this.presence);
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	/** The URL of entry `n`'s payload, for a link or an image. */
	url(n: number): string {
		return this.#url(`/${n}`);
	}

	async fetch(n: number): Promise<Response> {
		return checked(await fetch(this.url(n)));
	}

	#url(path: string, params: Record<string, string> = {}): string {
		if (!this.me) throw new Error("not joined");
		const url = new URL(this.me + path);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}

	async #post(
		path: string,
		body?: BodyInit,
		headers: Record<string, string> = {},
		params: Record<string, string> = {},
	): Promise<number> {
		const response = await fetch(this.#url(path, params), {
			method: "POST",
			headers,
			...(body !== undefined && { body }),
		});
		return ((await (await checked(response)).json()) as { n: number }).n;
	}

	/** The receive loop: one receive at a time, from the last entry in the
	 * log, retried with a growing pause while the relay can't be reached. */
	async #receive(): Promise<void> {
		if (this.#receiving) return;
		const receiving = new AbortController();
		this.#receiving = receiving;
		let failures = 0;
		while (!receiving.signal.aborted) {
			try {
				const after = String(this.log.at(-1)?.n ?? 0);
				const response = await fetch(
					this.#url("", { after, own: "1", presence: "1" }),
					{ signal: receiving.signal },
				);
				if ([403, 404, 409].includes(response.status)) {
					const why = (await response.text()).trim();
					if (this.#receiving === receiving) this.#receiving = null;
					for (const subscriber of this.#subscribers) subscriber.end?.(why);
					return;
				}
				const lines = (await (await checked(response)).text())
					.split("\n")
					.filter(Boolean);
				for (const line of lines) this.#take(JSON.parse(line));
				failures = 0;
			} catch {
				if (receiving.signal.aborted) return;
				await new Promise((wake) =>
					setTimeout(wake, Math.min(1000 * 2 ** failures, 30_000)),
				);
				failures += 1;
			}
		}
	}

	#take(line: Entry | { presence: Presence }): void {
		if ("presence" in line) {
			this.presence = line.presence;
			for (const subscriber of this.#subscribers) {
				subscriber.presence?.(line.presence);
			}
		} else if (line.n > (this.log.at(-1)?.n ?? 0)) {
			this.log.push(line);
			for (const subscriber of this.#subscribers) subscriber.entry?.(line);
		}
	}
}

export const KEY = "application/vnd.polylogue.key";
export const SECRET = "application/vnd.polylogue.secret+json";

const OAEP = { name: "RSA-OAEP", hash: "SHA-256" } as const;

/** A participant's side of secrets, as `transport.md` describes them: a key
 * pair that lives as long as the page, and the secrets sent to it. Optional:
 * a page that needs no secrets never makes one. */
export class Secrets {
	readonly #session: Pick<Session, "send">;
	#pair: Promise<CryptoKeyPair> | null = null;
	#published: Promise<number> | null = null;

	constructor(session: Pick<Session, "send">) {
		this.#session = session;
	}

	/** Publishes the public key, once, which asks for secrets. Returns its
	 * entry's number. */
	publish(): Promise<number> {
		this.#published ??= (async () => {
			const spki = await crypto.subtle.exportKey(
				"spki",
				(await this.#keys()).publicKey,
			);
			return this.#session.send(pem(spki), { type: KEY });
		})();
		return this.#published;
	}

	/** The secret in `entry`, if it is one sent to this participant's key. */
	async open(entry: Entry): Promise<{ name: string; value: string } | null> {
		if (entry.type.split(";")[0] !== SECRET || !entry.text) return null;
		if (!this.#published) return null;
		const { key, name, data } = JSON.parse(entry.text) as {
			key: number;
			name: string;
			data: string;
		};
		if (key !== (await this.#published)) return null;
		const plain = await crypto.subtle.decrypt(
			OAEP,
			(await this.#keys()).privateKey,
			Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
		);
		return { name, value: new TextDecoder().decode(plain) };
	}

	#keys(): Promise<CryptoKeyPair> {
		this.#pair ??= crypto.subtle.generateKey(
			{
				...OAEP,
				modulusLength: 3072,
				publicExponent: new Uint8Array([1, 0, 1]),
			},
			false,
			["encrypt", "decrypt"],
		);
		return this.#pair;
	}
}

function pem(spki: ArrayBuffer): string {
	const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}
