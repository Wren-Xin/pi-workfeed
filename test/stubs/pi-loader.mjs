/**
 * Module loader hook: resolve pi's host packages to local stubs.
 *
 * The extensions import values from `@earendil-works/pi-ai`, `@earendil-works/pi-tui`,
 * `typebox` (and types from `pi-coding-agent`). Those packages are peer dependencies of
 * the *host*, not of this package, so a fresh clone — or CI — has nothing to resolve.
 * Registering this hook makes the test suite self-contained instead of requiring an
 * installed pi. It only affects test processes; nothing here is shipped.
 */
const stubs = {
	"@earendil-works/pi-ai": "./pi-ai.mjs",
	"@earendil-works/pi-tui": "./pi-tui.mjs",
	"@earendil-works/pi-coding-agent": "./pi-coding-agent.mjs",
	typebox: "./typebox.mjs",
};

export async function resolve(specifier, context, nextResolve) {
	const stub = stubs[specifier];
	if (stub) return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
	return nextResolve(specifier, context);
}
