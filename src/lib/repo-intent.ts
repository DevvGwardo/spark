const STRONG_EDIT_INTENT_PATTERNS = [
  /\b(?:fix|update|edit|modify|change|implement|add|remove|delete|rename|refactor|rewrite|write|patch|improve|optimi[sz]e|upgrade|migrate|wire up|clean up)\b/,
  /\b(?:create|build)\b.{0,40}\b(?:feature|component|endpoint|route|screen|page|test|file|workflow|integration)\b/,
  /\b(?:open|create|submit)\b.{0,30}\b(?:pr|pull request)\b/,
  /\b(?:apply|ship|land|merge|commit)\b.{0,20}\b(?:it|them|this|that|these|the change|the changes)?\b/,
] as const;

const EXPLICIT_READ_ONLY_GUARD_PATTERNS = [
  /\b(?:the user wants an )?explanation only\b/,
  /\bnot a fix or implementation plan\b/,
  /\bdo not make any code changes\b/,
  /\bdo not make code changes\b/,
  /\bdo not propose patches\b/,
  /\bdo not implement\b/,
] as const;

const READ_ONLY_INTENT_PATTERNS = [
  /\bwhat is (?:this|the) repo\b/,
  /\bwhat does (?:this|the) repo do\b/,
  /\bwhat is it\b/,
  /\bdescribe\b/,
  /\bexplain\b/,
  /\bsummarize\b/,
  /\boverview\b/,
  /\bhow does\b/,
  /\bwhere (?:is|are)\b/,
  /\binspect\b/,
  /\banaly[sz]e\b/,
  /\breview\b/,
  /\baudit\b/,
  /\bwalk me through\b/,
  /\bwhat would you change\b/,
  /\bwhat should we change\b/,
  /\bpropose\b/,
  /\bsuggest\b/,
  /\brecommend\b/,
  /\bplan\b/,
] as const;

const APPROVAL_FOLLOW_UP_PATTERNS = [
  /^go ahead[.!]*$/i,
  /^continue(?: with (?:the )?(?:plan|changes))?[.!]*$/i,
  /^(?:yes|yep|sure),?\s+(?:go ahead|continue|proceed)/i,
] as const;

export function isRepoEditIntentMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasExplicitReadOnlyGuard = EXPLICIT_READ_ONLY_GUARD_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasStrongEditIntent = STRONG_EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasReadOnlyIntent = READ_ONLY_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));

  if (hasExplicitReadOnlyGuard) {
    return false;
  }

  if (hasStrongEditIntent) {
    return true;
  }

  if (hasReadOnlyIntent) {
    return false;
  }

  return false;
}

export function isRepoApprovalFollowUpMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) return false;

  return (
    normalized === 'go ahead' ||
    normalized === 'continue' ||
    normalized === 'approved' ||
    normalized === 'approve' ||
    normalized === 'ship it' ||
    normalized === 'do it' ||
    normalized === 'proceed' ||
    normalized === 'yes' ||
    APPROVAL_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function isRepoWriteMessage(content: string): boolean {
  return isRepoEditIntentMessage(content) || isRepoApprovalFollowUpMessage(content);
}

export function getRepoTurnIntentInstruction(editIntent: boolean): string {
  return editIntent
    ? 'Current repo turn intent: the user is asking for repository changes. Read the relevant files with read_repo_file, then make the changes directly using edit_repo_file, create_repo_file, or batch_edit_repo_files. Do not ask for permission — edit the files directly.'
    : "Current repo turn intent: the user is asking for read-only repository help. You may inspect files with read_repo_file, but do not edit files unless the user explicitly asks for modifications.";
}
