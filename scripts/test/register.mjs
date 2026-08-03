// Registers the .ts-extension resolver hook for `npm test` (node --test). See ts-ext-hooks.mjs
// for why this exists. Wired via the test script's `--import ./scripts/test/register.mjs`.
import { register } from "node:module";

register(new URL("./ts-ext-hooks.mjs", import.meta.url));
