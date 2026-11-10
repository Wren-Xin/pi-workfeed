/**
 * Stub for `typebox`: the extension builds a tool parameter schema with `Type.*`.
 * Every builder is chainable and returns a plain object — the tests exercise behaviour,
 * not schema validation, and no host is installed to validate against.
 */
const node = () => {
	const o = { type: "unknown" };
	const proxy = new Proxy(o, {
		get(target, key) {
			if (key in target) return target[key];
			return (...args) => ({ ...target, [String(key)]: args[0] });
		},
	});
	return proxy;
};

export const Type = new Proxy(
	{},
	{
		get: (_t, key) => {
			if (key === "Object") return (props = {}, opts = {}) => ({ type: "object", properties: props, ...opts });
			if (key === "Array") return (items, opts = {}) => ({ type: "array", items, ...opts });
			if (key === "String") return (opts = {}) => ({ type: "string", ...opts });
			if (key === "Number") return (opts = {}) => ({ type: "number", ...opts });
			if (key === "Boolean") return (opts = {}) => ({ type: "boolean", ...opts });
			return () => node();
		},
	},
);

export default { Type };
