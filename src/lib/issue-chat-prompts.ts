import type { GitHubIssueSummary, GitHubRepoSummary } from '@/lib/api';
import type { ActiveRepo } from '@/stores/changeset-store';

type ActiveIssueRepoContext = Pick<ActiveRepo, 'fullName' | 'baseFullName' | 'issue'> & {
  issue: NonNullable<ActiveRepo['issue']>;
};

export function buildIssueFixPrompt(issueRepo: GitHubRepoSummary, editableRepo: GitHubRepoSummary, issue: GitHubIssueSummary) {
  const labelList = issue.labels.map((label) => label.name).filter(Boolean).join(', ');
  const lines = [
    `Fix GitHub issue #${issue.number} in ${issueRepo.full_name}.`,
    `Issue title: ${issue.title}`,
    issue.state ? `Issue state: ${issue.state}` : '',
    labelList ? `Labels: ${labelList}` : '',
    editableRepo.full_name !== issueRepo.full_name
      ? `Use ${editableRepo.full_name} as the editable working copy and keep the pull request target on ${issueRepo.full_name}.`
      : `Use ${editableRepo.full_name} as the editable repository.`,
    '',
    'Issue description:',
    issue.body?.trim() || 'No issue description was provided.',
    '',
    'Inspect the repository, propose the required code changes, implement them, and explain how the fix addresses the issue.',
  ].filter(Boolean);

  return lines.join('\n');
}

export function buildIssueExplainPrompt(issueRepo: GitHubRepoSummary, editableRepo: GitHubRepoSummary, issue: GitHubIssueSummary) {
  const labelList = issue.labels.map((label) => label.name).filter(Boolean).join(', ');
  const lines = [
    `Explain GitHub issue #${issue.number} in ${issueRepo.full_name}.`,
    `Issue title: ${issue.title}`,
    issue.state ? `Issue state: ${issue.state}` : '',
    labelList ? `Labels: ${labelList}` : '',
    editableRepo.full_name !== issueRepo.full_name
      ? `The editable working copy is ${editableRepo.full_name}.`
      : `The repository is ${editableRepo.full_name}.`,
    '',
    'Issue description:',
    issue.body?.trim() || 'No issue description was provided.',
    '',
    'The user wants an explanation only, not a fix or implementation plan.',
    'Inspect the attached repository first. Read the most relevant files, identify the likely root cause, and name the code paths involved.',
    'Summarize what appears to be going wrong, why it is likely happening, and any important context needed to understand the issue.',
    'Do not search the web, browse external issues, or rely on outside context unless the issue description explicitly asks for it.',
    'Do not propose patches, implementation steps, or next actions unless the user explicitly asks for them.',
    'If repository access is unavailable, say that once, analyze only the issue text and provided context, and do not restate the issue description at length.',
    'Do not make any code changes.',
  ].filter(Boolean);

  return lines.join('\n');
}

export function isIssueExplainPrompt(prompt: string) {
  const normalized = prompt.trim().toLowerCase();

  return normalized.includes('explain github issue #')
    && normalized.includes('the user wants an explanation only');
}

export function buildIssueFixFollowUpPrompt(repo: ActiveIssueRepoContext) {
  const labelList = repo.issue.labels.filter(Boolean).join(', ');
  const issueRepoFullName = repo.baseFullName || repo.fullName;
  const lines = [
    `Continue from your explanation of GitHub issue #${repo.issue.number} in ${issueRepoFullName}.`,
    `Issue title: ${repo.issue.title}`,
    repo.issue.state ? `Issue state: ${repo.issue.state}` : '',
    labelList ? `Labels: ${labelList}` : '',
    repo.issue.url ? `Issue URL: ${repo.issue.url}` : '',
    repo.fullName !== issueRepoFullName
      ? `Use ${repo.fullName} as the editable working copy and keep the pull request target on ${issueRepoFullName}.`
      : `Use ${repo.fullName} as the editable repository.`,
    '',
    ...(repo.issue.body?.trim()
      ? [
          'Issue description:',
          repo.issue.body.trim(),
          '',
        ]
      : []),
    'Use the repository context and the prior analysis in this chat to move straight into the fix.',
    'Inspect any remaining relevant files, propose the required code changes, implement them, and explain how the fix addresses the root cause.',
    'Do not repeat the earlier explanation unless it is needed to justify the changes.',
  ].filter(Boolean);

  return lines.join('\n');
}

export function buildIssueUpdateFollowUpPrompt(repo: ActiveIssueRepoContext) {
  const labelList = repo.issue.labels.filter(Boolean).join(', ');
  const issueRepoFullName = repo.baseFullName || repo.fullName;
  const lines = [
    `Continue from your explanation of GitHub issue #${repo.issue.number} in ${issueRepoFullName}.`,
    `Issue title: ${repo.issue.title}`,
    repo.issue.state ? `Issue state: ${repo.issue.state}` : '',
    labelList ? `Labels: ${labelList}` : '',
    repo.issue.url ? `Issue URL: ${repo.issue.url}` : '',
    '',
    ...(repo.issue.body?.trim()
      ? [
          'Issue description:',
          repo.issue.body.trim(),
          '',
        ]
      : []),
    'Use the repository context and the prior analysis in this chat to draft an update for the GitHub issue.',
    'Write a concise issue comment that explains the likely root cause, the code paths involved, and the current status in plain language.',
    'Do not make code changes, propose patches, or switch into implementation mode unless the user explicitly asks for that next.',
    'Return only the draft issue update comment in Markdown, ready for the user to post.',
  ].filter(Boolean);

  return lines.join('\n');
}
