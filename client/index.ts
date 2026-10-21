/** A page's side of a byoa session, as `transport.md` describes it. One
 * `Session` per page and participant: it owns the participant's one receive,
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

export const JOIN = "application/vnd.byoa.join";
export const LEAVE = "application/vnd.byoa.leave";

async function checked(response: Response): Promise<Response> {
	if (!response.ok) {
		throw new Error(`${response.status}: ${(await response.text()).trim()}`);
	}
	return response;
}

/** Creates a session on the relay at `relay`, and returns its link. */
export async function create(relay: string): Promise<string> {
	const response = await fetch(`${relay.replace(/\/$/, "")}/`, {
		method: "POST",
	});
	return (await (await checked(response)).text()).trim();
}

export class Session {
	readonly link: string;
	readonly name: string;
	/** Every entry received so far, the participant's own included, in
	 * order. */
	readonly log: Entry[] = [];
	presence: Presence = {};
	#subscribers = new Set<Subscriber>();
	#receiving: AbortController | null = null;

	constructor(link: string, name: string) {
		this.link = link.replace(/\/$/, "");
		this.name = name;
	}

	/** Joins, and starts receiving. Returns the join entry's number. */
	async join(): Promise<number> {
		const n = await this.#post("/join");
		this.#receive();
		return n;
	}

	/** Stops receiving, and leaves. Returns the leave entry's number. */
	async leave(): Promise<number> {
		this.close();
		return this.#post("/leave");
	}

	/** Stops receiving without leaving, as when the page closes. */
	close(): void {
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
		const url = new URL(this.link + path);
		url.searchParams.set("as", this.name);
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
