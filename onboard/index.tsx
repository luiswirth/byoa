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
	/** What the person gives their agent: short, pointing at the service's
	 * page for agents. */
	prompt: string;
	/** What the person should know before, such as an account it needs. */
	note?: ReactNode;
};

const STEPS = [
	["Copy", "the prompt above."],
	["Paste", "it into your agent, such as Claude Code."],
	["Open", "the link your agent gives you. It sets up everything else."],
] as const;

export function Onboard({
	name,
	title,
	description,
	prompt,
	note,
}: OnboardProps) {
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
				<section className="flex flex-col gap-2 rounded-2xl border bg-card/60 p-2 shadow-2xl shadow-black/20 backdrop-blur">
					<span className="px-2 pt-1 text-xs font-medium text-muted-foreground">
						Give your agent this
					</span>
					<pre className="rounded-xl bg-background/80 p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap">
						{prompt}
					</pre>
					<Copy text={prompt} />
				</section>
				<ol className="grid gap-5 sm:grid-cols-3">
					{STEPS.map(([verb, rest], i) => (
						<li key={verb} className="flex gap-3 text-sm sm:flex-col sm:gap-2">
							<span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-muted-foreground">
								{i + 1}
							</span>
							<span className="text-muted-foreground">
								<span className="font-medium text-foreground">{verb}</span>{" "}
								{rest}
							</span>
						</li>
					))}
				</ol>
				{note && <p className="text-sm text-muted-foreground">{note}</p>}
				<footer className="text-xs text-muted-foreground">
					<a
						className="underline-offset-4 hover:text-foreground hover:underline"
						href="https://github.com/luiswirth/byoa"
					>
						byoa
					</a>
					: bring your own agent
				</footer>
			</div>
		</div>
	);
}

function Copy({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary font-medium text-primary-foreground transition-all outline-none hover:bg-primary/85 focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px"
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
			{copied ? "Copied" : "Copy the prompt"}
		</button>
	);
}
