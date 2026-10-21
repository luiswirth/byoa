/** The client for a service's page in React: the session the page takes part
 * in, as every service's page has it. */

import { useEffect, useState, useSyncExternalStore } from "react";
import { create, type Entry, type Presence, Session } from "../client/index.ts";

export type PageSession = {
	/** The session's link, from the page's address, as `#session=<link>`. */
	link: string;
	/** The session, once joined and the log so far is in. */
	session: Session | null;
	/** Every entry so far, the page's own included. */
	entries: Entry[];
	presence: Presence;
	/** Whether nobody else has joined yet. */
	alone: boolean;
	problem: string | null;
	/** Leaves, and starts a new session. */
	leave(): Promise<void>;
};

/** The relay: the one in the page's address as `?relay=<url>`, or else the
 * local one while developing, and byoa.senses.sh once deployed. */
export const relay =
	new URLSearchParams(location.search).get("relay") ??
	(location.hostname === "localhost"
		? "http://localhost:8790"
		: "https://byoa.senses.sh");

const linkOf = () =>
	new URLSearchParams(location.hash.slice(1)).get("session") ?? "";

/** Takes part as `name` in the session in the page's address, or, without
 * one, in a new session on the relay, which then goes into the address. */
export function useSession(name: string): PageSession {
	const link = useSyncExternalStore((changed) => {
		addEventListener("hashchange", changed);
		return () => removeEventListener("hashchange", changed);
	}, linkOf);
	const [session, setSession] = useState<Session | null>(null);
	const [entries, setEntries] = useState<Entry[]>([]);
	const [presence, setPresence] = useState<Presence>({});
	const [problem, setProblem] = useState<string | null>(null);

	useEffect(() => {
		setSession(null);
		setEntries([]);
		setPresence({});
		setProblem(null);
		if (!link) {
			create(relay)
				.then((link) => {
					location.hash = new URLSearchParams({ session: link }).toString();
				})
				.catch((error: Error) => setProblem(error.message));
			return;
		}
		const session = new Session(link, name);
		const stop = session.subscribe({
			entry: () => setEntries([...session.log]),
			presence: (presence) => {
				setPresence(presence);
				if (name in presence) setSession(session);
			},
			end: setProblem,
		});
		session.join().catch((error: Error) => setProblem(error.message));
		return () => {
			stop();
			session.close();
		};
	}, [link, name]);

	return {
		link,
		session,
		entries,
		presence,
		alone: !entries.some((entry) => entry.from !== name),
		problem,
		leave: async () => {
			await session?.leave();
			location.hash = "";
		},
	};
}
