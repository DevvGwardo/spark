import { describe, expect, it } from 'vitest';
import {
  buildIssueExplainPrompt,
  buildIssueFixFollowUpPrompt,
  buildIssueUpdateFollowUpPrompt,
  isIssueExplainPrompt,
} from '@/lib/issue-chat-prompts';
import type { GitHubIssueSummary } from '@/lib/api';

const issueRepo = {
  id: 1,
  owner: { login: 'openclaw', avatar_url: null },
  name: 'openclaw',
  full_name: 'openclaw/openclaw',
  private: false,
  fork: false,
  description: 'Repo',
  html_url: 'https://github.com/openclaw/openclaw',
  default_branch: 'main',
  permissions: { pull: true, push: false },
  localClone: { exists: false, path: '' },
};

const editableRepo = {
  ...issueRepo,
  id: 2,
  owner: { login: 'devgwardo', avatar_url: null },
  name: 'openclaw',
  full_name: 'devgwardo/openclaw',
  fork: true,
  permissions: { pull: true, push: true },
};

const issue = {
  id: 45471,
  number: 45471,
  title: 'Chat input hidden behind warning overlay',
  state: 'open',
  body: 'After an update, the chat tab shows a warning triangle over the composer.',
  html_url: 'https://github.com/openclaw/openclaw/issues/45471',
  created_at: '2026-03-12T00:00:00Z',
  updated_at: '2026-03-12T00:00:00Z',
  user: { login: 'reporter', avatar_url: '' },
  labels: [{ id: 1, name: 'bug', color: 'ff0000', description: null }],
  comments: 0,
} as GitHubIssueSummary;

describe('issue chat prompts', () => {
  it('keeps explain prompts focused on repository inspection', () => {
    const prompt = buildIssueExplainPrompt(issueRepo, editableRepo, issue);

    expect(prompt).toContain('The user wants an explanation only, not a fix or implementation plan.');
    expect(prompt).toContain('Inspect the attached repository first.');
    expect(prompt).toContain('Do not propose patches, implementation steps, or next actions unless the user explicitly asks for them.');
    expect(prompt).toContain('Do not search the web');
    expect(prompt).toContain('If repository access is unavailable, say that once');
    expect(prompt).toContain('Do not make any code changes.');
    expect(prompt).toContain('The editable working copy is devgwardo/openclaw.');
  });

  it('detects explain-only issue handoff prompts', () => {
    const prompt = buildIssueExplainPrompt(issueRepo, editableRepo, issue);

    expect(isIssueExplainPrompt(prompt)).toBe(true);
    expect(isIssueExplainPrompt('Fix GitHub issue #45471 in openclaw/openclaw.')).toBe(false);
  });

  it('builds a fix follow-up prompt from attached repo issue context', () => {
    const prompt = buildIssueFixFollowUpPrompt({
      fullName: 'devgwardo/openclaw',
      baseFullName: 'openclaw/openclaw',
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.html_url,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        updatedAt: issue.updated_at,
      },
    });

    expect(prompt).toContain('Continue from your explanation of GitHub issue #45471 in openclaw/openclaw.');
    expect(prompt).toContain('Use devgwardo/openclaw as the editable working copy and keep the pull request target on openclaw/openclaw.');
    expect(prompt).toContain('Issue description:');
    expect(prompt).toContain(issue.body);
    expect(prompt).toContain('move straight into the fix');
  });

  it('builds an issue update follow-up prompt that stays read-only', () => {
    const prompt = buildIssueUpdateFollowUpPrompt({
      fullName: 'devgwardo/openclaw',
      baseFullName: 'openclaw/openclaw',
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.html_url,
        state: issue.state,
        labels: issue.labels.map((label) => label.name),
        updatedAt: issue.updated_at,
      },
    });

    expect(prompt).toContain('Continue from your explanation of GitHub issue #45471 in openclaw/openclaw.');
    expect(prompt).toContain('draft an update for the GitHub issue');
    expect(prompt).toContain('Do not make code changes');
    expect(prompt).toContain('Return only the draft issue update comment in Markdown');
  });
});
