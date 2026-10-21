// The spec's secrets: the client's public key, openssl encrypting to it as
// the spec shows, and the client opening the result.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET, Secrets } from "../client/index.ts";

const work = mkdtempSync(join(tmpdir(), "secrets-"));
const secrets = new Secrets({
	send: async (body) => {
		writeFileSync(join(work, "key.pem"), body as string);
		return 12;
	},
});
const key = await secrets.publish();
writeFileSync(join(work, "secret"), "sk_0123456789abcdef");
const data = execFileSync(
	"sh",
	[
		"-c",
		`openssl pkeyutl -encrypt -pubin -inkey key.pem \
		-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 \
		-in secret | base64 | tr -d '\\n'`,
	],
	{ cwd: work },
).toString();
const entry = (key: number) => ({
	n: 13,
	time: "",
	from: "agent",
	type: SECRET,
	size: 0,
	text: JSON.stringify({ key, name: "elevenlabs", data }),
});
const opened = await secrets.open(entry(key));
const other = await secrets.open(entry(key + 1));
const ok =
	opened?.name === "elevenlabs" &&
	opened.value === "sk_0123456789abcdef" &&
	other === null;
console.log(
	`${ok ? "ok  " : "FAIL"}  a secret from openssl opens, to its key only`,
);
if (!ok) process.exit(1);
