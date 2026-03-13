import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { createProviderModel } from './provider-config';

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
): Promise<VerificationCommandResult> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(spec.command, spec.args, {
      cwd,
      env: {
        ...process.env,
        CI: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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
  const { provider, model, apiKey, origin, files } = input;

  if (!provider || !model || !apiKey) {
    return {
      status: 'skipped',
      summary: 'Provider-backed review was skipped because no provider credentials were available.',
      findings: [],
    };
  }

  try {
    const reviewModel = createProviderModel(provider, model, apiKey, { origin });
    let parsed: { summary: string; findings: VerificationReviewFinding[] };

    try {
      const response = await generateObject({
        model: reviewModel,
        schema: reviewResponseSchema,
        prompt: buildReviewPrompt(files),
        temperature: 0,
        maxOutputTokens: 1800,
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
        maxOutputTokens: 1800,
      });
      parsed = parseReviewResponse(response.text);
    }

    return {
      status: parsed.findings.length > 0 ? 'warning' : 'passed',
      summary: parsed.summary,
      findings: parsed.findings,
    };
  } catch (error) {
    return {
      status: 'skipped',
      summary: `Provider-backed review was skipped: ${error instanceof Error ? error.message : String(error)}`,
      findings: [],
    };
  }
}

export async function verifyRepoChanges(input: VerifyRepoChangesInput): Promise<VerificationResult> {
  const dir = await mkdtemp(join(tmpdir(), 'cloudchat-verify-'));
  const cloneUrl = `https://x-access-token:${input.pat}@github.com/${input.owner}/${input.repo}.git`;
  const cloneSpec: ValidationCommandSpec = {
    name: 'clone',
    command: 'git',
    args: ['clone', '--depth', '1', '--branch', input.baseBranch, cloneUrl, '.'],
    displayCommand: `git clone --depth 1 --branch ${input.baseBranch} https://x-access-token:***@github.com/${input.owner}/${input.repo}.git .`,
    redactions: [input.pat],
  };

  try {
    const commands: VerificationCommandResult[] = [];
    const cloneResult = await runCommand(cloneSpec, dir);
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

    await applyFileChanges(dir, input.files);

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
      const installResult = await runCommand(
        installCommandFor(packageManager, workspaceRelativePath),
        workspaceDir,
      );
      commands.push(installResult);

      if (installResult.status === 'passed') {
        const packageJson = JSON.parse(await readFile(join(dir, selectedPackageJsonPath), 'utf-8')) as { scripts?: PackageScriptMap };
        const validationCommands = selectValidationCommands(packageJson.scripts || {}, packageManager);

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
  }
}
