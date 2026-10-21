/** The page a person meets first on any byoa service: one prompt to give
 * their agent, which does everything else. Styled with Tailwind and shadcn's
 * theme variables, so it takes on each service's theme; the service adds this
 * directory to Tailwind's sources, as `@source "../node_modules/byoa/onboard"`. */

import { type ReactNode, useState } from "react";

export type OnboardProps = {
	/** The service, as the person knows it, such as `voice.senses.sh`. */
	name: string;
	/** What the person gets, in a few words. */
	title: string;
	/** One or two sentences on it. */
	description: string;
	/** The session's token. The page offers it on its own, and in the prompt
	 * that points the agent at the service's page for agents. */
	token: string;
	/** What the person should know before, such as an account it needs. */
	note?: ReactNode;
};

const STEPS = [
	["Copy", "the prompt above."],
	["Paste", "it into your agent, such as Claude Code."],
	["Open", "the link your agent gives you. It sets up everything else."],
] as const;

const NAME = "byoa-name";

/** Asks the person for the name they take part under, once per browser, and
 * renders the page under it. Every person in a session has a name of their
 * own, as every agent has. */
export function Named({
	service,
	children,
}: {
	/** The service, as the person knows it, such as `voice.senses.sh`. */
	service: string;
	children: (name: string) => ReactNode;
}) {
	const [name, setName] = useState(() => localStorage.getItem(NAME));
	const [draft, setDraft] = useState("");
	if (name) return children(name);
	const chosen = draft.trim();
	return (
		<Frame
			name={service}
			title="What's your name?"
			description="Everyone in the session, people and agents, sees you under it."
		>
			<form
				className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur sm:flex-row"
				onSubmit={(event) => {
					event.preventDefault();
					if (!chosen) return;
					localStorage.setItem(NAME, chosen);
					setName(chosen);
				}}
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: the one thing on the page
					autoFocus
					className="h-11 flex-1 rounded-xl bg-background/80 px-4 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
					placeholder="Your name"
					maxLength={64}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				/>
				<button
					type="submit"
					disabled={!chosen}
					className="h-11 rounded-xl bg-primary px-6 font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:opacity-50"
				>
					Continue
				</button>
			</form>
		</Frame>
	);
}

/** The look every page of a person's onboarding shares. */
function Frame({
	name,
	title,
	description,
	children,
}: {
	name: string;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="relative flex min-h-dvh items-center justify-center overflow-hidden px-6 py-16">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0"
				style={{
					background:
						"radial-gradient(60rem 30rem at 50% -10%, var(--onboard-glow, oklch(0.6 0.17 265 / 0.22)), transparent 70%)",
				}}
			/>
			<div className="relative flex w-full max-w-xl flex-col gap-10">
				<header className="flex flex-col gap-4">
					<span className="font-mono text-sm text-muted-foreground">
						{name}
					</span>
					<h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
						{title}
					</h1>
					<p className="text-lg text-pretty text-muted-foreground">
						{description}
					</p>
				</header>
				{children}
				<footer className="text-xs text-muted-foreground">
					<a
						className="underline-offset-4 hover:text-foreground hover:underline"
						href="https://byoa.senses.sh"
					>
						byoa
					</a>
					: bring your own agent
				</footer>
			</div>
		</div>
	);
}

export function Onboard({
	name,
	title,
	description,
	token,
	note,
}: OnboardProps) {
	const prompt = `Read ${location.origin}/agents.md and join with session token ${token}`;
	return (
		<Frame name={name} title={title} description={description}>
			<section className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
				<span className="px-2 pt-1 text-xs font-medium text-muted-foreground">
					Give your agent this
				</span>
				<pre className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap">
					{prompt}
				</pre>
				<Copy text={prompt} label="Copy the prompt" primary />
			</section>
			<section className="flex flex-col gap-2 rounded-2xl border bg-card/40 p-2 sm:flex-row sm:items-center">
				<div className="flex min-w-0 flex-1 flex-col px-2 py-1">
					<span className="text-xs font-medium text-muted-foreground">
						Session token
					</span>
					<code className="truncate font-mono text-sm">{token}</code>
				</div>
				<Copy text={token} label="Copy the token" />
			</section>
			<ol className="grid gap-5 sm:grid-cols-3">
				{STEPS.map(([verb, rest], i) => (
					<li key={verb} className="flex gap-3 text-sm sm:flex-col sm:gap-2">
						<span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-muted-foreground">
							{i + 1}
						</span>
						<span className="text-muted-foreground">
							<span className="font-medium text-foreground">{verb}</span> {rest}
						</span>
					</li>
				))}
			</ol>
			{note && <p className="text-sm text-muted-foreground">{note}</p>}
		</Frame>
	);
}

function Copy({
	text,
	label,
	primary = false,
}: {
	text: string;
	label: string;
	primary?: boolean;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={`flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl px-4 font-medium transition-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px ${primary ? "bg-primary text-primary-foreground hover:bg-primary/85" : "border bg-background/80 hover:bg-muted"}`}
			onClick={async () => {
				await navigator.clipboard.writeText(text);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}}
		>
			<svg
				aria-hidden
				viewBox="0 0 24 24"
				className="size-4"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{copied ? (
					<path d="M20 6 9 17l-5-5" />
				) : (
					<>
						<rect width="14" height="14" x="8" y="8" rx="2" />
						<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
					</>
				)}
			</svg>
			{copied ? "Copied" : label}
		</button>
	);
}
