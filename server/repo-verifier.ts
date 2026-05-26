import { logger } from './lib/logger';
import { spawn } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { createProviderModel, resolveReviewCapableProvider, VALIDATION_MODELS } from './provider-config';

export interface VerificationFileChange {
  path: string;
  content: string;
  action?: 'create' | 'edit' | 'delete';
  originalContent?: string;
}

export interface VerificationReviewFinding {
  severity: 'low' | 'medium' | 'high';
  title: string;
  summary: string;
  file?: string;
  suggestion?: string;
}

export interface VerificationCommandResult {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  summary: string;
  output: string;
  exitCode: number | null;
}

export interface VerificationResult {
  summary: {
    status: 'passed' | 'failed' | 'warning';
    findings: number;
    commandsRun: number;
    commandsFailed: number;
  };
  review: {
    status: 'passed' | 'warning' | 'skipped';
    summary: string;
    findings: VerificationReviewFinding[];
  };
  commands: VerificationCommandResult[];
}

export type VerificationStep =
  | 'cloning'
  | 'applying_changes'
  | 'finding_workspace'
  | 'installing'
  | 'running_scripts'
  | 'reviewing';

export interface VerificationProgressEvent {
  step: VerificationStep;
  label: string;
  detail: string;
}

export type OnVerificationProgress = (event: VerificationProgressEvent) => void;

export interface VerifyRepoChangesInput {
  owner: string;
  repo: string;
  pat: string;
  baseBranch: string;
  files: VerificationFileChange[];
  provider?: string;
  model?: string;
  apiKey?: string;
  origin?: string;
  allProviders?: Record<string, { apiKey: string; model: string }>;
  onProgress?: OnVerificationProgress;
}

interface PackageScriptMap {
  [key: string]: string | undefined;
}

interface ValidationCommandSpec {
  name: string;
  command: string;
  args: string[];
  displayCommand?: string;
  redactions?: string[];
}

const PROCESS_TIMEOUT_MS = 120_000;

/** Tracks active temp directories for cleanup on unexpected process exit. */
const activeTempDirs = new Set<string>();

process.on('exit', () => {
  for (const dir of activeTempDirs) {
    try {
      // Synchronous removal — 'exit' handler cannot be async.
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; nothing useful to do if it fails during exit.
    }
  }
});

const reviewFindingSchema = z.object({
  severity: z.enum(['low', 'medium', 'high']).optional(),
  title: z.string(),
  summary: z.string(),
  file: z.string().optional(),
  suggestion: z.string().optional(),
});

const reviewResponseSchema = z.object({
  summary: z.string(),
  findings: z.array(reviewFindingSchema),
});

const OUTPUT_LIMIT = 12_000;
const FILE_CONTENT_LIMIT = 12_000;

function truncateOutput(output: string, limit = OUTPUT_LIMIT): string {
  if (output.length <= limit) {
    return output;
  }
  return `${output.slice(0, limit)}\n...[truncated ${output.length - limit} chars]`;
}

function summarizeCommandOutput(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return 'No output captured.';
  }

  return truncateOutput(lines.slice(-6).join('\n'), 600);
}

function redactSecrets(value: string, redactions: string[] | undefined): string {
  if (!redactions || redactions.length === 0) {
    return value;
  }

  return redactions.reduce((nextValue, secret) => {
    if (!secret) {
      return nextValue;
    }
    return nextValue.split(secret).join('***');
  }, value);
}

function packageManagerRunCommand(packageManager: string, scriptName: string): ValidationCommandSpec {
  if (packageManager === 'npm') {
    return {
      name: scriptName,
      command: 'npm',
      args: ['run', scriptName],
    };
  }

  return {
    name: scriptName,
    command: packageManager,
    args: ['run', scriptName],
  };
}

function withWorkspaceDisplay(
  spec: ValidationCommandSpec,
  workspaceRelativePath: string,
): ValidationCommandSpec {
  if (!workspaceRelativePath || workspaceRelativePath === '.') {
    return spec;
  }

  return {
    ...spec,
    displayCommand: `cd ${workspaceRelativePath} && ${spec.command} ${spec.args.join(' ')}`.trim(),
  };
}

export function selectValidationCommands(
  scripts: PackageScriptMap,
  packageManager: string,
): ValidationCommandSpec[] {
  const seen = new Set<string>();
  const selected: ValidationCommandSpec[] = [];
  const candidateGroups = [
    ['lint'],
    ['typecheck', 'check-types'],
    ['test', 'test:unit', 'test:ci'],
    ['build'],
  ];

  for (const group of candidateGroups) {
    const scriptName = group.find((candidate) => typeof scripts[candidate] === 'string');
    if (!scriptName || seen.has(scriptName)) {
      continue;
    }
    seen.add(scriptName);
    selected.push(packageManagerRunCommand(packageManager, scriptName));
  }

  return selected;
}

function detectPackageManager(dir: string): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(dir, 'bun.lockb')) || existsSync(join(dir, 'bun.lock'))) {
    return 'bun';
  }
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (existsSync(join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function installCommandFor(packageManager: string, workspaceRelativePath = '.'): ValidationCommandSpec {
  let spec: ValidationCommandSpec;
  switch (packageManager) {
    case 'bun':
      spec = { name: 'install', command: 'bun', args: ['install'] };
      break;
    case 'pnpm':
      spec = { name: 'install', command: 'pnpm', args: ['install', '--no-frozen-lockfile'] };
      break;
    case 'yarn':
      spec = { name: 'install', command: 'yarn', args: ['install'] };
      break;
    default:
      spec = { name: 'install', command: 'npm', args: ['install'] };
      break;
  }

  return withWorkspaceDisplay(spec, workspaceRelativePath);
}

async function runCommand(
  spec: ValidationCommandSpec,
  cwd: string,
  extraEnv?: Record<string, string>,
): Promise<VerificationCommandResult> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(spec.command, spec.args, {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROCESS_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => reject(error));
    proc.on('close', (exitCode) => {
      const output = truncateOutput(
        redactSecrets([stdout, stderr].filter(Boolean).join('\n').trim(), spec.redactions),
      );
      const succeeded = (exitCode ?? 1) === 0;
      resolve({
        name: spec.name,
        command: spec.displayCommand || `${spec.command} ${spec.args.join(' ')}`,
        status: succeeded ? 'passed' : 'failed',
        summary: succeeded
          ? 'Command completed successfully.'
          : summarizeCommandOutput(output || `Command exited with code ${exitCode ?? 1}.`),
        output,
        exitCode: exitCode ?? 1,
      });
    });
  });
}

async function applyFileChanges(dir: string, files: VerificationFileChange[]) {
  for (const file of files) {
    const action = file.action || 'edit';
    const targetPath = join(dir, file.path);

    if (action === 'delete') {
      if (existsSync(targetPath)) {
        await unlink(targetPath);
      }
      continue;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, 'utf-8');
  }
}

function buildReviewPrompt(files: VerificationFileChange[]): string {
  const changedFiles = files.map((file) => {
    const action = file.action || 'edit';
    const before = truncateOutput(file.originalContent || '', FILE_CONTENT_LIMIT);
    const after = truncateOutput(file.content || '', FILE_CONTENT_LIMIT);

    return [
      `=== ${file.path} (${action}) ===`,
      'BEFORE:',
      before || '[empty]',
      'AFTER:',
      action === 'delete' ? '[deleted]' : after || '[empty]',
    ].join('\n');
  });

  return [
    'Review the following staged repository changes.',
    'Return strict JSON with this exact shape:',
    '{"summary":"short overall assessment","findings":[{"severity":"low|medium|high","title":"...","summary":"...","file":"optional/path","suggestion":"optional fix"}]}',
    'Focus on correctness, regressions, broken imports, missing edge cases, and tests that no longer match behavior.',
    'If you do not find any actionable issues, return {"summary":"No actionable issues found.","findings":[]}.',
    '',
    changedFiles.join('\n\n'),
  ].join('\n');
}

function extractJsonPayload(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return objectMatch[0];
  }

  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    return arrayMatch[0];
  }

  return null;
}

export function parseReviewResponse(content: string): { summary: string; findings: VerificationReviewFinding[] } {
  const payload = extractJsonPayload(content);
  const parsed = JSON.parse(payload || content) as {
    summary?: string;
    findings?: Array<{
      severity?: 'low' | 'medium' | 'high';
      title?: string;
      summary?: string;
      file?: string;
      suggestion?: string;
    }>;
  };

  const findings = Array.isArray(parsed.findings)
    ? parsed.findings
        .filter((finding) => finding && typeof finding.title === 'string' && typeof finding.summary === 'string')
        .map((finding) => ({
          severity:
            finding.severity === 'high' || finding.severity === 'medium' || finding.severity === 'low'
              ? finding.severity
              : 'medium',
          title: finding.title as string,
          summary: finding.summary as string,
          ...(typeof finding.file === 'string' && finding.file ? { file: finding.file } : {}),
          ...(typeof finding.suggestion === 'string' && finding.suggestion ? { suggestion: finding.suggestion } : {}),
        }))
    : [];

  return {
    summary:
      typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : findings.length > 0
          ? `${findings.length} issue${findings.length === 1 ? '' : 's'} found during review.`
          : 'No actionable issues found.',
    findings,
  };
}

async function collectPackageJsonPaths(rootDir: string, relativeDir = ''): Promise<string[]> {
  const absoluteDir = relativeDir ? join(rootDir, relativeDir) : rootDir;
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        continue;
      }

      const childRelativeDir = relativeDir ? join(relativeDir, entry.name) : entry.name;
      results.push(...await collectPackageJsonPaths(rootDir, childRelativeDir));
      continue;
    }

    if (entry.isFile() && entry.name === 'package.json') {
      results.push(relativeDir ? join(relativeDir, entry.name) : entry.name);
    }
  }

  return results;
}

export function selectPackageJsonPath(filePaths: string[], packageJsonPaths: string[]): string | null {
  if (packageJsonPaths.length === 0) {
    return null;
  }

  const packageJsonSet = new Set(packageJsonPaths);
  for (const filePath of filePaths) {
    let currentDir = dirname(filePath);

    while (true) {
      const candidate = currentDir === '.' ? 'package.json' : join(currentDir, 'package.json');
      if (packageJsonSet.has(candidate)) {
        return candidate;
      }

      if (currentDir === '.' || currentDir === '') {
        break;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  if (packageJsonSet.has('package.json')) {
    return 'package.json';
  }

  if (packageJsonPaths.length === 1) {
    return packageJsonPaths[0];
  }

  return [...packageJsonPaths].sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))[0];
}

async function runProviderReview(input: VerifyRepoChangesInput): Promise<VerificationResult['review']> {
  const { provider, model, apiKey, origin, files, allProviders } = input;

  const resolution = resolveReviewCapableProvider(
    provider || '',
    model || VALIDATION_MODELS[provider || ''] || '',
    apiKey || '',
    allProviders,
  );

  if (!resolution) {
    return {
      status: 'skipped',
      summary: 'No provider available for AI review. Configure a provider API key in Settings.',
      findings: [],
    };
  }

  try {
    const reviewModel = createProviderModel(resolution.provider, resolution.model, resolution.apiKey, { origin });
    let parsed: { summary: string; findings: VerificationReviewFinding[] };

    try {
      const response = await generateObject({
        model: reviewModel,
        schema: reviewResponseSchema,
        prompt: buildReviewPrompt(files),
        temperature: 0,
        maxTokens: 1800,
      });

      parsed = {
        summary: response.object.summary,
        findings: response.object.findings.map((finding) => ({
          severity: finding.severity ?? 'medium',
          title: finding.title,
          summary: finding.summary,
          ...(finding.file ? { file: finding.file } : {}),
          ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        })),
      };
    } catch {
      const response = await generateText({
        model: reviewModel,
        prompt: buildReviewPrompt(files),
        temperature: 0,
        maxTokens: 1800,
      });
      parsed = parseReviewResponse(response.text);
    }

    const usedDifferentProvider = resolution.provider !== provider;
    const summaryPrefix = usedDifferentProvider
      ? `[Reviewed via ${resolution.provider}] `
      : '';

    return {
      status: parsed.findings.length > 0 ? 'warning' : 'passed',
      summary: `${summaryPrefix}${parsed.summary}`,
      findings: parsed.findings,
    };
  } catch (error) {
    logger.error(`[repo-verifier] Provider review failed: ${error instanceof Error ? error.message : String(error)}`);
    return {
      status: 'skipped',
      summary: 'Provider-backed review was skipped due to an internal error.',
      findings: [],
    };
  }
}

export async function verifyRepoChanges(input: VerifyRepoChangesInput): Promise<VerificationResult> {
  const dir = await mkdtemp(join(tmpdir(), 'cloudchat-verify-'));
  activeTempDirs.add(dir);

  const cloneUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const authHeader = `Authorization: Basic ${Buffer.from(`x-access-token:${input.pat}`).toString('base64')}`;
  const cloneSpec: ValidationCommandSpec = {
    name: 'clone',
    command: 'git',
    args: ['clone', '--depth', '1', '--branch', input.baseBranch, cloneUrl, '.'],
    displayCommand: `git clone --depth 1 --branch ${input.baseBranch} https://github.com/${input.owner}/${input.repo}.git .`,
    redactions: [input.pat, authHeader],
  };

  // Pass auth via environment variables to keep the PAT out of process args.
  const cloneEnv: Record<string, string> = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: authHeader,
  };

  const emit = input.onProgress ?? (() => {});

  try {
    const commands: VerificationCommandResult[] = [];
    emit({ step: 'cloning', label: 'Cloning repository snapshot', detail: 'Pulling the base branch into a clean workspace.' });
    const cloneResult = await runCommand(cloneSpec, dir, cloneEnv);
    commands.push(cloneResult);
    if (cloneResult.status === 'failed') {
      return {
        summary: {
          status: 'failed',
          findings: 0,
          commandsRun: commands.length,
          commandsFailed: 1,
        },
        review: {
          status: 'skipped',
          summary: 'Provider-backed review was skipped because the repository could not be cloned.',
          findings: [],
        },
        commands,
      };
    }

    emit({ step: 'applying_changes', label: 'Applying file changes', detail: 'Writing staged changes into the cloned workspace.' });
    await applyFileChanges(dir, input.files);

    emit({ step: 'finding_workspace', label: 'Finding project workspace', detail: 'Locating the package.json closest to the changed files.' });
    const packageJsonCandidates = await collectPackageJsonPaths(dir);
    const selectedPackageJsonPath = selectPackageJsonPath(
      input.files.map((file) => file.path),
      packageJsonCandidates,
    );

    if (selectedPackageJsonPath) {
      const workspaceDir = dirname(join(dir, selectedPackageJsonPath));
      const workspaceRelativePath = dirname(selectedPackageJsonPath);
      const workspaceLabel = workspaceRelativePath === '.' ? 'repo root' : workspaceRelativePath;
      const packageManager = detectPackageManager(workspaceDir);
      emit({ step: 'installing', label: 'Installing dependencies', detail: `Running ${packageManager} install in ${workspaceLabel}.` });
      const installResult = await runCommand(
        installCommandFor(packageManager, workspaceRelativePath),
        workspaceDir,
      );
      commands.push(installResult);

      if (installResult.status === 'passed') {
        const packageJson = JSON.parse(await readFile(join(dir, selectedPackageJsonPath), 'utf-8')) as { scripts?: PackageScriptMap };
        const validationCommands = selectValidationCommands(packageJson.scripts || {}, packageManager);

        emit({ step: 'running_scripts', label: 'Running validation scripts', detail: 'Checking lint, types, tests, and build scripts when available.' });
        if (validationCommands.length === 0) {
          commands.push({
            name: 'scripts',
            command: 'none',
            status: 'skipped',
            summary: `No lint, typecheck, test, or build scripts were found in ${workspaceLabel}/package.json.`,
            output: '',
            exitCode: null,
          });
        } else {
          for (const spec of validationCommands) {
            commands.push(await runCommand(withWorkspaceDisplay(spec, workspaceRelativePath), workspaceDir));
          }
        }
      }
    } else {
      commands.push({
        name: 'install',
        command: 'none',
        status: 'skipped',
        summary: 'No package.json was found near the changed files, so dependency installation and package scripts were skipped.',
        output: '',
        exitCode: null,
      });
    }

    emit({ step: 'reviewing', label: 'Generating provider review', detail: 'Asking the selected model for a final code review pass.' });
    const review = await runProviderReview(input);
    const commandsFailed = commands.filter((command) => command.status === 'failed').length;
    const status: VerificationResult['summary']['status'] =
      commandsFailed > 0 ? 'failed' : review.status === 'passed' ? 'passed' : 'warning';

    return {
      summary: {
        status,
        findings: review.findings.length,
        commandsRun: commands.filter((command) => command.status !== 'skipped').length,
        commandsFailed,
      },
      review,
      commands,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
    activeTempDirs.delete(dir);
  }
}

export interface GeneratePrMetadataInput {
  files: VerificationFileChange[];
  provider?: string;
  model?: string;
  apiKey?: string;
  allProviders?: Record<string, { apiKey: string; model: string }>;
  origin?: string;
  owner?: string;
  repo?: string;
}

const prMetadataSchema = z.object({
  title: z.string(),
  body: z.string(),
});

function buildPrMetadataPrompt(files: VerificationFileChange[], owner?: string, repo?: string): string {
  const changedFiles = files.map((file) => {
    const action = file.action || 'edit';
    const before = truncateOutput(file.originalContent || '', FILE_CONTENT_LIMIT);
    const after = truncateOutput(file.content || '', FILE_CONTENT_LIMIT);
    return [
      `=== ${file.path} (${action}) ===`,
      'BEFORE:',
      before || '[empty]',
      'AFTER:',
      action === 'delete' ? '[deleted]' : after || '[empty]',
    ].join('\n');
  });

  const repoContext = owner && repo ? ` for ${owner}/${repo}` : '';

  return [
    `Generate a concise pull request title and description${repoContext}.`,
    'Return strict JSON: {"title":"<conventional commit style, max 72 chars>","body":"<markdown summary with ## Summary section>"}',
    'Title should follow conventional commits (feat:, fix:, refactor:, docs:, chore:, etc.).',
    'Body should have a ## Summary section with 1-3 bullet points describing the key changes.',
    '',
    changedFiles.join('\n\n'),
  ].join('\n');
}

export async function generatePrMetadata(input: GeneratePrMetadataInput): Promise<{ title: string; body: string }> {
  const resolution = resolveReviewCapableProvider(
    input.provider || '',
    input.model || VALIDATION_MODELS[input.provider || ''] || '',
    input.apiKey || '',
    input.allProviders,
  );

  if (!resolution) {
    throw new Error('No provider available for AI generation. Configure a provider API key in Settings.');
  }

  const aiModel = createProviderModel(resolution.provider, resolution.model, resolution.apiKey, { origin: input.origin });
  const prompt = buildPrMetadataPrompt(input.files, input.owner, input.repo);

  try {
    const response = await generateObject({
      model: aiModel,
      schema: prMetadataSchema,
      prompt,
      temperature: 0,
      maxTokens: 1000,
    });
    return { title: response.object.title, body: response.object.body };
  } catch {
    // Fallback to generateText + JSON parsing
    const response = await generateText({
      model: aiModel,
      prompt,
      temperature: 0,
      maxTokens: 1000,
    });

    try {
      const payload = extractJsonPayload(response.text);
      const parsed = JSON.parse(payload || response.text) as { title?: string; body?: string };
      if (typeof parsed.title !== 'string' || typeof parsed.body !== 'string') {
        throw new Error('AI response did not include title and body fields');
      }
      return { title: parsed.title, body: parsed.body };
    } catch (parseError) {
      logger.error(`[repo-verifier] Failed to parse AI response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      throw new Error('Failed to generate PR metadata: the AI response could not be parsed.');
    }
  }
}
