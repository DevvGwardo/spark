/**
 * Client-side view of the Phase 1 Hermes error envelope.
 *
 * The wire contract (`{ error: { code, message, retryable, details? } }`) is
 * generated from hermes-bridge/bridge_errors.py into server/lib/hermes-errors.gen.ts.
 * This module owns the two things the UI layers on top of it:
 *
 * - the code → title copy, shared by `ChatErrorBanner` and `HermesErrorState`
 *   so the two never drift, and
 * - `toHermesError`, which normalizes anything a query or mutation can throw
 *   (an enveloped `HermesApiError`, a legacy `{ error: string }` response, a
 *   network failure, a timeout) into the envelope's inner shape.
 */
import {
  isHermesErrorEnvelope,
  isRetryableHermesCode,
  type HermesErrorCode,
  type HermesErrorEnvelopeShape,
} from '../../server/lib/hermes-errors.gen';
import { HermesApiError } from './hermes-api';

export type { HermesErrorCode, HermesErrorEnvelopeShape };

export type HermesErrorBody = HermesErrorEnvelopeShape['error'];

export const HERMES_CODE_TITLES: Record<HermesErrorCode, string> = {
  BRIDGE_UNREACHABLE: 'Could not reach the Hermes bridge',
  BRIDGE_STARTING: 'Hermes is still starting',
  BRIDGE_AUTH: 'Hermes bridge rejected the request',
  UPSTREAM_TIMEOUT: 'The model provider timed out',
  MODEL_INCOMPATIBLE: 'That model cannot use Hermes tools',
  PROVIDER_ERROR: 'The model provider returned an error',
  APPROVAL_EXPIRED: 'That approval expired',
  VALIDATION: 'The request was rejected',
  INTERNAL: 'Hermes hit an unexpected error',
};

/** A stable, user-meaningful label for the code. */
export function titleForHermesCode(code: HermesErrorCode): string {
  return HERMES_CODE_TITLES[code] ?? HERMES_CODE_TITLES.INTERNAL;
}

/** Status → code for routes that still answer with the legacy `{ error: string }`. */
function codeForStatus(status: number): HermesErrorCode {
  if (status === 401 || status === 403) return 'BRIDGE_AUTH';
  if (status === 502 || status === 503) return 'BRIDGE_UNREACHABLE';
  if (status === 504 || status === 408) return 'UPSTREAM_TIMEOUT';
  if (status >= 400 && status < 500) return 'VALIDATION';
  return 'INTERNAL';
}

function body(code: HermesErrorCode, message: string): HermesErrorBody {
  return { code, message, retryable: isRetryableHermesCode(code) };
}

/**
 * Normalize any thrown value into the envelope's inner body. Never throws.
 *
 * `fallbackMessage` is used when the thrown value carries no usable text.
 */
export function toHermesError(err: unknown, fallbackMessage = 'Request failed'): HermesErrorBody {
  if (isHermesErrorEnvelope(err)) return err.error;

  if (err instanceof HermesApiError) {
    if (isHermesErrorEnvelope(err.data)) return err.data.error;
    return body(codeForStatus(err.status), err.message || fallbackMessage);
  }

  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException; a plain
    // abort is how hermesFetch's polyfilled timeout surfaces.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return body('UPSTREAM_TIMEOUT', 'The request timed out.');
    }
    // fetch() rejects with a TypeError when the server can't be reached at all.
    if (err.name === 'TypeError') {
      return body('BRIDGE_UNREACHABLE', err.message || fallbackMessage);
    }
    return body('INTERNAL', err.message || fallbackMessage);
  }

  if (typeof err === 'string' && err) return body('INTERNAL', err);
  return body('INTERNAL', fallbackMessage);
}
