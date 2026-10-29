/// <reference lib="dom" />
/// <reference types="node" />
/**
 * Types for `rosezm/runtime` - the runtime surface a page's compiled script
 * and the generated server entry both draw on: signals, stores, effects,
 * network listeners, the i18n helpers and the error types.
 *
 * The declarations live in the package-level `rosezm.d.ts` as ambient
 * globals (that is exactly what the generated code reads: bare `$store`,
 * `$data`, `$t`...), so this module references it - a downstream project
 * gets the same ambient surface it would from the root types, and
 * `import "rosezm/runtime"` type-checks with no `declare module` shim
 * (BUG.md CE).
 */
/// <reference path="./rosezm.d.ts" />
export {};
