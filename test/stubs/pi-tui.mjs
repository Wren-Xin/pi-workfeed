/**
 * Stub for `@earendil-works/pi-tui`: the extensions use `Text` to render tool output.
 * Tests assert on `details`, never on rendered components, so a minimal component is fine.
 */
export class Text {
	constructor(text = "", opts = {}) {
		this.text = String(text);
		this.opts = opts;
	}
	render() {
		return this.text;
	}
	toString() {
		return this.text;
	}
}
export default { Text };
