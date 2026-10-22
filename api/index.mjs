// Bundle shared application modules before Vercel traces this entry point so
// Node ESM never receives TypeScript's extensionless relative imports.
export { default } from '../.vercel-runtime/handler.mjs';
export const maxDuration = 300;
