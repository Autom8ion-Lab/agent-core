// Module-resolution hook for `npm test` (node --test with native TS type-stripping).
//
// Source files in src/ use EXTENSIONLESS relative imports across modules (e.g. notify-policy →
// "../notify") — that's the repo convention, and it's load-bearing: FRIDAY/TUESDAY/CLARA typecheck
// these sources through their file: link WITHOUT allowImportingTsExtensions, so a literal ".ts"
// specifier would be a TS5097 error in every consuming app. Node's ESM resolver, however, demands
// explicit extensions. This hook bridges the two: when a relative specifier misses, retry with
// ".ts" and "/index.ts" appended. Test-runner only — apps bundle these sources with their own
// resolvers and never see this file.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const retryable = err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "ERR_UNSUPPORTED_DIR_IMPORT";
    if (!retryable || !specifier.startsWith(".") || /\.[cm]?[jt]s$/.test(specifier)) throw err;
    for (const suffix of [".ts", "/index.ts"]) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch {
        /* try the next form */
      }
    }
    throw err;
  }
}
