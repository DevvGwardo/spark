/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: the Pydantic models in hermes-bridge/bridge_errors.py,
 * via shared/hermes-errors.schema.json.
 * Regenerate with: npm run gen:hermes-contract
 * CI fails if this file is stale.
 */

import { z } from 'zod'

/** The closed set of Hermes error codes. */
export const HERMES_ERROR_CODES = [
  'BRIDGE_UNREACHABLE',
  'BRIDGE_STARTING',
  'BRIDGE_AUTH',
  'UPSTREAM_TIMEOUT',
  'MODEL_INCOMPATIBLE',
  'PROVIDER_ERROR',
  'APPROVAL_EXPIRED',
  'VALIDATION',
  'INTERNAL',
] as const

export type HermesErrorCode = (typeof HERMES_ERROR_CODES)[number]

/**
 * Codes for which retrying the identical request could plausibly succeed.
 * The UI uses this to decide whether to offer a Retry button.
 */
export const HERMES_RETRYABLE_CODES: ReadonlySet<HermesErrorCode> = new Set([
  'BRIDGE_STARTING',
  'BRIDGE_UNREACHABLE',
  'PROVIDER_ERROR',
  'UPSTREAM_TIMEOUT',
])

export const hermesErrorEnvelopeShape = z.object({ "error": z.object({ "code": z.string(), "details": z.union([z.object({ "approval_id": z.union([z.string(), z.null()]).default(null), "bridge_url": z.union([z.string(), z.null()]).default(null), "current_model": z.union([z.string(), z.null()]).default(null), "provider_message": z.union([z.string(), z.null()]).default(null), "provider_status": z.union([z.number().int(), z.null()]).default(null), "retry_after_ms": z.union([z.number().int(), z.null()]).default(null), "suggested_models": z.union([z.array(z.any()), z.null()]).default(null) }).catchall(z.any()).describe("Structured extras a caller can act on.\n\nEvery field is optional because which ones are populated depends on the code.\nThey are typed as open objects rather than rejected when absent, because\nhermes-agent and the gateway can add context without a bridge release."), z.null()]).default(null), "message": z.string(), "retryable": z.boolean().default(false) }).describe("The inner body: what went wrong, and whether trying again could work.") }).describe("The wire shape: always wrapped in `error`.")

/** Narrows the generated shape's open `code` to the closed union. */
export const hermesErrorEnvelope = hermesErrorEnvelopeShape.extend({
  error: hermesErrorEnvelopeShape.shape.error.extend({
    code: z.enum(HERMES_ERROR_CODES),
  }),
}) as unknown as z.ZodType<{
  error: {
    code: HermesErrorCode
    message: string
    retryable: boolean
    details?: HermesErrorDetails | null
  }
}>

/**
 * Structured extras. The declared fields are typed; the index signature is what
 * keeps fields hermes-agent adds upstream from being a type error, matching the
 * open `details` model on the Python side.
 */
export interface HermesErrorDetails {
  current_model?: string | null
  suggested_models?: string[] | null
  bridge_url?: string | null
  retry_after_ms?: number | null
  approval_id?: string | null
  provider_message?: string | null
  provider_status?: number | null
  [key: string]: unknown
}

export type HermesErrorEnvelopeShape = z.infer<typeof hermesErrorEnvelope>

/** True when a value already satisfies the error contract. */
export function isHermesErrorEnvelope(value: unknown): value is HermesErrorEnvelopeShape {
  return hermesErrorEnvelope.safeParse(value).success
}

/** Whether a code is retryable, per the contract. */
export function isRetryableHermesCode(code: string): boolean {
  return HERMES_RETRYABLE_CODES.has(code as HermesErrorCode)
}
