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
const OUT_PATH = join(REPO_ROOT, 'server', 'lib', 'hermes-events.gen.ts')

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

function main() {
  const check = process.argv.includes('--check')

  if (!existsSync(SCHEMA_PATH)) {
    console.error(
      `missing ${relative(REPO_ROOT, SCHEMA_PATH)} — run hermes-bridge/generate_event_schema.py first`,
    )
    process.exit(1)
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  const rendered = render(schema)

  if (check) {
    if (!existsSync(OUT_PATH)) {
      console.error(`missing ${relative(REPO_ROOT, OUT_PATH)}`)
      process.exit(1)
    }
    if (readFileSync(OUT_PATH, 'utf8') !== rendered) {
      console.error(
        `${relative(REPO_ROOT, OUT_PATH)} is stale. Run \`npm run gen:hermes-contract\` and commit the result.`,
      )
      process.exit(1)
    }
    console.log('hermes event TS contract is up to date')
    return
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, rendered)
  console.log(`wrote ${relative(REPO_ROOT, OUT_PATH)}`)
}

main()
