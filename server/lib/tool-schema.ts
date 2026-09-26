// ─── Minimal zod → OpenAI tool definition conversion ─────────────────────────
// The direct-compatible proxy speaks the raw OpenAI chat/completions wire
// format, so server-side tool definitions (AI SDK `tool()` objects with zod
// parameter schemas) must be converted to OpenAI function definitions:
//
//   {type:"function", function:{name, description, parameters:{...}}}
//
// Supports the subset of zod used by the server tool builders (object, string,
// number, boolean, array, enum, literal, optional/nullable wrappers,
// `.describe()`). Anything unsupported falls back to a permissive schema so
// tool calls never break on conversion.

import type { z } from 'zod';
import type { Tool } from 'ai';

export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
  };
}

type ZodLike = z.ZodTypeAny;

function isZodType(schema: ZodLike, name: string): boolean {
  return schema?._def?.typeName === name;
}

function describe(schema: ZodLike): string | undefined {
  const description = (schema as { _def?: { description?: unknown } })._def?.description;
  return typeof description === 'string' ? description : undefined;
}

function unwrap(schema: ZodLike): { schema: ZodLike; optional: boolean; nullable: boolean } {
  let current = schema;
  let optional = false;
  let nullable = false;
  while (true) {
    if (isZodType(current, 'ZodOptional')) {
      optional = true;
      current = (current as z.ZodOptional<ZodLike>).unwrap();
      continue;
    }
    if (isZodType(current, 'ZodNullable')) {
      nullable = true;
      current = (current as z.ZodNullable<ZodLike>).unwrap();
      continue;
    }
    if (isZodType(current, 'ZodDefault')) {
      current = (current as z.ZodDefault<ZodLike>).removeDefault();
      continue;
    }
    break;
  }
  return { schema: current, optional, nullable };
}

function zodToJsonSchema(schema: ZodLike): Record<string, unknown> {
  const { schema: inner, optional, nullable } = unwrap(schema);

  let jsonSchema: Record<string, unknown>;
  switch ((inner as { _def?: { typeName?: string } })._def?.typeName) {
    case 'ZodString':
      jsonSchema = { type: 'string' };
      break;
    case 'ZodNumber':
      jsonSchema = { type: 'number' };
      break;
    case 'ZodBoolean':
      jsonSchema = { type: 'boolean' };
      break;
    case 'ZodArray': {
      const itemSchema = (inner as z.ZodArray<ZodLike>).element;
      jsonSchema = { type: 'array', items: zodToJsonSchema(itemSchema) };
      break;
    }
    case 'ZodEnum': {
      const values = (inner as z.ZodEnum<[string, ...string[]]>)._def.values;
      jsonSchema = { type: 'string', enum: Array.from(values) };
      break;
    }
    case 'ZodLiteral': {
      const value = (inner as z.ZodLiteral<unknown>)._def.value;
      jsonSchema = { type: typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean', const: value };
      break;
    }
    case 'ZodObject': {
      const objectSchema = inner as z.ZodObject<Record<string, ZodLike>>;
      // zod ≥3.25 may expose the shape as a lazy function.
      const rawShape = objectSchema.shape as unknown;
      const shape = (typeof rawShape === 'function'
        ? (rawShape as () => Record<string, ZodLike>)()
        : rawShape) as Record<string, ZodLike>;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, valueSchema] of Object.entries(shape)) {
        const propertySchema = zodToJsonSchema(valueSchema);
        const description = describe(valueSchema);
        if (description) {
          propertySchema.description = description;
        }
        properties[key] = propertySchema;
        if (!isZodType(valueSchema, 'ZodOptional') && !isZodType(valueSchema, 'ZodDefault')) {
          required.push(key);
        }
      }
      jsonSchema = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
      break;
    }
    case 'ZodRecord': {
      jsonSchema = { type: 'object' };
      break;
    }
    default:
      // Unsupported schema — allow anything rather than breaking tool calls.
      jsonSchema = {};
  }

  if (nullable) {
    jsonSchema.type = [jsonSchema.type, 'null'] as unknown as string;
  }
  if (optional && jsonSchema.type !== undefined) {
    jsonSchema.type = [jsonSchema.type, 'null'] as unknown as string;
  }
  return jsonSchema;
}

/**
 * Convert an AI SDK `tool()` definition into an OpenAI function definition.
 * Used when the direct-compatible proxy forwards a filtered (read-only) tool
 * set upstream in plan mode.
 */
export function coreToolToOpenAiFunction(name: string, coreTool: Tool): OpenAiFunctionTool {
  const parameters = coreTool.inputSchema ? zodToJsonSchema(coreTool.inputSchema as ZodLike) : { type: 'object', properties: {} };
  const rawDesc = coreTool.description; const description = typeof rawDesc === 'string' ? rawDesc : '';
  if (description) {
    parameters.description = description;
  }
  return {
    type: 'function',
    function: {
      name,
      ...(description ? { description } : {}),
      inputSchema: parameters as any,
    },
  };
}

/** Convert a record of AI SDK tools into an OpenAI `tools` array. */
export function coreToolsToOpenAiFunctions(tools: Record<string, Tool>): OpenAiFunctionTool[] {
  return Object.entries(tools).map(([name, coreTool]) => coreToolToOpenAiFunction(name, coreTool));
}
