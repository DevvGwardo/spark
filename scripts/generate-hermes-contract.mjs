/**
 * Generate the TypeScript side of the Hermes event contract (spec Phase 1.2).
 *
 * Reads `shared/hermes-events.schema.json` — generated from the Pydantic models
 * in `hermes-bridge/bridge_events.py` — and emits zod validators plus inferred
 * types into `server/lib/hermes-events.gen.ts`. Nothing here is hand-written, so
 * the bridge and the Node boundary cannot disagree about a field without CI
 * failing.
 *
 * Why the schema is dereferenced first: json-schema-to-zod does not resolve
 * local `$ref`s, so every referenced model would collapse to `z.any()` and the
 * validators would check nothing. Resolving them here keeps the library doing
 * the mechanical type mapping we do not want to hand-roll.
 *
 * Run via `npm run gen:hermes-contract`. Pass --check to fail instead of write,
 * which is what CI uses to catch a stale generated file.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonSchemaToZod } from 'json-schema-to-zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const SCHEMA_PATH = join(REPO_ROOT, 'shared', 'hermes-events.schema.json')
const ERROR_SCHEMA_PATH = join(REPO_ROOT, 'shared', 'hermes-errors.schema.json')
const OUT_PATH = join(REPO_ROOT, 'server', 'lib', 'hermes-events.gen.ts')
const ERROR_OUT_PATH = join(REPO_ROOT, 'server', 'lib', 'hermes-errors.gen.ts')

/**
 * Replace local `$ref`s with the referenced schema, recursively.
 *
 * `$defs` and `definitions` are dropped from the result: they are only needed
 * for reference resolution. `seen` guards against a self-referential def, which
 * would otherwise recurse forever.
 */
function deref(node, defs, seen = new Set()) {
  if (Array.isArray(node)) return node.map((entry) => deref(entry, defs, seen))
  if (node === null || typeof node !== 'object') return node

  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop()
    if (seen.has(name)) return {}
    const next = new Set(seen)
    next.add(name)
    return deref(defs[name] ?? {}, defs, next)
  }

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs' || key === 'definitions') continue
    out[key] = deref(value, defs, seen)
  }
  return out
}

/** Build a zod schema per event key, so callers can validate one event. */
function buildPerEventSchemas(flatSchema) {
  const entries = Object.entries(flatSchema.properties ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )

  const lines = []
  for (const [key, schema] of entries) {
    const varName = `${toIdentifier(key)}Schema`
    const generated = jsonSchemaToZod(schema, {
      module: 'none',
      name: varName,
      zodVersion: 3,
    })
    // `module: 'none'` still emits the `const <name> = ...` declaration, so add
    // only the `export` keyword rather than writing our own declaration on top.
    const exported = generated.replace(
      new RegExp(`^const\\s+${varName}\\s*=`),
      `export const ${varName} =`,
    )
    if (exported === generated) {
      throw new Error(
        `json-schema-to-zod did not emit a declaration for ${key}; refusing to write a broken contract`,
      )
    }
    lines.push(`/** Contract for the \`${key}\` delta key. */`)
    lines.push(exported)
  }
  return lines.join('\n\n')
}

function toIdentifier(key) {
  return key.replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[0-9]/, 'd$1')
}

function render(schema) {
  const flat = deref(schema, schema.$defs ?? schema.definitions ?? {})

  return `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source of truth: the Pydantic models in hermes-bridge/bridge_events.py,
 * via shared/hermes-events.schema.json.
 * Regenerate with: npm run gen:hermes-contract
 * CI fails if this file is stale.
 *
 * Generated from the hermes-bridge Pydantic contract.
 */

import { z } from 'zod'

${buildPerEventSchemas(flat)}

/** Every custom event key the bridge may emit, mapped to its validator. */
export const HERMES_EVENT_SCHEMAS = {
${Object.keys(flat.properties ?? {})
  .sort()
  .map((key) => `  ${JSON.stringify(key)}: ${toIdentifier(key)}Schema,`)
  .join('\n')}
} as const

export type HermesEventKey = keyof typeof HERMES_EVENT_SCHEMAS

/**
 * Validates a whole delta object. Custom keys are checked against the contract;
 * everything else is passed through, because a delta also carries standard
 * OpenAI fields (content, reasoning, role) that are not part of this contract.
 */
export const hermesCustomDeltaSchema = z
  .object({
${Object.keys(flat.properties ?? {})
  .sort()
  .map((key) => `    ${JSON.stringify(key)}: ${toIdentifier(key)}Schema.optional(),`)
  .join('\n')}
  })
  .passthrough()

export type HermesCustomDelta = z.infer<typeof hermesCustomDeltaSchema>
`
}

/**
 * The error envelope. The code enum comes from `x-error-codes` in the schema
 * rather than from the Pydantic `code` field, which is only typed `string` —
 * so the generated union is actually closed, and adding a code on the Python
 * side changes the TypeScript union on the next regeneration.
 */
function renderErrorContract(schema) {
  const flat = deref(schema, schema.$defs ?? {})
  const codes = schema['x-error-codes'] ?? []
  const retryable = new Set(schema['x-retryable-codes'] ?? [])

  const body = jsonSchemaToZod(flat, {
    module: 'none',
    name: 'hermesErrorEnvelopeShape',
    zodVersion: 3,
  })
  const exportedBody = body.replace(
    /^const\s+hermesErrorEnvelopeShape\s*=/,
    'export const hermesErrorEnvelopeShape =',
  )
  if (exportedBody === body) {
    throw new Error('json-schema-to-zod did not emit a declaration for the error envelope')
  }

  return `/**
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
${codes.map((c) => `  '${c}',`).join('\n')}
] as const

export type HermesErrorCode = (typeof HERMES_ERROR_CODES)[number]

/**
 * Codes for which retrying the identical request could plausibly succeed.
 * The UI uses this to decide whether to offer a Retry button.
 */
export const HERMES_RETRYABLE_CODES: ReadonlySet<HermesErrorCode> = new Set([
${[...retryable].map((c) => `  '${c}',`).join('\n')}
])

${exportedBody}

/** Narrows the generated shape's open \`code\` to the closed union. */
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
 * open \`details\` model on the Python side.
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
`
}

function main() {
  const check = process.argv.includes('--check')

  for (const path of [SCHEMA_PATH, ERROR_SCHEMA_PATH]) {
    if (!existsSync(path)) {
      console.error(
        `missing ${relative(REPO_ROOT, path)} — run the hermes-bridge generate_*.py scripts first`,
      )
      process.exit(1)
    }
  }

  const targets = [
    {
      out: OUT_PATH,
      rendered: render(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))),
      label: 'hermes event TS contract',
    },
    {
      out: ERROR_OUT_PATH,
      rendered: renderErrorContract(JSON.parse(readFileSync(ERROR_SCHEMA_PATH, 'utf8'))),
      label: 'hermes error TS contract',
    },
  ]

  if (check) {
    for (const target of targets) {
      if (!existsSync(target.out)) {
        console.error(`missing ${relative(REPO_ROOT, target.out)}`)
        process.exit(1)
      }
      if (readFileSync(target.out, 'utf8') !== target.rendered) {
        console.error(
          `${relative(REPO_ROOT, target.out)} is stale. Run \`npm run gen:hermes-contract\` and commit the result.`,
        )
        process.exit(1)
      }
    }
    for (const target of targets) console.log(`${target.label} is up to date`)
    return
  }

  for (const target of targets) {
    mkdirSync(dirname(target.out), { recursive: true })
    writeFileSync(target.out, target.rendered)
    console.log(`wrote ${relative(REPO_ROOT, target.out)}`)
  }
}

main()
