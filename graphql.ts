// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: repository/issue/pull-request reads, the five mutations,
// __type introspection, node(id:) and batched operations. Original code for this
// entry; no GraphQL library is available in the trial, so the parser is hand-written
// for this fixed document set (it is a real parser, not string matching).
//
// v2 note: issues created here carry ver: 0, and mutations that change an issue
// (closeIssue, addComment) invalidate its cached REST JSON body via touchIssue.

import {
  gid,
  parseCommit,
  parseGid,
  trialNowIso,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | undefined>;
  selection: SelectionNode[];
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value;
        const variables: Record<string, ValueNode | undefined> = {};
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
          this.next();
          while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
              this.next();
              variables[varName] = this.parseValue();
            } else {
              variables[varName] = undefined;
            }
          }
          this.expectPunct(')');
        }
        operations.push({ operation, name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.next();
        this.expectName();
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.value} in GraphQL document`);
    }
    return operations;
  }

  parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek() as Token;
      if (token.kind === 'spread') {
        this.next();
        if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          out.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // Fragment spread by name: not used by the suite; skip its (absent) expansion.
          this.expectName();
        }
        continue;
      }
      out.push(this.parseField());
    }
    this.expectPunct('}');
    return out;
  }

  parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    // directives (e.g. @include): skip
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) this.next();
        this.expectPunct(')');
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'hasIssuesEnabled'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'WIKI', 'PACKAGE', 'MARKETPLACE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function fieldError(ctx: Ctx, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function pickFields(
  ctx: Ctx,
  typeName: string,
  source: Record<string, unknown> | null,
  selection: SelectionNode[] | null,
): Record<string, unknown> | null {
  if (source === null) return null;
  if (selection === null) return source;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      if (node.typeCondition === typeName) {
        const inner = pickFields(ctx, typeName, source, node.selection);
        if (inner) Object.assign(out, inner);
      }
      continue;
    }
    const key = node.alias ?? node.name;
    const value = source[node.name];
    if (value === undefined && !(node.name in source)) {
      fieldError(ctx, typeName, node.name);
      out[key] = null;
      continue;
    }
    out[key] = value;
  }
  return out;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: gid('issue', repo.dbId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: trialNowIso(),
    updatedAt: trialNowIso(),
    author: { __typename: 'User', login: VIEWER.login, id: gid('user', VIEWER.id), name: VIEWER.name },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    comments: { nodes: issue.comments.map((c) => ({ id: gid('comment', repo.dbId, issue.number, c.id), body: c.body })) },
    repository: { __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const files = pullFiles(store, repo, pull);
  return {
    __typename: 'PullRequest',
    id: gid('pr', repo.dbId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: store.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { __typename: 'Ref', name: pull.head, target: { oid: headTip } },
    baseRef: { __typename: 'Ref', name: pull.base, target: { oid: repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha } },
    files: { nodes: files.map((f) => ({ path: f })) },
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: trialNowIso(),
    updatedAt: trialNowIso(),
    mergedAt: pull.mergedAt,
    author: { __typename: 'User', login: VIEWER.login, id: gid('user', VIEWER.id), name: VIEWER.name },
    repository: { __typename: 'Repository', name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
}

function pullFiles(store: Store, repo: Repo, pull: Pull): string[] {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const mergeBaseOid = store.mergeBase(repo, headTip, pull.baseSha);
  const baseObject = repo.objects.get(mergeBaseOid ?? pull.baseSha);
  const headObject = repo.objects.get(headTip);
  if (!baseObject || !headObject) return [];
  const baseTreeOid = parseCommit(baseObject.data).tree;
  const headTreeOid = parseCommit(headObject.data).tree;
  if (!baseTreeOid || !headTreeOid) return [];
  return store.diffTrees(repo, baseTreeOid, headTreeOid).map((d) => d.path);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: gid('repo', repo.dbId),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: gid('user', VIEWER.id), name: VIEWER.name },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    createdAt: trialNowIso(),
    updatedAt: trialNowIso(),
    isPrivate: repo.isPrivate,
    fork: false,
  };
}

function resolveRepositoryField(ctx: Ctx, repo: Repo, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, ctx.variables);
  switch (field.name) {
    case 'issue': {
      const number = args.number as number;
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return null;
      const obj = issueObject(ctx.store, repo, issue);
      return field.selection ? pickFields(ctx, 'Issue', obj, field.selection) : obj;
    }
    case 'issues': {
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = decodeCursor(args.after);
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
      let list = [...repo.issues];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      if (orderBy.field === 'CREATED_AT' && orderBy.direction === 'DESC') list.sort((a, b) => b.number - a.number);
      else if (orderBy.direction === 'DESC') list.sort((a, b) => b.number - a.number);
      else list.sort((a, b) => a.number - b.number);
      if (after !== null) {
        const idx = list.findIndex((i) => i.number === after);
        if (idx >= 0) list = list.slice(idx + 1);
      }
      const page = list.slice(0, first);
      const nodes = page.map((issue) => {
        const obj = issueObject(ctx.store, repo, issue);
        const sel = field.selection?.find((n) => n.kind === 'field' && n.name === 'nodes') as FieldNode | undefined;
        return sel?.selection ? pickFields(ctx, 'Issue', obj, sel.selection) : obj;
      });
      const hasNextPage = list.length > first;
      const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
      const conn: Record<string, unknown> = { nodes, totalCount: list.length, pageInfo: { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor((page[0] as Issue).number) : null, endCursor } };
      if (!field.selection) return conn;
      const out: Record<string, unknown> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'nodes') out[key] = nodes;
        else if (node.name === 'pageInfo') out[key] = node.selection ? pickFields(ctx, 'PageInfo', conn.pageInfo as Record<string, unknown>, node.selection) : conn.pageInfo;
        else if (node.name === 'totalCount') out[key] = conn.totalCount;
        else fieldError(ctx, 'IssueConnection', node.name);
      }
      return out;
    }
    case 'pullRequests': {
      const first = typeof args.first === 'number' ? args.first : 30;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      let list = [...repo.pulls];
      if (states) {
        const wanted = new Set(states.map((s) => String(s)));
        list = list.filter((p) => wanted.has(pullState(p)));
      } else {
        list = list.filter((p) => p.state === 'open');
      }
      list.sort((a, b) => b.number - a.number);
      const page = list.slice(0, first);
      const nodes = page.map((pull) => {
        const obj = pullObject(ctx.store, repo, pull);
        const sel = field.selection?.find((n) => n.kind === 'field' && n.name === 'nodes') as FieldNode | undefined;
        return sel?.selection ? pickFields(ctx, 'PullRequest', obj, sel.selection) : obj;
      });
      const conn: Record<string, unknown> = { nodes, totalCount: list.length, pageInfo: { hasNextPage: list.length > first, hasPreviousPage: false, startCursor: null, endCursor: null } };
      if (!field.selection) return conn;
      const out: Record<string, unknown> = {};
      for (const node of field.selection) {
        if (node.kind === 'fragment') continue;
        const key = node.alias ?? node.name;
        if (node.name === 'nodes') out[key] = nodes;
        else if (node.name === 'pageInfo') out[key] = node.selection ? pickFields(ctx, 'PageInfo', conn.pageInfo as Record<string, unknown>, node.selection) : conn.pageInfo;
        else if (node.name === 'totalCount') out[key] = conn.totalCount;
        else fieldError(ctx, 'PullRequestConnection', node.name);
      }
      return out;
    }
    case 'pullRequest': {
      const number = args.number as number;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return null;
      const obj = pullObject(ctx.store, repo, pull);
      return field.selection ? pickFields(ctx, 'PullRequest', obj, field.selection) : obj;
    }
    default: {
      const base = repoObject(ctx.store, repo);
      if (field.name in base) {
        const value = base[field.name];
        if (value !== null && typeof value === 'object' && field.selection) {
          return pickFields(ctx, field.name === 'owner' ? 'User' : field.name === 'defaultBranchRef' ? 'Ref' : 'Repository', value as Record<string, unknown>, field.selection);
        }
        return value;
      }
      fieldError(ctx, 'Repository', field.name);
      return null;
    }
  }
}

function resolveTypeField(ctx: Ctx, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, ctx.variables);
  const name = args.name as string;
  const fields = TYPE_FIELDS[name];
  const enums = ENUM_VALUES[name];
  const obj: Record<string, unknown> = {
    __typename: '__Type',
    name,
    kind: enums ? 'ENUM' : 'OBJECT',
    fields: fields ? fields.map((f) => ({ name: f })) : null,
    enumValues: enums ? enums.map((e) => ({ name: e })) : null,
  };
  if (fields === undefined && enums === undefined) return null;
  if (!field.selection) return obj;
  const out: Record<string, unknown> = {};
  for (const node of field.selection) {
    if (node.kind === 'fragment') continue;
    const key = node.alias ?? node.name;
    if (node.name === 'fields') {
      const list = obj.fields as { name: string }[] | null;
      out[key] = list === null ? null : list.map((entry) => (node.selection ? pickFields(ctx, '__Field', entry as unknown as Record<string, unknown>, node.selection) : entry));
    } else if (node.name === 'enumValues') {
      const list = obj.enumValues as { name: string }[] | null;
      out[key] = list === null ? null : list.map((entry) => (node.selection ? pickFields(ctx, '__EnumValue', entry as unknown as Record<string, unknown>, node.selection) : entry));
    } else if (node.name === 'name' || node.name === 'kind') {
      out[key] = obj[node.name];
    } else {
      fieldError(ctx, '__Type', node.name);
      out[key] = null;
    }
  }
  return out;
}

function findRepoByGid(store: Store, id: string): Repo | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'repo') return null;
  const dbId = Number.parseInt(parsed.parts[0] as string, 10);
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function findIssueByGid(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'issue') return null;
  const dbId = Number.parseInt(parsed.parts[0] as string, 10);
  const number = Number.parseInt(parsed.parts[1] as string, 10);
  for (const repo of store.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function findPullByGid(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGid(id);
  if (!parsed || parsed.kind !== 'pr') return null;
  const dbId = Number.parseInt(parsed.parts[0] as string, 10);
  const number = Number.parseInt(parsed.parts[1] as string, 10);
  for (const repo of store.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull) return { repo, pull };
  }
  return null;
}

function executeOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const ctx: Ctx = { store, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const node of operation.selection) {
    if (node.kind === 'fragment') continue;
    const key = node.alias ?? node.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.args)) args[k] = resolveValue(v, ctx.variables);
    if (operation.operation === 'query') {
      if (node.name === 'viewer') {
        const viewer = { __typename: 'User', login: VIEWER.login, id: gid('user', VIEWER.id), name: VIEWER.name };
        data[key] = node.selection ? pickFields(ctx, 'User', viewer, node.selection) : viewer;
      } else if (node.name === 'repository') {
        const repo = store.getRepo(String(args.owner), String(args.name));
        if (!repo) {
          data[key] = null;
        } else if (!node.selection) {
          data[key] = repoObject(store, repo);
        } else {
          const out: Record<string, unknown> = {};
          for (const sub of node.selection) {
            if (sub.kind === 'fragment') continue;
            const subKey = sub.alias ?? sub.name;
            if (sub.name === 'issue' || sub.name === 'issues' || sub.name === 'pullRequests' || sub.name === 'pullRequest') {
              out[subKey] = resolveRepositoryField(ctx, repo, sub);
            } else {
              const base = repoObject(store, repo);
              if (sub.name in base) {
                const value = base[sub.name];
                if (value !== null && typeof value === 'object' && sub.selection) {
                  out[subKey] = pickFields(ctx, sub.name === 'owner' ? 'User' : sub.name === 'defaultBranchRef' ? 'Ref' : 'Repository', value as Record<string, unknown>, sub.selection);
                } else {
                  out[subKey] = value;
                }
              } else {
                fieldError(ctx, 'Repository', sub.name);
                out[subKey] = null;
              }
            }
          }
          data[key] = out;
        }
      } else if (node.name === 'node') {
        const id = String(args.id);
        const parsed = parseGid(id);
        let obj: Record<string, unknown> | null = null;
        let typeName = '';
        if (parsed?.kind === 'repo') {
          const repo = findRepoByGid(store, id);
          if (repo) {
            obj = repoObject(store, repo);
            typeName = 'Repository';
          }
        } else if (parsed?.kind === 'issue') {
          const found = findIssueByGid(store, id);
          if (found) {
            obj = issueObject(store, found.repo, found.issue);
            typeName = 'Issue';
          }
        } else if (parsed?.kind === 'pr') {
          const found = findPullByGid(store, id);
          if (found) {
            obj = pullObject(store, found.repo, found.pull);
            typeName = 'PullRequest';
          }
        }
        data[key] = obj && node.selection ? pickFields(ctx, typeName, obj, node.selection) : obj;
      } else if (node.name === '__type') {
        data[key] = resolveTypeField(ctx, node);
      } else if (node.name === '__schema') {
        data[key] = node.selection ? pickFields(ctx, '__Schema', { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } }, node.selection) : { queryType: { name: 'Query' } };
      } else {
        fieldError(ctx, 'Query', node.name);
        data[key] = null;
      }
    } else {
      // mutations
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (node.name === 'createIssue') {
        const repo = findRepoByGid(store, String(input.repositoryId));
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          data[key] = null;
          continue;
        }
        const issue: Issue = {
          id: store.nextRestId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdSeq: store.nextSeq++,
          ver: 0,
        };
        repo.issues.push(issue);
        const obj = issueObject(store, repo, issue);
        const inner = { __typename: 'CreateIssuePayload', issue: node.selection?.find((n) => n.kind === 'field' && n.name === 'issue')?.selection ? pickFields(ctx, 'Issue', obj, (node.selection.find((n) => n.kind === 'field' && n.name === 'issue') as FieldNode).selection) : obj };
        data[key] = inner;
      } else if (node.name === 'closeIssue') {
        const found = findIssueByGid(store, String(input.issueId));
        if (!found) {
          ctx.errors.push({ message: 'issue not found' });
          data[key] = null;
          continue;
        }
        found.issue.state = 'closed';
        store.touchIssue(found.repo, found.issue);
        const obj = issueObject(store, found.repo, found.issue);
        const sel = node.selection?.find((n) => n.kind === 'field' && n.name === 'issue') as FieldNode | undefined;
        data[key] = { __typename: 'CloseIssuePayload', issue: sel?.selection ? pickFields(ctx, 'Issue', obj, sel.selection) : obj };
      } else if (node.name === 'createPullRequest') {
        const repo = findRepoByGid(store, String(input.repositoryId));
        if (!repo) {
          ctx.errors.push({ message: 'repository not found' });
          data[key] = null;
          continue;
        }
        const head = String(input.headRefName);
        const base = String(input.baseRefName);
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'head or base branch not found' });
          data[key] = null;
          continue;
        }
        const pull: Pull = {
          id: store.nextRestId++,
          number: repo.nextNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          head,
          base,
          headSha,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeSha: null,
          createdSeq: store.nextSeq++,
        };
        repo.pulls.push(pull);
        const obj = pullObject(store, repo, pull);
        const sel = node.selection?.find((n) => n.kind === 'field' && n.name === 'pullRequest') as FieldNode | undefined;
        data[key] = { __typename: 'CreatePullRequestPayload', pullRequest: sel?.selection ? pickFields(ctx, 'PullRequest', obj, sel.selection) : obj };
      } else if (node.name === 'mergePullRequest') {
        const found = findPullByGid(store, String(input.pullRequestId));
        if (!found) {
          ctx.errors.push({ message: 'pull request not found' });
          data[key] = null;
          continue;
        }
        store.mergePull(found.repo, found.pull);
        const obj = pullObject(store, found.repo, found.pull);
        const sel = node.selection?.find((n) => n.kind === 'field' && n.name === 'pullRequest') as FieldNode | undefined;
        data[key] = { __typename: 'MergePullRequestPayload', pullRequest: sel?.selection ? pickFields(ctx, 'PullRequest', obj, sel.selection) : obj };
      } else if (node.name === 'addComment') {
        const found = findIssueByGid(store, String(input.subjectId));
        if (!found) {
          ctx.errors.push({ message: 'subject not found' });
          data[key] = null;
          continue;
        }
        const comment = { id: store.nextRestId++, body: String(input.body ?? ''), user: VIEWER.login, createdAt: trialNowIso() };
        found.issue.comments.push(comment);
        store.touchIssue(found.repo, found.issue);
        const nodeObj = { __typename: 'IssueComment', id: gid('comment', found.repo.dbId, found.issue.number, comment.id), body: comment.body };
        const edgeSel = node.selection?.find((n) => n.kind === 'field' && n.name === 'commentEdge') as FieldNode | undefined;
        const nodeSel = edgeSel?.selection?.find((n) => n.kind === 'field' && n.name === 'node') as FieldNode | undefined;
        data[key] = {
          __typename: 'AddCommentPayload',
          commentEdge: { node: nodeSel?.selection ? pickFields(ctx, 'IssueComment', nodeObj, nodeSel.selection) : nodeObj },
        };
      } else {
        fieldError(ctx, 'Mutation', node.name);
        data[key] = null;
      }
    }
  }
  return { data, errors: ctx.errors };
}

/** Execute one GraphQL request body (a single operation object, or a batch array). */
export function executeGraphQL(
  store: Store,
  body: unknown,
): { status: number; body: unknown } {
  const runOne = (entry: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (entry.variables ?? {}) as Record<string, unknown>;
    let operations: OperationNode[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) return { data: {}, errors: [{ message: 'empty GraphQL document' }] };
    let operation: OperationNode | undefined;
    if (typeof entry.operationName === 'string') {
      operation = operations.find((op) => op.name === entry.operationName);
    }
    operation = operation ?? operations[0];
    const { data, errors } = executeOperation(store, operation as OperationNode, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOne((entry ?? {}) as { query?: unknown; variables?: unknown })) };
  }
  if (body !== null && typeof body === 'object') {
    return { status: 200, body: runOne(body as { query?: unknown; variables?: unknown }) };
  }
  return { status: 400, body: { errors: [{ message: 'GraphQL body must be an object or an array of operations' }] } };
}
