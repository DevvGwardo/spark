/**
 * Hermes bridge REST client, split by domain (hardening spec 6.5).
 *
 * Import from `@/lib/hermes-api`; this barrel re-exports every domain module.
 * The transport internals in `./core` (`hermesFetch`, `abortAfter`,
 * `coalesceHermesFetch`) are deliberately not re-exported.
 */

export { HermesApiError, HERMES_FETCH_TIMEOUT_MS } from './core';
export * from './approvals';
export * from './providers';
export * from './portal';
export * from './cron';
export * from './sessions';
export * from './workspace';
export * from './usage';
export * from './skills';
export * from './mcp';
export * from './memory';
export * from './checkpoints';
export * from './extensions';
export * from './projects';
export * from './ops';
