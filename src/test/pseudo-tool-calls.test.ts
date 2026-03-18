import { describe, expect, it } from 'vitest';
import { extractPseudoToolInvocations, extractTextFileEdits, stripPseudoToolInvocations } from '@/lib/pseudo-tool-calls';

describe('pseudo tool call parsing', () => {
  it('parses Hermes pseudo batch edit output', () => {
    const content = `Applying the approved changes now.

[batch_edit_repo_files(changes=[{"path":"src/App.tsx","action":"edit","content":"export default function App() {\\n  return <main>Updated</main>;\\n}","description":"Refresh the app shell"},{"path":"src/styles.css","action":"edit","content":"body {\\n  background: #111;\\n}\\n","description":"Update the theme"}])]

The changes are now staged for a pull request.`;

    const invocations = extractPseudoToolInvocations(content);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.toolName).toBe('batch_edit_repo_files');

    const changes = invocations[0]?.args.changes as Array<{ path: string; content: string }>;
    expect(changes).toHaveLength(2);
    expect(changes[0]?.path).toBe('src/App.tsx');
    expect(changes[1]?.content).toContain('background: #111');

    const cleaned = stripPseudoToolInvocations(content);
    expect(cleaned).toContain('Applying the approved changes now.');
    expect(cleaned).toContain('The changes are now staged for a pull request.');
    expect(cleaned).not.toContain('batch_edit_repo_files');
  });

  it('extracts filename-plus-code-fence repo edits from plain assistant text', () => {
    const content = `Here are the updated files:

\`index.html\`
\`\`\`html
<main>Updated</main>
\`\`\`

\`styles.css\`
\`\`\`css
body { color: white; }
\`\`\`
`;

    const edits = extractTextFileEdits(content);
    expect(edits).toHaveLength(2);
    expect(edits[0]).toMatchObject({
      path: 'index.html',
      content: '<main>Updated</main>',
      language: 'html',
    });
    expect(edits[1]).toMatchObject({
      path: 'styles.css',
      content: 'body { color: white; }',
      language: 'css',
    });
  });

  it('strips malformed repo payload blobs that leak into assistant markdown', () => {
    const content = `<p>[
{
"parameters": "import { useCards } from '../hooks/useCards';\\n\\nconst KanbanBoard = () => {\\n  return <div className=\\"flex flex-col\\">Board</div>;\\n};\\n\\nexport default KanbanBoard;",
"description": "Update KanbanBoard component to use modern design"
},
{
"parameters": "const CardModal = ({ onClose }) => {\\n  return <button onClick={onClose}>Close</button>;\\n};\\n\\nexport default CardModal;",
"description": "Update CardModal component to use modern design"
}
]</p>`;

    expect(stripPseudoToolInvocations(content)).toBe('');
  });

  it('strips malformed repo payload blobs even when they are appended after prose', () => {
    const content = `I can't help with that.

<p>[
{
"parameters":  from 'recharts';\\n\\nconst MetricsDashboard = () => {\\n  return (\\n    &lt;div className="metrics-dashboard"&gt;\\n      &lt;h2&gt;Metrics Dashboard&lt;/h2&gt;\\n    &lt;/div&gt;\\n  );\\n};\\n\\nexport default MetricsDashboard;",
"description": "Update metrics dashboard to use modern charts and layout"
}
]</p>`;

    expect(stripPseudoToolInvocations(content)).toBe(`I can't help with that.`);
  });

  it('strips orphaned JSON array brackets left behind after code-block tool args are removed', () => {
    const content = `Here are the changes:

[
\`\`\`
{
  "parameters": {
    "path": "client/src/hooks/useGateway.ts"
  }
}
\`\`\`
]

[
\`\`\`
{
  "parameters": {
    "path": "server/src/services/gateway-client.ts"
  }
}
\`\`\`
]`;

    const cleaned = stripPseudoToolInvocations(content);
    expect(cleaned).not.toContain('[');
    expect(cleaned).not.toContain(']');
    expect(cleaned).toContain('Here are the changes:');
  });

  it('strips standalone bracket lines between tool-parameter code blocks', () => {
    const content = `\`\`\`
{
  "parameters": {
    "path": "src/index.ts"
  }
}
\`\`\`
]

[
\`\`\`
{
  "parameters": {
    "path": "src/app.ts"
  }
}
\`\`\``;

    const cleaned = stripPseudoToolInvocations(content);
    expect(cleaned).toBe('');
  });

  it('parses wrapped JSON repo payload arrays that leak into assistant text', () => {
    const content = `The changes have been successfully applied to the repository.

The optimized code for \`KanbanBoard.tsx\`, \`cards.ts\`, and \`gateway-client.ts\` has been updated.

[ { "parameters": { "path": "client/src/components/KanbanBoard.tsx" } }, { "parameters": { "path": "server/src/routes/cards.ts" } }, { "parameters": { "path": "server/src/services/gateway-client.ts" } } ]

[ { "parameters": { "changes": [ { "path": "client/src/components/KanbanBoard.tsx", "action": "edit", "content": "import { useState } from 'react';", "description": "Optimized KanbanBoard.tsx for better performance" }, { "path": "server/src/routes/cards.ts", "action": "edit", "content": "import { Router } from 'express';", "description": "Optimized cards.ts for better error handling" } ] } } ]`;

    const invocations = extractPseudoToolInvocations(content);

    expect(invocations.map((invocation) => invocation.toolName)).toEqual([
      'read_repo_file',
      'read_repo_file',
      'read_repo_file',
      'batch_edit_repo_files',
    ]);
    expect(invocations[0]?.args).toEqual({ path: 'client/src/components/KanbanBoard.tsx' });
    expect(invocations[3]?.args).toMatchObject({
      changes: [
        expect.objectContaining({ path: 'client/src/components/KanbanBoard.tsx', action: 'edit' }),
        expect.objectContaining({ path: 'server/src/routes/cards.ts', action: 'edit' }),
      ],
    });

    const cleaned = stripPseudoToolInvocations(content);
    expect(cleaned).toContain('The changes have been successfully applied to the repository.');
    expect(cleaned).toContain('The optimized code for `KanbanBoard.tsx`');
    expect(cleaned).not.toContain('"parameters"');
    expect(cleaned).not.toContain('"changes"');
  });
});
