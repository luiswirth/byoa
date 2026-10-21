// byoa for Claude Code: the session's agent takes part in a byoa session.
// What others send arrives as prompts, and what the agent writes goes out as entries.

const RELAY = "https://byoa.senses.sh";
// A receive waits at most this long, within $.http.fetch's 30 seconds.
const WAIT = 25;

/** The session taken part in, or null. */
let session = null;
/** Entries of others not yet given to the agent: they go with the next text. */
let held = [];
/** Sends, in order. */
let sending = Promise.resolve();

/** The session link, from a link or a token of the default relay. */
function parse(text) {
	if (/^https?:\/\/\S+\/s\/[\w-]+$/.test(text)) return { link: text };
	if (/^[\w-]+$/.test(text)) return { link: `${RELAY}/s/${text}` };
	return null;
}

const at = (s, path = "", query = "") =>
	`${s.link}${path}?as=${encodeURIComponent(s.name)}${query}`;

const isText = (x) => x.type.startsWith("text/");

/**
 * The prompt: what others said, as they said it, named by sender once more than one is in,
 * and every entry that is no text as a line of its own.
 */
function prompt(s, entries) {
	const others = Object.keys(s.presence ?? {}).filter(
		(name) => name !== s.name,
	);
	return entries
		.map((x) => {
			if (isText(x))
				return others.length > 1
					? `${x.from}: ${x.text ?? ""}`
					: (x.text ?? "");
			const payload =
				x.text !== undefined
					? x.text
					: `${x.size} bytes${x.filename ? `, ${x.filename}` : ""}: curl -s -o <file> '${at(s, `/${x.n}`)}'`;
			return `[byoa: ${x.from} sent ${x.type}: ${payload}]`;
		})
		.join("\n\n");
}

async function receive($, s) {
	if (session !== s) return;
	let r;
	try {
		r = await $.http.fetch(at(s, "", `&after=${s.read}&wait=${WAIT}`));
	} catch {
		$.clock.after(5000, () => receive($, s));
		return;
	}
	if (session !== s) return;
	if (!r.ok) {
		// 409: another receive took over this name; 403 and 404: no longer in, or no session.
		if (r.status === 409 || r.status === 403 || r.status === 404) {
			session = null;
			$.ui.log(`left ${s.link}: ${r.text.trim()}`);
			$.ui.invalidate("ui.render");
			return;
		}
		$.clock.after(5000, () => receive($, s));
		return;
	}
	const lines = r.text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	s.presence = lines.pop()?.presence ?? s.presence;
	$.ui.invalidate("ui.render");
	const entries = lines.filter((x) => x.n > s.read);
	if (entries.length > 0) {
		s.read = entries.at(-1).n;
		held.push(...entries);
		if (held.some(isText)) await submit($, s);
	}
	$.clock.after(0, () => receive($, s));
}

/** Gives what others said to the agent as a prompt of the person's own, once it is idle. */
async function submit($, s) {
	const text = prompt(s, held);
	const taken = held;
	held = [];
	let result;
	try {
		result = await $.prompt.submit({ text, asUser: true });
	} catch (error) {
		result = { drop: String(error) };
	}
	// Dropped, as after an interruption: given again once a turn ends.
	if (result?.drop) {
		held = [...taken, ...held];
		s.dropped = true;
	}
}

async function send($, s, text) {
	const r = await $.http.fetch(at(s), {
		method: "POST",
		headers: { "Content-Type": "text/markdown; charset=utf-8" },
		body: text,
	});
	if (!r.ok) $.ui.log(`not sent: ${r.status} ${r.text.trim()}`);
}

async function join($, args) {
	const found = parse(args);
	if (!found)
		return {
			text: "Give /byoa a session link or token.",
		};
	if (session) await leave($);
	const name = "claude";
	const s = { ...found, name, read: 0, presence: {} };
	const r = await $.http.fetch(at(s, "/join"), { method: "POST" });
	if (!r.ok)
		return { text: `Could not join ${s.link}: ${r.status} ${r.text.trim()}` };
	// Joining again goes on from where this name had read.
	const now = await $.http.fetch(at(s, "", "&wait=0"));
	const presence = JSON.parse(
		now.text.trim().split("\n").at(-1) || "{}",
	).presence;
	s.read = presence?.[name]?.read ?? 0;
	session = s;
	held = [];
	$.clock.after(0, () => receive($, s));
	$.ui.invalidate("ui.render");
	// From the mod's own context: a command's hook can't start a turn.
	$.clock.after(0, () => introduce($, s));
	return {};
}

/** Tells the agent it takes part, and how. */
async function introduce($, s) {
	const name = s.name;
	await $.prompt.submit({
		text:
			`You take part in the byoa session ${s.link} as "${name}"; this plugin joined it for you and runs it.` +
			" What the others send arrives as your prompts, and every reply you write goes to them as you write it, so write for them." +
			" Don't join, receive or send your replies with curl yourself;" +
			` use curl with ?as=${name} only for what the plugin doesn't do, such as sending a file or a service's own entries.` +
			" The person leaves with /byoa leave.",
	});
}

async function leave($) {
	const s = session;
	session = null;
	held = [];
	$.ui.invalidate("ui.render");
	if (s) await $.http.fetch(at(s, "/leave"), { method: "POST" });
}

export function register(on) {
	on("session.start", async ($, e, next) => {
		await $.command.register({
			name: "byoa",
			description: "Take part in a byoa session, or leave it",
			argumentHint: "<link or token> | leave",
			immediate: true,
		});
		return next(e);
	});

	on("command.run", { command: "byoa" }, async ($, e) => {
		const args = e.args.trim();
		if (args === "leave") {
			if (!session) return { text: "Not in a byoa session." };
			await leave($);
			return { text: "Left the byoa session." };
		}
		if (!args)
			return {
				text: session
					? `In ${session.link} as ${session.name}.`
					: "Not in a byoa session.",
			};
		return join($, args);
	});

	// What the agent writes goes out, step by step, as it writes it.
	on("turn.step", async function* ($, e, next) {
		const result = yield* next(e);
		const s = session;
		if (s && !e.agentId && result.answer.trim()) {
			sending = sending.then(() => send($, s, result.answer)).catch(() => {});
		}
		return result;
	});

	// What an interrupted turn dropped goes in again once a turn ends.
	on("turn.complete", async ($, e, next) => {
		if (session?.dropped && !e.isAborted && !e.agentId && held.some(isText)) {
			session.dropped = false;
			void submit($, session);
		}
		return next(e);
	});

	on("session.end", async ($, e, next) => {
		await leave($);
		return next(e);
	});

	// One line above the prompt: the session, and who is in it.
	on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
		if (!session) return next(e);
		const { Box, Text } = $.ui.resolve(e);
		const others = Object.entries(session.presence ?? {}).filter(
			([name]) => name !== session.name,
		);
		const line = Text({
			children: [
				`byoa · ${session.name} with `,
				...(others.length === 0
					? ["nobody yet"]
					: others.flatMap(([name, p], i) => [
							...(i > 0 ? [", "] : []),
							Text({ key: name, dimColor: !p.receiving, children: [name] }),
						])),
			],
		});
		const theirs = await next(e);
		return theirs
			? Box({ flexDirection: "column", children: [line, theirs] })
			: line;
	});
}
