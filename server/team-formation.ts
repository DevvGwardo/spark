/**
 * team-formation.ts — Strategy-based team composition
 *
 * Replaces the simple isComplexTask() heuristic with domain-aware
 * formation strategies: single_agent, pair_programming, specialist_team,
 * swarm, and pipeline.
 *
 * NOTE: Domain matching uses profile `tags` (expertise keywords) rather
 * than SOUL.md content. The plan suggested SOUL.md excerpts for richer
 * domain inference, but profile tags are sufficient for the keyword-based
 * strategy detection implemented here. If SOUL.md-based matching is needed
 * later, fetchAgentSoul() from room-coordinator.ts can be called during
 * discoverAvailableAgents() and the parsed expertise injected into AgentInfo.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  displayName: string;
  /** Keyword-level expertise tags (e.g. ['frontend', 'react', 'testing']) */
  expertise: string[];
}

export interface FormationResult {
  strategy: 'single_agent' | 'pair_programming' | 'specialist_team' | 'swarm' | 'pipeline';
  reason: string;
  agentCount: number;
  /** Agent profile names for specialist_team strategy */
  recommendedAgents?: string[];
}

// ─── Domain keywords for strategy detection ────────────────────────────────

const FRONTEND_KEYWORDS = ['frontend', 'front-end', 'ui', 'react', 'vue', 'angular', 'css', 'html', 'design', 'ux', 'component'];
const BACKEND_KEYWORDS = ['backend', 'back-end', 'api', 'server', 'database', 'db', 'sql', 'nosql', 'graphql', 'rest', 'express'];
const TEST_KEYWORDS = ['test', 'testing', 'unit', 'e2e', 'integration', 'qa', 'coverage', 'jest', 'vitest', 'cypress'];
const DEVOPS_KEYWORDS = ['deploy', 'docker', 'kubernetes', 'ci', 'cd', 'pipeline', 'infrastructure', 'terraform', 'cloud', 'aws'];

const PAIR_TRIGGERS = [
  ['refactor', 'review'],
  ['review', 'implement'],
  ['refactor', 'test'],
  ['code', 'review'],
];

const SWARM_TRIGGERS = ['all', 'swarm', 'everything', 'full', 'entire'];

const PIPELINE_PHASE_SETS = [
  ['design', 'implement', 'test'],
  ['plan', 'build', 'review'],
  ['architect', 'implement', 'test'],
  ['spec', 'code', 'verify'],
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function tokenize(task: string): string[] {
  return task.toLowerCase().split(/[\s,;:.!?()\[\]{}"'`|\\/]+/).filter(Boolean);
}

/**
 * Exact token match (no substring) to prevent false positives.
 * "redesign" no longer matches "design", "testing" no longer matches "test".
 * For compound keywords like "front-end", checks both the joined token
 * and whether the raw text contains the exact compound phrase.
 */
function tokenMatch(token: string, keyword: string): boolean {
  if (token === keyword) return true;
  // Handle compound keywords with hyphens: split and check parts
  if (keyword.includes('-') && token.includes('-')) {
    const kParts = keyword.split('-');
    const tParts = token.split('-');
    return kParts.length === tParts.length && kParts.every((kp, i) => tParts[i] === kp);
  }
  return false;
}

function hasAllKeywords(tokens: string[], keywords: string[]): boolean {
  return keywords.every((k) => tokens.some((t) => tokenMatch(t, k)));
}

function matchAnyKeyword(tokens: string[], keywords: string[]): boolean {
  return keywords.some((k) => tokens.some((t) => tokenMatch(t, k)));
}

function countDomainKeywords(tokens: string[], domains: string[][]): number {
  return domains.reduce((count, domain) => {
    return matchAnyKeyword(tokens, domain) ? count + 1 : count;
  }, 0);
}

/**
 * Map expertise tags to a set of domain keywords an agent covers.
 * Tokenizes each tag and uses exact tokenMatch for consistency with
 * task-side domain detection.
 */
function inferAgentDomains(agent: AgentInfo): Set<string> {
  const domains = new Set<string>();
  for (const tag of agent.expertise.map((e) => e.toLowerCase())) {
    const tokens = tokenize(tag);
    if (FRONTEND_KEYWORDS.some((k) => tokens.some((t) => tokenMatch(t, k)))) domains.add('frontend');
    if (BACKEND_KEYWORDS.some((k) => tokens.some((t) => tokenMatch(t, k)))) domains.add('backend');
    if (TEST_KEYWORDS.some((k) => tokens.some((t) => tokenMatch(t, k)))) domains.add('test');
    if (DEVOPS_KEYWORDS.some((k) => tokens.some((t) => tokenMatch(t, k)))) domains.add('devops');
  }
  return domains;
}

/**
 * Return agents that are best matched to a set of required domains.
 * Each required domain gets the best-scoring agent. An agent can cover
 * multiple domains but will only be assigned once.
 */
function matchAgentsToDomains(
  requiredDomains: string[],
  agents: AgentInfo[],
): string[] {
  const assigned = new Set<string>();
  const result: string[] = [];

  for (const domain of requiredDomains) {
    // Score agents for this domain by how many of their expertise tags match
    const scored = agents
      .filter((a) => !assigned.has(a.name))
      .map((a) => {
        const tags = a.expertise.map((e) => e.toLowerCase());
        const tagTokens = tags.flatMap((t) => tokenize(t));
        const score = tagTokens.filter((t) => tokenMatch(t, domain)).length;
        return { agent: a, score };
      })
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0 && scored[0].score > 0) {
      assigned.add(scored[0].agent.name);
      result.push(scored[0].agent.name);
    } else if (agents.length > 0 && !assigned.has(agents[0].name)) {
      // Fallback: pick the first unassigned agent
      const fallback = agents.find((a) => !assigned.has(a.name));
      if (fallback) {
        assigned.add(fallback.name);
        result.push(fallback.name);
      }
    }
  }

  return result;
}

// ─── Main function ─────────────────────────────────────────────────────────

/**
 * Analyze a task description and available agents to determine the best
 * team formation strategy.
 *
 * Strategy decision tree:
 * 1. Swarm if task mentions "all"/"swarm"/"everything"
 * 2. Pipeline if task mentions multi-phase keywords like "design+implement+test"
 * 3. Specialist team if 3+ domains are detected (frontend+backend+tests etc.)
 * 4. Pair programming if refactor+review or review+implement patterns matched
 * 5. Single agent as default
 */
export function analyzeTask(task: string, availableAgents: AgentInfo[]): FormationResult {
  const tokens = tokenize(task);
  const agentCount = availableAgents.length;

  // 1. Swarm
  if (matchAnyKeyword(tokens, SWARM_TRIGGERS)) {
    return {
      strategy: 'swarm',
      reason: `Task mentions "swarm"/"all"/"everything" — deploying all ${agentCount} available agents`,
      agentCount: Math.max(1, agentCount),
      recommendedAgents: agentCount > 0 ? availableAgents.map((a) => a.name) : undefined,
    };
  }

  // 2. Pipeline: check for multi-phase keyword sets
  for (const phaseSet of PIPELINE_PHASE_SETS) {
    if (hasAllKeywords(tokens, phaseSet)) {
      return {
        strategy: 'pipeline',
        reason: `Task contains multi-phase keywords (${phaseSet.join(' + ')}) — sequential architect→implementor→reviewer`,
        agentCount: Math.min(3, Math.max(1, agentCount)),
      };
    }
  }

  // 3. Check for multiple domains (specialist team)
  const detectedDomains: string[] = [];
  if (matchAnyKeyword(tokens, FRONTEND_KEYWORDS)) detectedDomains.push('frontend');
  if (matchAnyKeyword(tokens, BACKEND_KEYWORDS)) detectedDomains.push('backend');
  if (matchAnyKeyword(tokens, TEST_KEYWORDS)) detectedDomains.push('test');
  if (matchAnyKeyword(tokens, DEVOPS_KEYWORDS)) detectedDomains.push('devops');

  if (detectedDomains.length >= 2) {
    const recommended = matchAgentsToDomains(detectedDomains, availableAgents);
    return {
      strategy: 'specialist_team',
      reason: `Task spans ${detectedDomains.length} domains (${detectedDomains.join(', ')}) — assigning specialist agents`,
      agentCount: Math.min(detectedDomains.length, Math.max(1, agentCount)),
      recommendedAgents: recommended.length > 0 ? recommended : undefined,
    };
  }

  // 4. Pair programming
  for (const [a, b] of PAIR_TRIGGERS) {
    if (matchAnyKeyword(tokens, [a]) && matchAnyKeyword(tokens, [b])) {
      return {
        strategy: 'pair_programming',
        reason: `Task combines "${a}" and "${b}" — driver + reviewer pair`,
        agentCount: Math.min(2, Math.max(1, agentCount)),
        recommendedAgents: agentCount >= 2 ? availableAgents.slice(0, 2).map((a) => a.name) : undefined,
      };
    }
  }

  // 5. Single agent (default)
  return {
    strategy: 'single_agent',
    reason: 'Task is simple enough for a single agent',
    agentCount: 1,
  };
}
