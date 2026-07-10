import {
	loadSecrets,
	SecretObfuscator,
} from "@oh-my-pi/pi-coding-agent/secrets";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/**
 * Control / instruction delimiters that must never reach the provider or the
 * persisted sidecar as raw tokens. Neutralized by inserting a zero-width space
 * so surrounding prose remains readable while the instruction form is broken.
 */
const CONTROL_DELIMITERS: readonly string[] = [
	"```system",
	"```assistant",
	"```user",
	"<|system|>",
	"<|assistant|>",
	"<|user|>",
	"<|end|>",
	"[INST]",
	"[/INST]",
	"<<SYS>>",
	"<</SYS>>",
	"### System:",
	"### User:",
	"### Assistant:",
	"SYSTEM:",
	"ASSISTANT:",
];

export interface ReflectionSanitizer {
	/** Obfuscate secrets and neutralize control delimiters. */
	sanitize(text: string): string;
	/** True when any secrets were loaded. */
	hasSecrets(): boolean;
}

/**
 * Reload project + global secret entries and return a sanitizer for one dispatch.
 * Never deobfuscate reflection output.
 *
 * `agentDir` is a test seam; production always uses getAgentDir().
 */
export async function createReflectionSanitizer(
	cwd: string,
	agentDir: string = getAgentDir(),
): Promise<ReflectionSanitizer> {
	const entries = await loadSecrets(cwd, agentDir);
	const obfuscator = new SecretObfuscator(entries);
	return {
		hasSecrets: () => obfuscator.hasSecrets(),
		sanitize(text: string): string {
			let out = neutralizeControlDelimiters(text);
			out = obfuscator.obfuscate(out);
			return out;
		},
	};
}

/** Pure delimiter neutralization (exported for tests). */
export function neutralizeControlDelimiters(text: string): string {
	let out = text;
	for (const token of CONTROL_DELIMITERS) {
		if (!out.includes(token)) continue;
		out = out.split(token).join(insertBreaker(token));
	}
	// Strip common ANSI / C0 control sequences that can smuggle instructions.
	const esc = String.fromCharCode(0x1b);
	out = out.split(`${esc}[`).reduce((acc, part, index) => {
		if (index === 0) return part;
		// Drop CSI sequences: ESC [ ... final-byte in @-~
		const m = part.match(/^[0-9;?]*[ -/]*[@-~]([\s\S]*)$/);
		return m ? acc + m[1] : `${acc}[${part}`;
	}, "");
	let cleaned = "";
	for (let i = 0; i < out.length; i++) {
		const code = out.charCodeAt(i);
		// Keep tab/newline/CR; drop other C0 + DEL.
		if (
			code === 9 ||
			code === 10 ||
			code === 13 ||
			(code >= 32 && code !== 127)
		) {
			cleaned += out[i];
		}
	}
	return cleaned;
}

function insertBreaker(token: string): string {
	if (token.length <= 1) return `${token}\u200b`;
	return `${token.slice(0, 1)}\u200b${token.slice(1)}`;
}
