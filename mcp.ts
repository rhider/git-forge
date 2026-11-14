// MCP (Model Context Protocol) surface at POST /mcp: JSON-RPC 2.0 Streamable HTTP.
// Modern era first: `server/discover` (revision 2026-07-28) with a legacy `initialize`
// handshake as fallback. Six tools share the store with REST and GraphQL, so an MCP-created
// object is the same object REST serves. Unknown tool → -32602; missing required args → -32602;
// non-JSON body → HTTP 400 + -32700; no Authorization → HTTP 401 exactly.

import { Store, VIEWER_LOGIN, VIEWER_ID, type Repo } from './store.ts';

export interface McpHttpRequest {
  method: string;
  pathname: string;
  headers: Map<string, string>;
  body: Buffer;
}

export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

const SERVER_NAME = 'makefun-git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

// One frozen object: tools/list must be byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function jsonBody(status: number, body: unknown): McpHttpResponse {
  const text = `${JSON.stringify(body)}\n`;
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(text, 'utf8') };
}

function rpcResult(id: unknown, result: unknown): McpHttpResponse {
  return jsonBody(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpHttpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return jsonBody(200, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function authed(headers: Map<string, string>): boolean {
  const auth = headers.get('authorization');
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  if (!match || !match[1]) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return match[1] === expected;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;

  if (name === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (!repoNameArg) return toolError('name is required');
    const created = store.createRepo(
      VIEWER_LOGIN,
      repoNameArg,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    if (!created) return toolError('Repository already exists');
    return toolText(repoJson(created));
  }
  if (name === 'get_repo') {
    if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
    return toolText(repoJson(repo));
  }
  if (name === 'create_issue') {
    if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const created = store.createIssue(repo, title, body, []);
    if ('error' in created) return toolError(`Label does not exist: ${created.label}`);
    return toolText({
      id: created.restId,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
      url: `/api/v3/repos/${owner}/${repoName}/issues/${created.number}`,
    });
  }
  if (name === 'list_issues') {
    if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => b.createdSeq - a.createdSeq);
    return toolText(
      issues.map((i) => ({ id: i.restId, number: i.number, title: i.title, body: i.body, state: i.state })),
    );
  }
  if (name === 'create_pull_request') {
    if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
    const title = typeof args.title === 'string' ? args.title : '';
    const body = typeof args.body === 'string' ? args.body : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    const created = store.createPull(repo, title, body, head, base);
    if ('error' in created) return toolError(`Invalid head or base: ${created.error}`);
    return toolText({
      id: created.restId,
      number: created.number,
      title: created.title,
      body: created.body,
      state: created.state,
      head: { ref: created.headRef, sha: created.headSha },
      base: { ref: created.baseRef, sha: created.baseSha },
    });
  }
  if (name === 'merge_pull_request') {
    if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
    const pr = repo.pulls.get(number);
    if (!pr) return toolError(`Pull request not found: ${number}`);
    const merged = store.mergePull(repo, pr);
    if ('error' in merged) return toolError(`Pull request is not mergeable: ${merged.error}`);
    return toolText({ merged: true, number: pr.number, sha: merged.sha, state: pr.state });
  }
  return null;
}

export function handleMcp(store: Store, req: McpHttpRequest): McpHttpResponse {
  if (req.method === 'DELETE') {
    return { status: 204, headers: {}, body: null };
  }
  if (req.method !== 'POST') {
    return jsonBody(405, { message: 'Method not allowed' });
  }
  if (!authed(req.headers)) {
    return jsonBody(401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    // Truncated / non-JSON body: HTTP 400 with JSON-RPC -32700. Recover the id when possible.
    const raw = req.body.toString('utf8');
    const match = /"id"\s*:\s*(\d+|"[^"]*")/.exec(raw);
    let id: unknown = null;
    if (match) {
      try {
        id = JSON.parse(match[1]);
      } catch {
        id = null;
      }
    }
    return { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } })}\n`, 'utf8') };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const body = parsed as Record<string, unknown>;
  const id = 'id' in body ? body.id : undefined;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get no JSON-RPC response.
  if (id === undefined) {
    return { status: 202, headers: {}, body: null };
  }

  if (method === 'server/discover') {
    const offered = req.headers.get('mcp-protocol-version');
    if (offered && REVISION_RE.test(offered) && !SUPPORTED_VERSIONS.includes(offered)) {
      return rpcError(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS });
    }
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    if (!REVISION_RE.test(offered) || !SUPPORTED_VERSIONS.includes(offered)) {
      return rpcError(id, -32602, 'Invalid params: protocolVersion must be a supported revision');
    }
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo,
    });
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const missing = tool.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null);
    if (missing.length) {
      return rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`);
    }
    const result = callTool(store, name, args);
    if (result === null) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    return rpcResult(id, result);
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}
