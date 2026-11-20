// app.ts — the forge's HTTP server: REST v3, GraphQL, MCP and git smart HTTP on one
// port. Original code for this entry. The lifecycle (bind, register, poll /done) lives
// in main.ts and is untouched.
//
// Conventions every reply follows: JSON bodies (never HTML), a non-empty
// X-GitHub-Request-Id, errors as {"message": string}, malformed JSON as 400, unknown
// routes as a JSON 404, and no token as 401 on every /api/v3 route except the root
// and /meta (which, like api.github.com, answer without one).
//
// v2 speed notes (conformance behavior unchanged):
// - The request URL is parsed ONCE per request in createApp; pathname + searchParams
//   are passed down instead of re-running `new URL` in every helper.
// - The expected bearer token is read from the environment ONCE at module load.
// - Git requests pass only the git-protocol header down (no per-request headers map).
// - GET /issues/{n} answers with the store's pre-serialized cached Buffer, and issue
//   create/PATCH answers reuse the same cached-body builder; mutations invalidate via
//   touchIssue. Repo deletion drops that repo's git caches.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, invalidateRepoCaches } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  Store,
  VIEWER,
  gid,
  isObjectId,
  parseCommit,
  trialNowIso,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();

// The trial token never changes during a run; read it once, not per request.
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The bearer token this request carries, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match ? (match[1] as string) : null;
}

/** True when the request is authenticated: the trial token when set, else any bearer. */
function isAuthed(req: IncomingMessage): boolean {
  const presented = bearerToken(req);
  if (presented === null || presented === '') return false;
  if (EXPECTED_TOKEN !== '') return presented === EXPECTED_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const requestId = store.nextRequestId();
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  const requestId = store.nextRequestId();
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

/** Parse a JSON request body: {} when empty, null + 400 when malformed. */
function parseJsonBody(res: ServerResponse, body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      badRequest(res, 'request body must be a JSON object');
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    badRequest(res, 'malformed JSON body');
    return null;
  }
}

function decodeSegments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** Paginate a list; returns the page and a Link header value (or null). */
function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string, host: string): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const pageNum = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  if (pageNum >= totalPages) return { page, link: null };
  const kept = new URLSearchParams(query);
  kept.set('per_page', String(perPage));
  const nextParams = new URLSearchParams(kept);
  nextParams.set('page', String(pageNum + 1));
  const lastParams = new URLSearchParams(kept);
  lastParams.set('page', String(totalPages));
  const base = `http://${host}${basePath}`;
  const link = `<${base}?${nextParams.toString()}>; rel="next", <${base}?${lastParams.toString()}>; rel="last"`;
  return { page, link };
}

function linkHeader(res: ServerResponse, status: number, body: unknown, link: string | null): void {
  sendJson(res, status, body, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res, 'Not Found');
    return null;
  }
  return repo;
}

function b64decode(content: string): Buffer {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function b64encode(data: Buffer): string {
  return data.toString('base64');
}

interface ContentFileView {
  type: 'file';
  encoding: 'base64';
  size: number;
  name: string;
  path: string;
  sha: string;
  content: string;
  url: string;
}

function contentFileView(repo: Repo, path: string, sha: string, data: Buffer): ContentFileView {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    sha,
    content: b64encode(data),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

async function handleRest(req: IncomingMessage, res: ServerResponse, body: Buffer, path: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';
  const segments = decodeSegments(path);

  // GET /api/v3/ — the API root (no auth, like api.github.com).
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // GET /api/v3/meta — no auth.
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', version: '1.0.0' });
    return;
  }

  if (!isAuthed(req)) {
    unauthorized(res);
    return;
  }

  // GET /api/v3/user
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: gid('user', VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      url: '/api/v3/user',
      html_url: `https://github.com/${VIEWER.login}`,
    });
    return;
  }

  // /api/v3/user/repos
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER.login).map((r) => store.repoJson(r));
      const { page, link } = paginate(repos, query, '/api/v3/user/repos', host);
      linkHeader(res, 200, page, link);
      return;
    }
    if (method === 'POST') {
      const json = parseJsonBody(res, body);
      if (json === null) return;
      const name = typeof json.name === 'string' ? json.name : '';
      if (name === '' || /[^\w.-]/.test(name) || name.length > 100) {
        sendJson(res, 422, { message: 'Invalid repository name' });
        return;
      }
      const repo = store.createRepo(
        name,
        typeof json.description === 'string' ? json.description : '',
        json.private === true,
      );
      if (!repo) {
        sendJson(res, 422, { message: `Repository ${VIEWER.login}/${name} already exists` });
        return;
      }
      sendJson(res, 201, store.repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos' && segments.length >= 5) {
    const owner = segments[3] as string;
    const repoName = segments[4] as string;
    const rest = segments.slice(5);

    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = repoOr404(res, owner, repoName);
        if (!repo) return;
        sendJson(res, 200, store.repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const repo = repoOr404(res, owner, repoName);
        if (!repo) return;
        const json = parseJsonBody(res, body);
        if (json === null) return;
        if (typeof json.description === 'string') repo.description = json.description;
        if (typeof json.private === 'boolean') repo.isPrivate = json.private;
        sendJson(res, 200, store.repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        const repo = repoOr404(res, owner, repoName);
        if (!repo) return;
        store.deleteRepo(owner, repoName);
        invalidateRepoCaches(owner, repoName);
        sendJson(res, 204, null);
        return;
      }
      notFound(res);
      return;
    }

    const repo = repoOr404(res, owner, repoName);
    if (!repo) return;

    // branches
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const names: string[] = [];
        for (const ref of repo.refs.keys()) {
          if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
        }
        names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : 1));
        sendJson(res, 200, names.map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' },
          protected: false,
        })));
        return;
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          notFound(res, 'Branch not found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return;
      }
      notFound(res);
      return;
    }

    // commits
    if (rest[0] === 'commits' && method === 'GET' && rest.length === 1) {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (!tip) {
        sendJson(res, 200, []);
        return;
      }
      const oids = store.commitWalk(repo, tip);
      const now = trialNowIso();
      const list = oids.map((oid) => {
        const object = store.getObject(repo, oid);
        const commit = object ? parseCommit(object.data) : null;
        const message = commit?.message ?? '';
        const authorLine = commit?.author ?? '';
        const authorName = authorLine.split(' <')[0] ?? VIEWER.name;
        const authorEmail = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? VIEWER.email;
        return {
          sha: oid,
          commit: {
            message,
            author: { name: authorName, email: authorEmail, date: now },
            committer: { name: authorName, email: authorEmail, date: now },
          },
          parents: (commit?.parents ?? []).map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(list, query, path, host);
      linkHeader(res, 200, page, link);
      return;
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'GET' && rest.length === 2) {
        const list: { ref: string; object: { sha: string } }[] = [];
        for (const [name, oid] of repo.refs) list.push({ ref: name, object: { sha: oid } });
        list.sort((a, b) => (a.ref < b.ref ? -1 : 1));
        sendJson(res, 200, list);
        return;
      }
      if (method === 'GET' && rest.length >= 3) {
        const refName = rest.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (!sha) {
          notFound(res, 'Reference does not exist');
          return;
        }
        sendJson(res, 200, { ref: refName, object: { sha } });
        return;
      }
      if (method === 'POST' && rest.length === 2) {
        const json = parseJsonBody(res, body);
        if (json === null) return;
        const ref = typeof json.ref === 'string' ? json.ref : '';
        const sha = typeof json.sha === 'string' ? json.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
      notFound(res);
      return;
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const json = parseJsonBody(res, body);
        if (json === null) return;
        const branch = typeof json.branch === 'string' && json.branch !== '' ? json.branch : repo.defaultBranch;
        const message = typeof json.message === 'string' ? json.message : 'update';
        const content = typeof json.content === 'string' ? json.content : null;
        if (content === null) {
          sendJson(res, 422, { message: 'content is required' });
          return;
        }
        // A branch that does not exist yet starts at the default branch tip.
        if (!repo.refs.has(`refs/heads/${branch}`)) {
          const base = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (base !== undefined) repo.refs.set(`refs/heads/${branch}`, base);
        }
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const data = b64decode(content);
        const blobSha = store.putObject(repo, 'blob', data);
        let currentSha: string | null = null;
        if (tip !== undefined) {
          const tree = parseCommit((store.getObject(repo, tip) as { data: Buffer }).data).tree;
          const resolved = store.resolvePath(repo, tree, filePath);
          currentSha = resolved?.oid ?? null;
        }
        if (typeof json.sha === 'string' && currentSha !== null && json.sha.toLowerCase() !== currentSha.toLowerCase()) {
          sendJson(res, 409, { message: 'sha does not match the current blob' });
          return;
        }
        const isUpdate = currentSha !== null;
        const { commitSha, contentSha } = store.commitFile(repo, { branch, path: filePath, content: data, message });
        void blobSha;
        sendJson(res, isUpdate ? 200 : 201, {
          content: { ...contentFileView(repo, filePath, contentSha, data), encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (!tip) {
          notFound(res, 'Not Found');
          return;
        }
        const tree = parseCommit((store.getObject(repo, tip) as { data: Buffer }).data).tree;
        if (filePath === '') {
          const entries = store.listDir(repo, tree, '');
          sendJson(res, 200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.path,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (store.getObject(repo, e.oid)?.data.length ?? 0),
            url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
          })));
          return;
        }
        const resolved = store.resolvePath(repo, tree, filePath);
        if (!resolved) {
          notFound(res, 'Not Found');
          return;
        }
        if (resolved.mode === '40000') {
          const entries = store.listDir(repo, tree, filePath);
          sendJson(res, 200, entries.map((e) => ({
            type: e.mode === '40000' ? 'dir' : 'file',
            name: e.name,
            path: e.path,
            sha: e.oid,
            size: e.mode === '40000' ? 0 : (store.getObject(repo, e.oid)?.data.length ?? 0),
            url: `/api/v3/repos/${owner}/${repoName}/contents/${e.path}`,
          })));
          return;
        }
        const object = store.getObject(repo, resolved.oid);
        if (!object) {
          notFound(res, 'Not Found');
          return;
        }
        sendJson(res, 200, contentFileView(repo, filePath, resolved.oid, object.data));
        return;
      }
      if (method === 'DELETE') {
        const json = parseJsonBody(res, body);
        if (json === null) return;
        const branch = typeof json.branch === 'string' && json.branch !== '' ? json.branch : repo.defaultBranch;
        const message = typeof json.message === 'string' ? json.message : 'delete';
        const deleted = store.deleteFile(repo, { branch, path: filePath, message });
        if (!deleted) {
          notFound(res, 'Not Found');
          return;
        }
        sendJson(res, 200, { commit: { sha: deleted.commitSha, message } });
        return;
      }
      notFound(res);
      return;
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const json = parseJsonBody(res, body);
        if (json === null) return;
        const name = typeof json.name === 'string' ? json.name : '';
        if (name === '') {
          sendJson(res, 422, { message: 'label name is required' });
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(res, 201, { name: existing.name, color: existing.color, description: existing.description });
          return;
        }
        const label = {
          name,
          color: typeof json.color === 'string' ? json.color.replace(/^#/, '') : 'ededed',
          description: typeof json.description === 'string' ? json.description : '',
        };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return;
      }
      notFound(res);
      return;
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const json = parseJsonBody(res, body);
          if (json === null) return;
          const title = typeof json.title === 'string' ? json.title : '';
          const labels = Array.isArray(json.labels) ? (json.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, { message: `label ${label} does not exist` });
              return;
            }
          }
          const issue = {
            id: store.nextRestId++,
            number: repo.nextNumber++,
            title,
            body: typeof json.body === 'string' ? json.body : '',
            state: 'open' as const,
            labels,
            comments: [],
            createdSeq: store.nextSeq++,
            ver: 0,
          };
          repo.issues.push(issue);
          sendRaw(res, 201, store.issueJsonBuffer(repo, issue), JSON_TYPE);
          return;
        }
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = query.get('sort') ?? 'created';
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, link } = paginate(list.map((i) => store.issueJson(repo, i)), query, path, host);
          linkHeader(res, 200, page, link);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) {
        notFound(res);
        return;
      }
      const issue = repo.issues.find((i) => i.number === number);
      if (rest.length === 2) {
        if (!issue) {
          notFound(res, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendRaw(res, 200, store.issueJsonBuffer(repo, issue), JSON_TYPE);
          return;
        }
        if (method === 'PATCH') {
          const json = parseJsonBody(res, body);
          if (json === null) return;
          if (typeof json.title === 'string') issue.title = json.title;
          if (typeof json.body === 'string') issue.body = json.body;
          if (json.state === 'open' || json.state === 'closed') issue.state = json.state;
          store.touchIssue(repo, issue);
          sendRaw(res, 200, store.issueJsonBuffer(repo, issue), JSON_TYPE);
          return;
        }
        notFound(res);
        return;
      }
      if (rest[2] === 'comments') {
        if (!issue) {
          notFound(res, 'Not Found');
          return;
        }
        if (method === 'POST') {
          const json = parseJsonBody(res, body);
          if (json === null) return;
          const comment = {
            id: store.nextRestId++,
            body: typeof json.body === 'string' ? json.body : '',
            user: VIEWER.login,
            createdAt: trialNowIso(),
          };
          issue.comments.push(comment);
          store.touchIssue(repo, issue);
          sendJson(res, 201, {
            id: comment.id,
            node_id: gid('comment', repo.dbId, issue.number, comment.id),
            body: comment.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: comment.createdAt,
            updated_at: comment.createdAt,
            url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}/comments/${comment.id}`,
          });
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id,
            node_id: gid('comment', repo.dbId, issue.number, c.id),
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
            created_at: c.createdAt,
            updated_at: c.createdAt,
            url: `/api/v3/repos/${owner}/${repoName}/issues/${issue.number}/comments/${c.id}`,
          })));
          return;
        }
        notFound(res);
        return;
      }
      notFound(res);
      return;
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const json = parseJsonBody(res, body);
          if (json === null) return;
          const title = typeof json.title === 'string' ? json.title : '';
          const head = typeof json.head === 'string' ? json.head : '';
          const base = typeof json.base === 'string' ? json.base : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) {
            sendJson(res, 422, { message: 'head or base branch not found' });
            return;
          }
          if (repo.pulls.some((p) => p.state === 'open' && p.head === head && p.base === base)) {
            sendJson(res, 422, { message: 'a pull request from this head branch is already open' });
            return;
          }
          const pull = {
            id: store.nextRestId++,
            number: repo.nextNumber++,
            title,
            body: typeof json.body === 'string' ? json.body : '',
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
          sendJson(res, 201, store.pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, link } = paginate(list.map((p) => store.pullJson(repo, p)), query, path, host);
          linkHeader(res, 200, page, link);
          return;
        }
        notFound(res);
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) {
        notFound(res);
        return;
      }
      const pull = repo.pulls.find((p) => p.number === number);
      if (rest.length === 2) {
        if (!pull) {
          notFound(res, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, store.pullJson(repo, pull));
          return;
        }
        notFound(res);
        return;
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (!pull) {
          notFound(res, 'Not Found');
          return;
        }
        const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
        // GitHub-style three-way diff: merge-base of head and the PR base.
        const mergeBaseOid = store.mergeBase(repo, headTip, pull.baseSha);
        const baseObject = store.getObject(repo, mergeBaseOid ?? pull.baseSha);
        const headObject = store.getObject(repo, headTip);
        if (!baseObject || !headObject) {
          sendJson(res, 200, []);
          return;
        }
        const baseTree = parseCommit(baseObject.data).tree;
        const headTree = parseCommit(headObject.data).tree;
        const diffs = store.diffTrees(repo, baseTree, headTree);
        const files = diffs.map((d) => {
          const oldText = d.oldOid ? (store.getObject(repo, d.oldOid)?.data.toString('utf8') ?? '') : '';
          const newText = d.newOid ? (store.getObject(repo, d.newOid)?.data.toString('utf8') ?? '') : '';
          const { additions, deletions } = store.lineDiff(oldText, newText);
          return {
            filename: d.path,
            status: d.status,
            additions,
            deletions,
            changes: additions + deletions,
            sha: d.newOid ?? d.oldOid ?? '',
          };
        });
        sendJson(res, 200, files);
        return;
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          notFound(res, 'Not Found');
          return;
        }
        // consume the body (merge_method) for the malformed-JSON check
        const json = parseJsonBody(res, body);
        if (json === null) return;
        if (pull.state !== 'open') {
          sendJson(res, 405, { message: 'pull request is not open' });
          return;
        }
        if (store.pullConflicts(repo, pull)) {
          sendJson(res, 405, { message: 'merge conflict' });
          return;
        }
        const sha = store.mergePull(repo, pull);
        if (sha === null) {
          sendJson(res, 405, { message: 'merge conflict' });
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
        return;
      }
      notFound(res);
      return;
    }

    notFound(res);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        // Parse the URL ONCE per request; pathname + query are passed down.
        let path = '/';
        let query = new URLSearchParams();
        try {
          const url = new URL(req.url ?? '/', 'http://entry');
          path = url.pathname;
          query = url.searchParams;
        } catch {
          path = '/';
          query = new URLSearchParams();
        }

        // health probe (no auth, no body)
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // git smart HTTP: /{owner}/{repo}.git/... (cheap pre-filter; handleGit runs the regex once)
        if (path.endsWith('.git') || path.includes('.git/')) {
          const body = method === 'GET' ? Buffer.alloc(0) : await readBody(req);
          const gp = req.headers['git-protocol'];
          const headers: Record<string, string | undefined> = {
            'git-protocol': typeof gp === 'string' ? gp : undefined,
          };
          const out = handleGit(store, method, path, query, headers, body);
          sendRaw(res, out.status, out.body, out.headers['content-type'] ?? 'application/octet-stream');
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const body = await readBody(req);
          const out = handleMcp(store, body, isAuthed(req));
          sendRaw(res, out.status, out.body, out.headers['content-type'] ?? JSON_TYPE);
          return;
        }

        // GraphQL
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!isAuthed(req)) {
            unauthorized(res);
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            badRequest(res, 'malformed JSON body');
            return;
          }
          const out = executeGraphQL(store, parsed);
          sendJson(res, out.status, out.body);
          return;
        }

        // REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          await handleRest(req, res, body, path, query);
          return;
        }

        notFound(res);
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          // the response is already gone; nothing to do
        }
      }
    })();
  });
}

export { Store };
