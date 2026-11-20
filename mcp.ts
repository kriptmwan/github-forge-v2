// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0), revision
// 2026-07-28 via server/discover, with the 2025-11-25 initialize handshake as a
// fallback. Original code for this entry. The tools act on the same Store as REST.
//
// v2 note: issues created here carry ver: 0 (the store's cached-JSON version field).

import { VIEWER, type Store } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[],
): McpToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

export const TOOLS: McpToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    owner: { type: 'string', description: 'The owner login of the new repository.' },
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List pull requests in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge a pull request with a squash commit onto its base branch.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (canonical: string): boolean => normalized === canonical || normalized.endsWith(canonical);
  const owner = asString(args.owner) ?? VIEWER.login;
  const repoName = asString(args.repo) ?? asString(args.repository) ?? asString(args.name) ?? null;

  if (find('createrepo') || find('createrepository')) {
    const repoNameArg = asString(args.name) ?? asString(args.repo) ?? null;
    if (!repoNameArg) return errorResult('create_repo requires a name');
    const repo = store.createRepo(repoNameArg, typeof args.description === 'string' ? args.description : '', args.private === true);
    if (!repo) return errorResult(`repository ${owner}/${repoNameArg} already exists`);
    return okResult(store.repoJson(repo));
  }
  if (find('getrepo') || find('getrepository')) {
    if (!repoName) return errorResult('get_repo requires owner and repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    return okResult(store.repoJson(repo));
  }
  if (find('createissue')) {
    const title = asString(args.title);
    if (!repoName) return errorResult('create_issue requires owner and repo');
    if (!title) return errorResult('create_issue requires a title');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
    for (const label of labels) {
      if (!repo.labels.has(label)) return errorResult(`label ${label} does not exist`);
    }
    const issue = {
      id: store.nextRestId++,
      number: repo.nextNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels,
      comments: [],
      createdSeq: store.nextSeq++,
      ver: 0,
    };
    repo.issues.push(issue);
    return okResult(store.issueJson(repo, issue));
  }
  if (find('listissues')) {
    if (!repoName) return errorResult('list_issues requires owner and repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = repo.issues.filter((i) => state === 'all' ? true : i.state === state);
    return okResult(list.map((i) => store.issueJson(repo, i)));
  }
  if (find('getissue')) {
    const number = asNumber(args.issue_number ?? args.number);
    if (!repoName) return errorResult('get_issue requires owner and repo');
    if (number === null) return errorResult('get_issue requires an issue number');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const issue = repo.issues.find((i) => i.number === number);
    if (!issue) return errorResult(`issue #${number} not found`);
    return okResult(store.issueJson(repo, issue));
  }
  if (find('createpullrequest') || find('createpr')) {
    const title = asString(args.title);
    const head = asString(args.head);
    const base = asString(args.base);
    if (!repoName) return errorResult('create_pull_request requires owner and repo');
    if (!title || !head || !base) return errorResult('create_pull_request requires title, head and base');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (!headSha || !baseSha) return errorResult('head or base branch not found');
    const pull = {
      id: store.nextRestId++,
      number: repo.nextNumber++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null as string | null,
      mergeSha: null as string | null,
      createdSeq: store.nextSeq++,
    };
    repo.pulls.push(pull);
    return okResult(store.pullJson(repo, pull));
  }
  if (find('listpullrequests') || find('listprs')) {
    if (!repoName) return errorResult('list_pull_requests requires owner and repo');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = repo.pulls.filter((p) => state === 'all' ? true : p.state === state);
    return okResult(list.map((p) => store.pullJson(repo, p)));
  }
  if (find('mergepullrequest') || find('mergepr')) {
    const number = asNumber(args.pull_number ?? args.number);
    if (!repoName) return errorResult('merge_pull_request requires owner and repo');
    if (number === null) return errorResult('merge_pull_request requires a pull number');
    const repo = store.getRepo(owner, repoName);
    if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
    const pull = repo.pulls.find((p) => p.number === number);
    if (!pull) return errorResult(`pull request #${number} not found`);
    if (pull.state !== 'open') return errorResult(`pull request #${number} is not open`);
    const sha = store.mergePull(repo, pull);
    if (sha === null) return errorResult(`pull request #${number} cannot be merged (conflict)`);
    return okResult({ sha, merged: true, message: `Merged pull request #${number}`, number });
  }
  return errorResult(`unknown tool: ${name}`);
}

export interface McpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function jsonBody(status: number, value: unknown): McpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'),
  };
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return jsonBody(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return jsonBody(200, { jsonrpc: '2.0', id, error: { code, message } });
}

/** Handle one POST /mcp request body (already read). `authed` is false when no valid token. */
export function handleMcp(store: Store, rawBody: Buffer, authed: boolean): McpResponse {
  if (!authed) {
    return jsonBody(401, { message: 'Requires authentication' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return jsonBody(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonBody(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  const req = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications (no id) get a 202 with no body.
  if (req.id === undefined) {
    return { status: 202, headers: {}, body: Buffer.alloc(0) };
  }

  switch (method) {
    case 'server/discover': {
      const result = {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        _meta: { serverInfo: SERVER_INFO },
      };
      return rpcResult(id, result);
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') return rpcError(id, -32602, 'tools/call requires a tool name');
      const known = TOOLS.some((t) => {
        const n = t.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return want === n || want.endsWith(n);
      });
      if (!known) return rpcError(id, -32602, `unknown tool: ${name}`);
      const result = callTool(store, name, args);
      return rpcResult(id, result);
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    default: {
      return rpcError(id, -32601, `method not found: ${method}`);
    }
  }
}
