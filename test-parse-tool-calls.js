// Test script for TOOL_CALL_PATTERN regex
const TOOL_CALL_PATTERN = /\[?(propose_changes|batch_edit_repo_files|edit_repo_file|create_repo_file|delete_repo_file|read_repo_file)\(/g;

const testCases = [
  {
    name: 'simple tool call',
    input: 'edit_repo_file(path="src/index.ts", content="hello")',
    expectMatch: true,
  },
  {
    name: 'tool call with bracket prefix',
    input: '[edit_repo_file(path="src/index.ts", content="hello")]',
    expectMatch: true,
  },
  {
    name: 'batch tool call',
    input: 'batch_edit_repo_files(changes=[{path: "a.txt", action: "edit", content: "x"}])',
    expectMatch: true,
  },
  {
    name: 'multiple tool calls',
    input: 'edit_repo_file(path="a.txt") create_repo_file(path="b.txt")',
    expectMatch: true,
  },
  {
    name: 'propose_changes',
    input: 'propose_changes(plan=[{path: "x.txt", action: "create"}])',
    expectMatch: true,
  },
  {
    name: 'read_repo_file',
    input: 'read_repo_file(path="README.md")',
    expectMatch: true,
  },
  {
    name: 'no match - plain text',
    input: 'This is just some text with no tool calls.',
    expectMatch: false,
  },
  {
    name: 'no match - different function',
    input: 'some_other_function(arg="value")',
    expectMatch: false,
  },
  {
    name: 'nested in code block',
    input: '```\nbatch_edit_repo_files(changes=[...])\n```',
    expectMatch: true,
  },
  {
    name: 'partial/streaming - unclosed paren',
    input: 'edit_repo_file(path="src/',
    expectMatch: true, // still matches the tool name prefix
  },
];

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  TOOL_CALL_PATTERN.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = TOOL_CALL_PATTERN.exec(tc.input)) !== null) {
    matches.push({ toolName: match[1], index: match.index });
  }

  const hasMatch = matches.length > 0;
  const ok = hasMatch === tc.expectMatch;

  if (ok) {
    console.log(`PASS: ${tc.name}`);
    passed++;
  } else {
    console.log(`FAIL: ${tc.name}`);
    console.log(`  input: ${tc.input}`);
    console.log(`  expected match: ${tc.expectMatch}, got: ${hasMatch}`);
    console.log(`  matches: ${JSON.stringify(matches)}`);
    failed++;
  }
}

console.log(`\nResults: ${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
