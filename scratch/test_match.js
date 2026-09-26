const DESTRUCTIVE_PREFIXES = [
  '/api/hermes/moa',
  '/api/hermes/fallback',
  '/api/hermes/goals',
  '/api/hermes/tool-search',
  '/api/hermes/checkpoints/',
  '/api/hermes/curator/',
  '/api/hermes/computer-use/',
  '/api/hermes/pets/',
  '/api/hermes/bundles/',
  '/api/hermes/plugins/',
  '/api/hermes/claw/',
  '/api/hermes/kanban/',
  '/api/hermes/projects',
  '/api/hermes/auth/',
  '/api/hermes/portal/',
  '/api/hermes/workspace/skills',
  '/api/hermes/workspace/mcp-servers',
  '/api/hermes/workspace/files',
  '/api/hermes/messaging/platforms',
];

function isDestructive(method, path) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  return DESTRUCTIVE_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
}

console.log(isDestructive('DELETE', '/api/hermes/workspace/mcp-servers/foo')); // true
console.log(isDestructive('POST', '/api/hermes/workspace/skills/hub/install')); // true
console.log(isDestructive('PUT', '/api/hermes/workspace/files/abc')); // true
console.log(isDestructive('DELETE', '/api/hermes/sessions/123')); // false
console.log(isDestructive('POST', '/api/hermes/sessions/123/fork')); // false
