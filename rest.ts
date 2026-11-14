// REST v3 (GitHub API) surface. Every reply is JSON with a non-empty X-GitHub-Request-Id,
// errors are JSON `{message}`. Auth: Bearer token must equal MAKEFUN_SHOP_TOKEN (when the env
// var is set; unset means any non-empty token, for local runs). A wrong owner is 404, never 403.

import {
  Store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  EPOCH,
  parseCommit,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface HttpRequest {
  method: string;
  pathname: string;
  search: URLSearchParams;
  headers: Map<string, string>;
  body: Buffer;
  baseUrl: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | null;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function isoAt(seq: number): string {
  return new Date((EPOCH + seq) * 1000).toISOString();
}

function jsonResponse(store: Store, status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  const text = `${JSON.stringify(body)}\n`;
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'x-github-request-id': store.requestId(), ...extra },
    body: Buffer.from(text, 'utf8'),
  };
}

function errResponse(store: Store, status: number, message: string): HttpResponse {
  return jsonResponse(store, status, { message });
}

function tokenOf(req: HttpRequest): string | null {
  const auth = req.headers.get('authorization');
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth.trim());
  return match ? match[1] : null;
}

function authed(req: HttpRequest): boolean {
  const token = tokenOf(req);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return token === expected;
}

function parseBody(req: HttpRequest): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(req.body.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function pageParams(req: HttpRequest): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(req.search.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(req.search.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(store: Store, req: HttpRequest, items: T[]): { page: T[]; link: string | null } {
  const { perPage, page } = pageParams(req);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(req.search);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${req.baseUrl}${req.pathname}?${params.toString()}`;
  };
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${urlFor(1)}>; rel="first"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  return { page: pageItems, link: links.length ? links.join(', ') : null };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
  };
}

function labelJson(label: { name: string; color: string; description: string }): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.restId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.createdSeq),
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.restId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: null,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoAt(pr.createdSeq),
    updated_at: isoAt(pr.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: isoAt(comment.createdSeq),
    updated_at: isoAt(comment.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function handleRest(store: Store, req: HttpRequest): HttpResponse {
  const path = req.pathname;
  const method = req.method;

  // API root (public): 200 + X-OAuth-Scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return jsonResponse(
      store,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // Meta (public): installed_version must be a non-empty string.
  if (method === 'GET' && path === '/api/v3/meta') {
    return jsonResponse(store, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
  }

  // Everything else under /api/v3 needs a token.
  if (!path.startsWith('/api/v3/')) {
    return errResponse(store, 404, 'Not Found');
  }
  if (!authed(req)) {
    return errResponse(store, 401, 'Bad credentials');
  }

  // GET /api/v3/user
  if (method === 'GET' && path === '/api/v3/user') {
    return jsonResponse(store, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    });
  }

  // POST /api/v3/user/repos
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const parsed = parseBody(req);
    if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
    const name = asString(parsed.value.name);
    if (!name) return errResponse(store, 422, 'name is required');
    const description = asString(parsed.value.description);
    const isPrivate = asBool(parsed.value.private, false);
    const repo = store.createRepo(VIEWER_LOGIN, name, description, isPrivate);
    if (!repo) return errResponse(store, 422, 'Repository already exists');
    return jsonResponse(store, 201, repoJson(store, repo));
  }

  // GET /api/v3/user/repos (paginated)
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const repos = store.listRepos(VIEWER_LOGIN);
    const { page, link } = paginate(store, req, repos);
    const extra: Record<string, string> = {};
    if (link) extra.link = link;
    return jsonResponse(store, 200, page.map((repo) => repoJson(store, repo)), extra);
  }

  // /api/v3/repos/{owner}/{name}[/...]
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!repoMatch) {
    return errResponse(store, 404, 'Not Found');
  }
  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const rest = repoMatch[3] ?? '';
  const restParts = rest ? rest.split('/').map((p) => decodeURIComponent(p)) : [];

  if (owner !== VIEWER_LOGIN) {
    return errResponse(store, 404, 'Not Found');
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    return errResponse(store, 404, 'Not Found');
  }

  // GET /repos/{o}/{r}
  if (restParts.length === 0) {
    if (method === 'GET') return jsonResponse(store, 200, repoJson(store, repo));
    if (method === 'PATCH') {
      const parsed = parseBody(req);
      if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      return jsonResponse(store, 200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, headers: { 'x-github-request-id': store.requestId() }, body: null };
    }
    return errResponse(store, 404, 'Not Found');
  }

  const [head, ...tail] = restParts;

  // GET /repos/{o}/{r}/branches and /branches/{branch}
  if (head === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: oid, url: '' },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return jsonResponse(store, 200, branches);
    }
    if (method === 'GET' && tail.length === 1) {
      const oid = repo.refs.get(`refs/heads/${tail[0]}`);
      if (!oid) return errResponse(store, 404, 'Not Found');
      return jsonResponse(store, 200, {
        name: tail[0],
        commit: { sha: oid, url: '' },
        protected: false,
      });
    }
    return errResponse(store, 404, 'Not Found');
  }

  // GET /repos/{o}/{r}/commits
  if (head === 'commits') {
    if (method === 'GET' && tail.length === 0) {
      const ref = req.search.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (!tip) return errResponse(store, 404, 'Not Found');
      // First-parent walk from the tip, newest first, keeping each commit's oid.
      const withShas: Array<{ sha: string; commit: Record<string, unknown>; parents: Array<{ sha: string }> }> = [];
      const seen = new Set<string>();
      const queue: string[] = [tip];
      while (queue.length && withShas.length < 100) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = store.getObject(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        withShas.push({
          sha: oid,
          commit: {
            message: info.message,
            author: { name: info.authorName, email: info.authorEmail, date: new Date(info.authorTime * 1000).toISOString() },
            committer: { name: info.committerName, email: info.committerEmail, date: new Date(info.committerTime * 1000).toISOString() },
            tree: { sha: info.tree },
          },
          parents: info.parents.map((p) => ({ sha: p })),
        });
        for (const parent of info.parents) queue.push(parent);
      }
      const { page, link } = paginate(store, req, withShas);
      const extra: Record<string, string> = {};
      if (link) extra.link = link;
      return jsonResponse(store, 200, page, extra);
    }
    return errResponse(store, 404, 'Not Found');
  }

  // POST /repos/{o}/{r}/git/refs ; GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (head === 'git' && tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseBody(req);
      if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref || !/^[0-9a-f]{40}$/.test(sha)) return errResponse(store, 422, 'Invalid ref or sha');
      if (!store.getObject(sha)) return errResponse(store, 422, 'Object does not exist');
      if (repo.refs.has(ref)) return errResponse(store, 422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonResponse(store, 201, {
        ref,
        object: { sha, type: store.getObject(sha)?.type ?? 'commit' },
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
      });
    }
    if (method === 'GET' && tail.length >= 2) {
      const refName = `refs/${tail.join('/')}`;
      const oid = repo.refs.get(refName);
      if (!oid) return errResponse(store, 404, 'Not Found');
      return jsonResponse(store, 200, {
        ref: refName,
        object: { sha: oid, type: store.getObject(oid)?.type ?? 'commit' },
      });
    }
    return errResponse(store, 404, 'Not Found');
  }

  // POST /repos/{o}/{r}/labels
  if (head === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const parsed = parseBody(req);
      if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
      const name = asString(parsed.value.name);
      if (!name) return errResponse(store, 422, 'name is required');
      const color = asString(parsed.value.color) || 'ededed';
      const description = asString(parsed.value.description);
      const label = store.createLabel(repo, name, color, description);
      return jsonResponse(store, 201, labelJson(label));
    }
    return errResponse(store, 404, 'Not Found');
  }

  // Issues: /issues, /issues/{n}, /issues/{n}/comments
  if (head === 'issues') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = req.search.get('state') ?? 'open';
        const sort = req.search.get('sort') ?? 'created';
        const direction = req.search.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const { page, link } = paginate(store, req, issues);
        const extra: Record<string, string> = {};
        if (link) extra.link = link;
        return jsonResponse(store, 200, page.map((i) => issueJson(repo, i)), extra);
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
        const title = asString(parsed.value.title);
        const body = asString(parsed.value.body);
        const labels = asStringArray(parsed.value.labels);
        const created = store.createIssue(repo, title, body, labels);
        if ('error' in created) return errResponse(store, 422, `Label does not exist: ${created.label}`);
        return jsonResponse(store, 201, issueJson(repo, created));
      }
      return errResponse(store, 404, 'Not Found');
    }
    const num = Number.parseInt(tail[0], 10);
    if (!Number.isFinite(num)) return errResponse(store, 404, 'Not Found');
    const issue = repo.issues.get(num);
    if (!issue) return errResponse(store, 404, 'Not Found');
    if (tail.length === 1) {
      if (method === 'GET') return jsonResponse(store, 200, issueJson(repo, issue));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        if (Array.isArray(parsed.value.labels)) {
          const labels = asStringArray(parsed.value.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) return errResponse(store, 422, `Label does not exist: ${label}`);
          }
          issue.labels = labels;
        }
        return jsonResponse(store, 200, issueJson(repo, issue));
      }
      return errResponse(store, 404, 'Not Found');
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (method === 'GET') {
        const { page, link } = paginate(store, req, issue.comments);
        const extra: Record<string, string> = {};
        if (link) extra.link = link;
        return jsonResponse(store, 200, page.map((c) => commentJson(repo, issue, c)), extra);
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
        const body = asString(parsed.value.body);
        const comment = store.createComment(repo, issue, body);
        return jsonResponse(store, 201, commentJson(repo, issue, comment));
      }
      return errResponse(store, 404, 'Not Found');
    }
    return errResponse(store, 404, 'Not Found');
  }

  // Pulls: /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge
  if (head === 'pulls') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = req.search.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { page, link } = paginate(store, req, pulls);
        const extra: Record<string, string> = {};
        if (link) extra.link = link;
        return jsonResponse(store, 200, page.map((p) => prJson(repo, p)), extra);
      }
      if (method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
        const title = asString(parsed.value.title);
        const body = asString(parsed.value.body);
        const headRef = asString(parsed.value.head);
        const baseRef = asString(parsed.value.base);
        const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === headRef);
        if (existing) return errResponse(store, 422, 'A pull request already exists for this branch');
        const created = store.createPull(repo, title, body, headRef, baseRef);
        if ('error' in created) return errResponse(store, 422, `Invalid head or base: ${created.error}`);
        return jsonResponse(store, 201, prJson(repo, created));
      }
      return errResponse(store, 404, 'Not Found');
    }
    const num = Number.parseInt(tail[0], 10);
    if (!Number.isFinite(num)) return errResponse(store, 404, 'Not Found');
    const pr = repo.pulls.get(num);
    if (!pr) return errResponse(store, 404, 'Not Found');
    if (tail.length === 1) {
      if (method === 'GET') return jsonResponse(store, 200, prJson(repo, pr));
      return errResponse(store, 404, 'Not Found');
    }
    if (tail.length === 2 && tail[1] === 'files') {
      if (method === 'GET') {
        const files = pr.files.map((f) => ({
          filename: f.filename,
          path: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          sha: '',
          blob_url: '',
          raw_url: '',
        }));
        const { page, link } = paginate(store, req, files);
        const extra: Record<string, string> = {};
        if (link) extra.link = link;
        return jsonResponse(store, 200, page, extra);
      }
      return errResponse(store, 404, 'Not Found');
    }
    if (tail.length === 2 && tail[1] === 'merge') {
      if (method === 'PUT') {
        const merged = store.mergePull(repo, pr);
        if ('error' in merged) {
          if (merged.error === 'conflict') return errResponse(store, 405, 'Merge conflict');
          if (merged.error === 'already-merged') return errResponse(store, 409, 'Pull request is already merged');
          return errResponse(store, 405, 'Pull request is not mergeable');
        }
        return jsonResponse(store, 200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
      }
      return errResponse(store, 404, 'Not Found');
    }
    return errResponse(store, 404, 'Not Found');
  }

  // Contents: /contents/{path...}
  if (head === 'contents') {
    const filePath = tail.join('/');
    if (method === 'GET') {
      const ref = req.search.get('ref') ?? repo.defaultBranch;
      const read = store.readContents(repo, ref, filePath);
      if (!read) return errResponse(store, 404, 'Not Found');
      if (read.kind === 'file') {
        return jsonResponse(store, 200, {
          type: 'file',
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: read.blobSha,
          size: read.content.length,
          encoding: 'base64',
          content: read.content.toString('base64'),
          url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
        });
      }
      return jsonResponse(store, 200, read.entries);
    }
    if (method === 'PUT') {
      const parsed = parseBody(req);
      if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
      const message = asString(parsed.value.message) || 'Update file';
      const contentB64 = asString(parsed.value.content);
      if (!contentB64) return errResponse(store, 422, 'content is required');
      const branch = asString(parsed.value.branch) || repo.defaultBranch;
      const content = Buffer.from(contentB64, 'base64');
      const existing = store.readContents(repo, branch, filePath);
      const isUpdate = existing?.kind === 'file';
      if (isUpdate && typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.blobSha) {
        return errResponse(store, 409, 'sha does not match the current file');
      }
      const written = store.writeContents(repo, branch, filePath, content, message);
      const status = isUpdate ? 200 : 201;
      return jsonResponse(store, status, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: written.blobSha,
          size: content.length,
          type: 'file',
          encoding: 'base64',
          content: contentB64,
        },
        commit: { sha: written.commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseBody(req);
      if (!parsed.ok) return errResponse(store, 400, 'Problems parsing JSON');
      const message = asString(parsed.value.message) || 'Delete file';
      const branch = asString(parsed.value.branch) || repo.defaultBranch;
      const existing = store.readContents(repo, branch, filePath);
      if (!existing || existing.kind !== 'file') return errResponse(store, 404, 'Not Found');
      if (typeof parsed.value.sha === 'string' && parsed.value.sha !== existing.blobSha) {
        return errResponse(store, 409, 'sha does not match the current file');
      }
      const deleted = store.deleteContents(repo, branch, filePath, message);
      if (!deleted) return errResponse(store, 404, 'Not Found');
      return jsonResponse(store, 200, { commit: { sha: deleted.commitSha, message } });
    }
    return errResponse(store, 404, 'Not Found');
  }

  return errResponse(store, 404, 'Not Found');
}
