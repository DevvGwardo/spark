// Quick test script for parseToolCalls regex patterns
// Sample content matches accordion tool call blocks like:
//   > **Reading file** — `src/foo.ts`
//   > *Done — read 1,234 chars*

const TOOL_CALL_PATTERN = /\[?(propose_changes|batch_edit_repo_files|edit_repo_file|create_repo_file|delete_repo_file|read_repo_file)\(/g;
const PATH_CANDIDATE_PATTERN = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}/g;

const samples = [
  // Accordion-style tool call blocks (Markdown quote format)
  "> **Reading file** — `src/foo.ts`",
  "> *Done — read 1,234 chars*",
  "> **Editing file** — `components/Button.tsx`",
  "> **Creating file** — `utils/helper.ts`",
  "> **Searching web** — `https://example.com`",

  // Standard tool call patterns
  "read_repo_file(path: 'src/bar.ts')",
  "edit_repo_file({\n  path: 'src/baz.ts',\n  content: '...'\n})",
  "[propose_changes()]",

  // Mixed content
  "Here's what I found:\n> **Reading file** — `data/config.json`\n\nAnd the result was success.",
];

console.log("=== TOOL_CALL_PATTERN regex test ===\n");
for (const sample of samples) {
  TOOL_CALL_PATTERN.lastIndex = 0;
  const matches = [...sample.matchAll(TOOL_CALL_PATTERN)];
  console.log(`Input: "${sample}"`);
  console.log(`  Matches: ${matches.length > 0 ? matches.map(m => m[1]).join(', ') : '(none)'}`);
  console.log();
}

console.log("\n=== PATH_CANDIDATE_PATTERN regex test ===\n");
for (const sample of samples) {
  PATH_CANDIDATE_PATTERN.lastIndex = 0;
  const matches = [...sample.matchAll(PATH_CANDIDATE_PATTERN)];
  console.log(`Input: "${sample}"`);
  console.log(`  Paths: ${matches.length > 0 ? matches.map(m => m[0]).join(', ') : '(none)'}`);
  console.log();
}
