// GraphQL v4 surface: a minimal recursive-descent parser for the 18 sealed documents plus
// resolvers over the shared store (REST and GraphQL see the same objects). Supports variables,
// inline enums, inline input objects, null variables, aliases, inline fragments, and batched
// (array) request bodies. Unknown field → HTTP 200 with an errors array naming it. Unknown
// repository → 200, data.repository null, no errors. No token → 401.

import {
  Store,
  VIEWER_LOGIN,
  b64encode,
  b64decode,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        const raw = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// Parser (AST)
// -------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface Selection {
  kind: 'field' | 'fragment';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  typeCondition: string | null;
  selections: Selection[];
}

export interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Record<string, ValueNode | null>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected directive name');
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          varDefs: {},
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName.kind === 'name') {
          name = maybeName.value;
          this.next();
        }
        const varDefs: Record<string, ValueNode | null> = {};
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            const dollar = this.next();
            if (dollar.kind !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
            const varName = this.next();
            if (varName.kind !== 'name') throw new Error('expected variable name');
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '=') {
              this.next();
              defaultValue = this.parseValue();
            }
            varDefs[varName.value] = defaultValue;
          }
          this.expectPunct(')');
        }
        this.skipDirectives();
        operations.push({ kind: token.value as 'query' | 'mutation', name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        throw new Error('named fragments are not supported by this parser');
      }
      throw new Error(`unexpected token in GraphQL document: ${JSON.stringify(token)}`);
    }
    return operations;
  }

  private parseType(): void {
    // Type references are not needed for execution; consume them.
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected type name');
    }
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }

  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeName = this.next();
        if (typeName.kind !== 'name') throw new Error('expected type name after ... on');
        this.skipDirectives();
        return {
          kind: 'fragment',
          alias: null,
          name: '',
          args: {},
          typeCondition: typeName.value,
          selections: this.parseSelectionSet(),
        };
      }
      throw new Error('fragment spreads are not supported by this parser');
    }
    if (token.kind !== 'name') throw new Error('expected field name');
    this.next();
    const fieldName = token.value;
    let alias: string | null = null;
    let name = fieldName;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      const real = this.next();
      if (real.kind !== 'name') throw new Error('expected field name after alias');
      alias = fieldName;
      name = real.value;
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, typeCondition: null, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(')) return args;
    this.next();
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected argument name');
      this.expectPunct(':');
      args[name.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected variable name');
      return { kind: 'var', name: name.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.next();
        if (name.kind !== 'name') throw new Error('expected object field name');
        this.expectPunct(':');
        fields[name.value] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var': {
      return variables[node.name] ?? null;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Schema (introspection surface)
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequests',
    'pullRequest',
  ],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PROJECT', 'WIKI'];

// -------------------------------------------------------------------------------------------
// Execution
// -------------------------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type AnyRecord = Record<string, unknown>;

function repoOf(store: Store, repoId: number): Repo | undefined {
  return [...store.repos.values()].find((r) => r.id === repoId);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return store_globalId('Issue', repo.id, issue.number);
}

function store_globalId(kind: string, ...parts: Array<string | number>): string {
  return b64encode(`${kind}:${parts.join(':')}`);
}

function issueView(store: Store, repo: Repo, issue: Issue): AnyRecord {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    _repo: repo,
    _issue: issue,
  };
}

function prView(store: Store, repo: Repo, pr: PullRequest): AnyRecord {
  return {
    __typename: 'PullRequest',
    id: store_globalId('PullRequest', repo.id, pr.number),
    number: pr.number,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    _repo: repo,
    _pr: pr,
  };
}

function repoView(repo: Repo): AnyRecord {
  return {
    __typename: 'Repository',
    id: store_globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

function cursorFor(seq: number): string {
  return b64encode(`cursor:${seq}`);
}

function cursorSeq(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const decoded = b64decode(cursor);
  if (!decoded) return null;
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match ? Number.parseInt(match[1], 10) : null;
}

function resolveField(ctx: Ctx, parentType: string, parent: AnyRecord, field: Selection): unknown {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, ctx.variables);

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN };
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoView(repo) : null;
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = ctx.store.parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10));
        return repo ? repoView(repo) : null;
      }
      if (parsed.kind === 'Issue') {
        const repo = repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10));
        const issue = repo?.issues.get(Number.parseInt(parsed.parts[1], 10));
        return repo && issue ? issueView(ctx.store, repo, issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const repo = repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10));
        const pr = repo?.pulls.get(Number.parseInt(parsed.parts[1], 10));
        return repo && pr ? prView(ctx.store, repo, pr) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      if (name === 'SearchType') {
        return {
          __typename: '__Type',
          name,
          fields: [],
          enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v })),
        };
      }
      const fields = TYPE_FIELDS[name];
      if (!fields) return null;
      return {
        __typename: '__Type',
        name,
        fields: fields.map((f) => ({ __typename: '__Field', name: f })),
        enumValues: [],
      };
    }
  }

  if (parentType === 'Repository') {
    const repo = parent._repo as Repo;
    if (field.name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueView(ctx.store, repo, issue) : null;
    }
    if (field.name === 'issues') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      const afterSeq = cursorSeq(args.after);
      let issues = [...repo.issues.values()];
      if (states) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((i) => wanted.has(i.state));
      }
      issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      if (afterSeq !== null) {
        issues = issues.filter((i) => (direction === 'ASC' ? i.createdSeq > afterSeq : i.createdSeq < afterSeq));
      }
      const page = issues.slice(0, first);
      const hasNextPage = issues.length > first;
      const endCursor = page.length ? cursorFor(page[page.length - 1].createdSeq) : null;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((i) => issueView(ctx.store, repo, i)),
        pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
      };
    }
    if (field.name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq).slice(0, first);
      return {
        __typename: 'PullRequestConnection',
        nodes: pulls.map((p) => prView(ctx.store, repo, p)),
      };
    }
    if (field.name === 'pullRequest') {
      const pr = repo.pulls.get(Number(args.number));
      return pr ? prView(ctx.store, repo, pr) : null;
    }
  }

  if (parentType === 'PullRequest') {
    const pr = parent._pr as PullRequest;
    if (field.name === 'mergeable') {
      const repo = parent._repo as Repo;
      return ctx.store.prMergeable(repo, pr);
    }
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: pr.files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.path })),
      };
    }
  }

  if (parentType === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const parsed = ctx.store.parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10)) : undefined;
      if (!repo) return null;
      const created = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in created) return null;
      return { __typename: 'CreateIssuePayload', issue: issueView(ctx.store, repo, created) };
    }
    if (field.name === 'closeIssue') {
      const parsed = ctx.store.parseGlobalId(String(input.issueId ?? ''));
      const repo = parsed?.kind === 'Issue' ? repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !issue) return null;
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueView(ctx.store, repo, issue) };
    }
    if (field.name === 'createPullRequest') {
      const parsed = ctx.store.parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed?.kind === 'Repository' ? repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10)) : undefined;
      if (!repo) return null;
      const created = ctx.store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in created) return null;
      return { __typename: 'CreatePullRequestPayload', pullRequest: prView(ctx.store, repo, created) };
    }
    if (field.name === 'mergePullRequest') {
      const parsed = ctx.store.parseGlobalId(String(input.pullRequestId ?? ''));
      const repo = parsed?.kind === 'PullRequest' ? repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10)) : undefined;
      const pr = repo?.pulls.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !pr) return null;
      ctx.store.mergePull(repo, pr);
      return { __typename: 'MergePullRequestPayload', pullRequest: prView(ctx.store, repo, pr) };
    }
    if (field.name === 'addComment') {
      const parsed = ctx.store.parseGlobalId(String(input.subjectId ?? ''));
      const repo = parsed?.kind === 'Issue' ? repoOf(ctx.store, Number.parseInt(parsed.parts[0], 10)) : undefined;
      const issue = repo?.issues.get(Number.parseInt(parsed?.parts[1] ?? '', 10));
      if (!repo || !issue) return null;
      const comment = ctx.store.createComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: store_globalId('IssueComment', repo.id, issue.number, comment.id),
            body: comment.body,
          },
        },
      };
    }
  }

  // Plain object field: return the property (used for owner, defaultBranchRef, pageInfo, ...).
  if (parentType !== 'Query' && parentType !== 'Mutation') {
    if (field.name in parent) return parent[field.name];
  }
  return undefined;
}

function executeSelections(ctx: Ctx, parentType: string, parent: unknown, selections: Selection[]): AnyRecord | null {
  if (parent === null || parent === undefined) return null;
  if (Array.isArray(parent)) {
    // A list value is mapped over by the caller; this should not happen at the top level.
    return null;
  }
  if (typeof parent !== 'object') return null;
  const record = parent as AnyRecord;
  const typeName = typeof record.__typename === 'string' ? record.__typename : parentType;
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== typeName) continue;
      const merged = executeSelections(ctx, typeName, record, selection.selections);
      if (merged) Object.assign(out, merged);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, typeName, record, selection);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = executeValue(ctx, typeName, value, selection.selections);
  }
  return out;
}

function executeValue(ctx: Ctx, parentType: string, value: unknown, selections: Selection[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => executeValue(ctx, parentType, item, selections));
  }
  if (selections.length === 0) return value;
  if (typeof value === 'object') {
    return executeSelections(ctx, parentType, value, selections);
  }
  return value;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): { data: AnyRecord | null; errors: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, { __typename: rootType }, operation.selections);
  return { data, errors: ctx.errors };
}

// -------------------------------------------------------------------------------------------
// HTTP entry
// -------------------------------------------------------------------------------------------

export function handleGraphql(store: Store, body: Buffer): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): { data: AnyRecord | null; errors?: Array<{ message: string }> } => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    }
    const query = String((entry as Record<string, unknown>).query ?? '');
    const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    const operationName = (entry as Record<string, unknown>).operationName as string | undefined;
    let operations: Operation[];
    try {
      operations = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
    }
    const operation =
      operationName != null ? operations.find((op) => op.name === operationName) ?? operations[0] : operations[0];
    const result = executeOperation(store, operation, variables);
    if (result.errors.length) return { data: result.data, errors: result.errors };
    return { data: result.data };
  };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { status: 400, body: { errors: [{ message: 'Empty batch' }] } };
    return { status: 200, body: parsed.map((entry) => runOne(entry)) };
  }
  return { status: 200, body: runOne(parsed) };
}
