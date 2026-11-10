/**
 * Stub for `@earendil-works/pi-ai`: only `StringEnum` is used as a value, to build the
 * tool's JSON schema. Tests never validate that schema, so returning the obvious shape
 * is enough — the point is that the suite resolves without an installed host.
 */
export const StringEnum = (values, opts) => ({ type: "string", enum: values, ...(opts ?? {}) });
export const complete = async () => ({ content: [] });
export default { StringEnum, complete };
