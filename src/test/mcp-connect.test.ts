import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverMCPTools, discoverAllMCPTools } from '@/lib/mcp-connect';
import { useHermesStore, type MCPServer } from '@/stores/hermes-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    id: `mcp-${Math.random().toString(36).slice(2, 8)}`,
    name: 'test-server',
    url: 'http://localhost:9999/mcp',
    enabled: true,
    tools: [],
    transportType: 'http',
    connectionStatus: 'disconnected',
    errorCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('discoverMCPTools', () => {
  let statusCalls: Array<{ id: string; status: string; error?: string }>;
  let toolsCalls: Array<{ id: string; tools: unknown[] }>;

  beforeEach(() => {
    statusCalls = [];
    toolsCalls = [];

    // Spy on store actions so we can verify status transitions
    const store = useHermesStore.getState();
    vi.spyOn(store, 'setMCPServerConnectionStatus').mockImplementation(
      (id: string, status: any, error?: string) => {
        statusCalls.push({ id, status, error });
      },
    );
    vi.spyOn(store, 'setMCPServerTools').mockImplementation(
      (id: string, tools: any) => {
        toolsCalls.push({ id, tools });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Success cases -------------------------------------------------------

  it('discovers tools from a valid tools/list response', async () => {
    const responseBody = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
          { name: 'write_file', description: 'Write a file', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(responseBody)));

    const tools = await discoverMCPTools({ serverId: 'srv-1', url: 'http://localhost:9999/mcp' });

    expect(tools).toHaveLength(2);
    expect(tools![0].name).toBe('read_file');
    expect(tools![0].description).toBe('Read a file');
    expect(tools![1].name).toBe('write_file');

    // Store was updated
    expect(toolsCalls).toHaveLength(1);
    expect(toolsCalls[0].id).toBe('srv-1');
    expect(toolsCalls[0].tools).toHaveLength(2);

    // Status transitions: connecting → connected
    expect(statusCalls).toEqual([
      { id: 'srv-1', status: 'connecting', error: undefined },
      { id: 'srv-1', status: 'connected', error: undefined },
    ]);
  });

  it('returns empty array when server exposes no tools', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({
      result: { tools: [] },
    })));

    const tools = await discoverMCPTools({ serverId: 'srv-empty', url: 'http://localhost:9999/mcp' });

    expect(tools).toEqual([]);
    expect(toolsCalls[0].tools).toEqual([]);
  });

  it('returns empty array when result.tools is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({
      result: {},
    })));

    const tools = await discoverMCPTools({ serverId: 'srv-no-tools', url: 'http://localhost:9999/mcp' });

    expect(tools).toEqual([]);
  });

  it('filters out malformed tool entries without a name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({
      result: {
        tools: [
          { name: 'valid_tool', description: 'ok' },
          { description: 'no name' },               // should be filtered
          null,                                       // should be filtered
          { name: 42, description: 'name is number' }, // should be filtered
        ],
      },
    })));

    const tools = await discoverMCPTools({ serverId: 'srv-mixed', url: 'http://localhost:9999/mcp' });

    expect(tools).toHaveLength(1);
    expect(tools![0].name).toBe('valid_tool');
  });

  it('defaults missing description and inputSchema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({
      result: {
        tools: [
          { name: 'minimal_tool' },
        ],
      },
    })));

    const tools = await discoverMCPTools({ serverId: 'srv-min', url: 'http://localhost:9999/mcp' });

    expect(tools![0].description).toBe('');
    expect(tools![0].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  // --- API key handling ----------------------------------------------------

  it('includes Authorization header when apiKey is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await discoverMCPTools({ serverId: 'srv-auth', url: 'http://localhost:9999/mcp', apiKey: 'sk-secret-123' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer sk-secret-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('omits Authorization header when apiKey is not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await discoverMCPTools({ serverId: 'srv-noauth', url: 'http://localhost:9999/mcp' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('sends correct JSON-RPC payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await discoverMCPTools({ serverId: 'srv-rpc', url: 'http://localhost:9999/mcp' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9999/mcp');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  // --- Error cases ---------------------------------------------------------

  it('returns null and sets error status on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse(null, false, 403)));

    const tools = await discoverMCPTools({ serverId: 'srv-http-err', url: 'http://localhost:9999/mcp' });

    expect(tools).toBeNull();
    expect(statusCalls).toEqual([
      { id: 'srv-http-err', status: 'connecting', error: undefined },
      { id: 'srv-http-err', status: 'error', error: 'Failed to connect: HTTP 403' },
    ]);
    // Tools should NOT have been set
    expect(toolsCalls).toHaveLength(0);
  });

  it('returns null and sets error status on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const tools = await discoverMCPTools({ serverId: 'srv-net-err', url: 'http://localhost:9999/mcp' });

    expect(tools).toBeNull();
    expect(statusCalls).toEqual([
      { id: 'srv-net-err', status: 'connecting', error: undefined },
      { id: 'srv-net-err', status: 'error', error: 'Failed to connect: ECONNREFUSED' },
    ]);
  });

  it('handles non-Error thrown values gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('string error'));

    const tools = await discoverMCPTools({ serverId: 'srv-str-err', url: 'http://localhost:9999/mcp' });

    expect(tools).toBeNull();
    expect(statusCalls[1].error).toBe('Failed to connect: string error');
  });
});

// ---------------------------------------------------------------------------
// discoverAllMCPTools
// ---------------------------------------------------------------------------

describe('discoverAllMCPTools', () => {
  let statusSpy: ReturnType<typeof vi.spyOn>;
  let toolsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statusSpy = vi.spyOn(useHermesStore.getState(), 'setMCPServerConnectionStatus').mockImplementation(() => {});
    toolsSpy = vi.spyOn(useHermesStore.getState(), 'setMCPServerTools').mockImplementation(() => {});
  });

  afterEach(() => {
    useHermesStore.setState({ mcpServers: [] });
    vi.restoreAllMocks();
  });

  it('connects to all enabled HTTP servers in parallel', async () => {
    const servers: MCPServer[] = [
      makeServer({ id: 'srv-a', name: 'alpha', enabled: true, transportType: 'http' }),
      makeServer({ id: 'srv-b', name: 'beta', enabled: true, transportType: 'http' }),
    ];
    useHermesStore.setState({ mcpServers: servers });

    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await discoverAllMCPTools();

    expect(results).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Each server gets connecting + connected status
    expect(statusSpy).toHaveBeenCalledTimes(4);
    expect(toolsSpy).toHaveBeenCalledTimes(2);
  });

  it('skips disabled servers', async () => {
    const servers: MCPServer[] = [
      makeServer({ id: 'srv-on', enabled: true, transportType: 'http' }),
      makeServer({ id: 'srv-off', enabled: false, transportType: 'http' }),
    ];
    useHermesStore.setState({ mcpServers: servers });

    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await discoverAllMCPTools();

    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Only one server gets status updates
    expect(statusSpy).toHaveBeenCalledTimes(2);
  });

  it('skips stdio servers', async () => {
    const servers: MCPServer[] = [
      makeServer({ id: 'srv-http', enabled: true, transportType: 'http' }),
      makeServer({ id: 'srv-stdio', enabled: true, transportType: 'stdio' }),
    ];
    useHermesStore.setState({ mcpServers: servers });

    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: { tools: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await discoverAllMCPTools();

    expect(results).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/mcp');
  });

  it('returns null for individual failures without blocking others', async () => {
    const servers: MCPServer[] = [
      makeServer({ id: 'srv-ok', name: 'good', enabled: true, transportType: 'http' }),
      makeServer({ id: 'srv-fail', name: 'bad', enabled: true, transportType: 'http' }),
    ];
    useHermesStore.setState({ mcpServers: servers });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({ result: { tools: [{ name: 'tool_a' }] } }))
      .mockRejectedValueOnce(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    const results = await discoverAllMCPTools();

    expect(results).toHaveLength(2);
    // First server succeeded
    expect(results[0]).toEqual([{ name: 'tool_a', description: '', inputSchema: { type: 'object', properties: {} } }]);
    // Second server failed
    expect(results[1]).toBeNull();
    // Both servers got status updates
    expect(statusSpy).toHaveBeenCalledTimes(4);
  });
});
