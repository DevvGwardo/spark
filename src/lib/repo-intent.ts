const STRONG_EDIT_INTENT_PATTERNS = [
  /\b(?:fix|update|edit|modify|change|implement|add|remove|delete|rename|refactor|rewrite|patch|improve|optimi[sz]e|upgrade|migrate|wire up|clean up)\b/,
  /\b(?:create|build)\b.{0,40}\b(?:feature|component|endpoint|route|screen|page|test|file|workflow|integration)\b/,
  /\b(?:open|create|submit)\b.{0,30}\b(?:pr|pull request)\b/,
  /\b(?:apply|ship|land|merge|commit)\b.{0,20}\b(?:it|them|this|that|these|the change|the changes)?\b/,
  /\bgo ahead\b/,
  /\bproceed\b/,
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

export function isRepoEditIntentMessage(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const hasStrongEditIntent = STRONG_EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasReadOnlyIntent = READ_ONLY_INTENT_PATTERNS.some((pattern) => pattern.test(normalized));

  if (hasStrongEditIntent) {
    return true;
  }

  if (hasReadOnlyIntent) {
    return false;
  }

  return false;
}

export function getRepoTurnIntentInstruction(editIntent: boolean): string {
  return editIntent
    ? 'Current repo turn intent: the user is asking for repository changes. Follow the proposal-and-approval workflow before editing.'
    : "Current repo turn intent: the user is asking for read-only repository help. You may inspect files with read_repo_file, but do not propose changes or edit files unless the user explicitly asks for modifications.";
}
