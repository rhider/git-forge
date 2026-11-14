// Shared in-memory store + git object model for the forge.
// One store serves REST v3, GraphQL v4, MCP and git smart HTTP, so a mutation on any surface is
// visible on the others. Everything is deterministic: server-created commits use a fixed identity
// and a monotonic counter timestamp, never the wall clock or Math.random.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
/** Scenario epoch (2025-01-01T00:00:00Z); server commit timestamps count up from here. */
export const EPOCH = 1735689600;

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface FileChange {
  filename: string;
  path: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  restId: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: FileChange[];
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Git tree entry sort: byte order of the name, directories compared as name + '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [];
  lines.push(`tree ${info.tree}`);
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorName} <${info.authorEmail}> ${info.authorTime} +0000`);
  lines.push(`committer ${info.committerName} <${info.committerEmail}> ${info.committerTime} +0000`);
  return Buffer.concat([
    Buffer.from(`${lines.join('\n')}\n\n`, 'utf8'),
    Buffer.from(info.message, 'utf8'),
  ]);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTime: 0,
    committerName: '',
    committerEmail: '',
    committerTime: 0,
    message,
  };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ') || line.startsWith('committer ')) {
      const isAuthor = line.startsWith('author ');
      const rest = line.slice(isAuthor ? 7 : 10);
      const lt = rest.indexOf('<');
      const gt = rest.indexOf('>');
      const name = lt >= 0 ? rest.slice(0, lt).trim() : rest;
      const email = lt >= 0 && gt > lt ? rest.slice(lt + 1, gt) : '';
      const after = gt >= 0 ? rest.slice(gt + 1).trim().split(/\s+/) : [];
      const time = after.length ? Number.parseInt(after[0], 10) : 0;
      if (isAuthor) {
        info.authorName = name;
        info.authorEmail = email;
        info.authorTime = Number.isFinite(time) ? time : 0;
      } else {
        info.committerName = name;
        info.committerEmail = email;
        info.committerTime = Number.isFinite(time) ? time : 0;
      }
    }
  }
  return info;
}

/** The `object <oid>` line of an annotated tag, or null when the object is not a tag. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match ? match[1] : null;
}

export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function b64decode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextRestId = 100000;
  seq = 0;
  commitSeq = 0;
  reqSeq = 0;

  requestId(): string {
    this.reqSeq += 1;
    return `req-${this.reqSeq}`;
  }

  /** Deterministic commit timestamp: epoch + a monotonic counter. */
  nextCommitTime(): number {
    this.commitSeq += 1;
    return EPOCH + this.commitSeq;
  }

  nextIsoTime(): string {
    return new Date(this.nextCommitTime() * 1000).toISOString();
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = Store.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    this.seq += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.seq,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  headRefName(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a branch name, full ref, or object id to a commit oid (null when unknown). */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      return this.objects.has(ref) ? ref : null;
    }
    if (ref.startsWith('refs/')) {
      return repo.refs.get(ref) ?? null;
    }
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch) return byBranch;
    const byTag = repo.refs.get(`refs/tags/${ref}`);
    if (byTag) return byTag;
    return null;
  }

  /** Flatten a tree (recursively) into path → {oid, mode}. */
  treeMap(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build nested trees from a flat path map; returns the root tree oid. */
  mapToTree(flat: Map<string, { oid: string; mode: string }>): string {
    const dirFiles = new Map<string, Map<string, TreeEntry>>();
    const ensure = (dir: string): Map<string, TreeEntry> => {
      let m = dirFiles.get(dir);
      if (!m) {
        m = new Map<string, TreeEntry>();
        dirFiles.set(dir, m);
      }
      return m;
    };
    ensure('');
    for (const [path, value] of flat) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) ensure(parts.slice(0, i).join('/'));
      const name = parts[parts.length - 1];
      const dir = parts.slice(0, -1).join('/');
      ensure(dir).set(name, { mode: value.mode, name, oid: value.oid });
    }
    const build = (dir: string): string => {
      const entries = [...(dirFiles.get(dir)?.values() ?? [])];
      for (const sub of dirFiles.keys()) {
        if (sub === dir || sub === '') continue;
        const parent = sub.split('/').slice(0, -1).join('/');
        if (parent !== dir) continue;
        const name = sub.split('/').pop() as string;
        entries.push({ mode: '40000', name, oid: build(sub) });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build('');
  }

  commitParents(oid: string): string[] {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return [];
    return parseCommit(obj.data).parents;
  }

  commitTree(oid: string): string | null {
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Commits the client actually holds, given its have list and its shallow boundaries:
   *  follow parents from the haves, but never expand a shallow boundary commit (its parents
   *  are unknown to the client, so they are NOT held). */
  heldClosure(haves: readonly string[], shallowBoundaries: readonly string[] = []): Set<string> {
    const boundaries = new Set(shallowBoundaries);
    const out = new Set<string>();
    const stack: string[] = [...haves];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
        continue;
      }
      if (obj.type !== 'commit') continue;
      out.add(oid);
      if (boundaries.has(oid)) continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /** All commit oids reachable from `tips` (following parents; tags dereferenced). */
  commitClosure(tips: readonly string[]): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
        continue;
      }
      if (obj.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return out;
  }

  /** Commits within `depth` generations of `wants` (wants themselves are generation 1). */
  commitsWithinDepth(wants: readonly string[], depth: number): Set<string> {
    const out = new Set<string>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      const obj = this.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) queue.push({ oid: target, gen: 1 });
        continue;
      }
      if (obj.type === 'commit') queue.push({ oid: want, gen: 1 });
    }
    while (queue.length) {
      const { oid, gen } = queue.shift() as { oid: string; gen: number };
      if (out.has(oid) || gen > depth) continue;
      out.add(oid);
      if (gen < depth) {
        for (const parent of this.commitParents(oid)) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
    return out;
  }

  /** Full object closure of a commit set: the commits themselves + their trees + blobs
   *  (+ tag objects on the way). Parents are NOT followed: the commit set is computed
   *  separately (commitsWithinDepth / commitClosure), so a depth limit is honoured. */
  objectClosure(commitOids: ReadonlySet<string>, extraOids: readonly string[] = []): Set<string> {
    const out = new Set<string>();
    const stack: string[] = [...commitOids, ...extraOids];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target) stack.push(target);
      }
    }
    return out;
  }

  isAncestor(ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    return this.commitClosure([oid]).has(ancestor);
  }

  mergeBase(a: string, b: string): string | null {
    const aSet = this.commitClosure([a]);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aSet.has(oid)) return oid;
      for (const parent of this.commitParents(oid)) queue.push(parent);
    }
    return null;
  }

  /** First-parent walk from a ref tip (newest first). */
  walkCommits(fromOid: string, limit = 100): CommitInfo[] {
    const out: CommitInfo[] = [];
    const seen = new Set<string>();
    const queue: string[] = [fromOid];
    while (queue.length && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      out.push(info);
      for (const parent of info.parents) queue.push(parent);
    }
    return out;
  }

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    labels: string[],
  ): Issue | { error: 'unknown-label'; label: string } {
    for (const label of labels) {
      if (!repo.labels.has(label)) return { error: 'unknown-label', label };
    }
    this.seq += 1;
    const issue: Issue = {
      number: repo.nextNumber,
      restId: this.nextRestId,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.seq,
    };
    this.nextRestId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): IssueComment {
    this.seq += 1;
    const comment: IssueComment = { id: repo.nextCommentId, body, createdSeq: this.seq };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  /** Line-count approximation of a file diff (multiset intersection of lines). */
  static lineCounts(base: Buffer | null, head: Buffer | null): { additions: number; deletions: number } {
    const baseLines = base ? base.toString('utf8').split('\n') : [];
    const headLines = head ? head.toString('utf8').split('\n') : [];
    if (base && base.length && base[base.length - 1] === 0x0a) baseLines.pop();
    if (head && head.length && head[head.length - 1] === 0x0a) headLines.pop();
    const counts = new Map<string, number>();
    for (const line of baseLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of headLines) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        counts.set(line, n - 1);
        common += 1;
      }
    }
    return { additions: headLines.length - common, deletions: baseLines.length - common };
  }

  diffTrees(baseTree: string | null, headTree: string | null): FileChange[] {
    const baseMap = baseTree ? this.treeMap(baseTree) : new Map<string, { oid: string; mode: string }>();
    const headMap = headTree ? this.treeMap(headTree) : new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    const out: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const base = baseMap.get(path);
      const head = headMap.get(path);
      if (base && !head) {
        const blob = this.objects.get(base.oid);
        const { deletions } = Store.lineCounts(blob?.data ?? null, null);
        out.push({ filename: path, path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!base && head) {
        const blob = this.objects.get(head.oid);
        const { additions } = Store.lineCounts(null, blob?.data ?? null);
        out.push({ filename: path, path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (base && head && base.oid !== head.oid) {
        const baseBlob = this.objects.get(base.oid);
        const headBlob = this.objects.get(head.oid);
        const { additions, deletions } = Store.lineCounts(baseBlob?.data ?? null, headBlob?.data ?? null);
        out.push({ filename: path, path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): PullRequest | { error: string } {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (!headSha) return { error: 'head-not-found' };
    if (!baseSha) return { error: 'base-not-found' };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef) return { error: 'already-exists' };
    }
    const headTree = this.commitTree(headSha);
    const baseTree = this.commitTree(baseSha);
    const files = this.diffTrees(baseTree, headTree);
    this.seq += 1;
    const pr: PullRequest = {
      number: repo.nextNumber,
      restId: this.nextRestId,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      files,
      createdSeq: this.seq,
    };
    this.nextRestId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pr.number, pr);
    return pr;
  }

  /** Real mergeability: three-way conflict when head and base both changed a file differently.
   *  The base side is the CURRENT tip of the base branch, not the tip at PR creation time. */
  prMergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (!baseTip) return 'CONFLICTING';
    const base = this.mergeBase(pr.headSha, baseTip);
    if (!base) return 'CONFLICTING';
    const baseTree = this.commitTree(base);
    const headTree = this.commitTree(pr.headSha);
    const tipTree = this.commitTree(baseTip);
    if (!headTree || !tipTree || !baseTree) return 'CONFLICTING';
    const baseMap = this.treeMap(baseTree);
    const headMap = this.treeMap(headTree);
    const tipMap = this.treeMap(tipTree);
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path)?.oid ?? null;
      const h = headMap.get(path)?.oid ?? null;
      const t = tipMap.get(path)?.oid ?? null;
      if (h !== b && t !== b && h !== t) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a PR: one commit on the base branch with the head's tree. */
  mergePull(repo: Repo, pr: PullRequest): { merged: boolean; sha: string } | { error: string } {
    if (pr.merged) return { error: 'already-merged' };
    if (pr.state !== 'open') return { error: 'not-open' };
    if (this.prMergeable(repo, pr) === 'CONFLICTING') return { error: 'conflict' };
    const headTree = this.commitTree(pr.headSha);
    const baseTip = this.resolveRef(repo, pr.baseRef);
    if (!headTree || !baseTip) return { error: 'missing-ref' };
    const time = this.nextCommitTime();
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: headTree,
        parents: [baseTip],
        authorName: VIEWER_NAME,
        authorEmail: VIEWER_EMAIL,
        authorTime: time,
        committerName: VIEWER_NAME,
        committerEmail: VIEWER_EMAIL,
        committerTime: time,
        message: `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`,
      }),
    );
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = new Date(time * 1000).toISOString();
    pr.mergeCommitSha = commitOid;
    return { merged: true, sha: commitOid };
  }

  /** The tree oid of a directory inside a tree (null when the path is not a directory). */
  dirTreeOid(treeOid: string, dirPath: string): string | null {
    if (!dirPath) return treeOid;
    let current = treeOid;
    for (const part of dirPath.split('/')) {
      const obj = this.objects.get(current);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  readContents(
    repo: Repo,
    ref: string,
    path: string,
  ): { kind: 'file'; blobSha: string; content: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; type: string; sha: string; size: number }> } | null {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const tree = this.commitTree(tip);
    if (!tree) return null;
    const flat = this.treeMap(tree);
    const file = flat.get(path);
    if (file) {
      const blob = this.objects.get(file.oid);
      if (!blob) return null;
      return { kind: 'file', blobSha: file.oid, content: blob.data };
    }
    const prefix = path ? `${path}/` : '';
    const entries: Array<{ name: string; path: string; type: string; sha: string; size: number }> = [];
    const seen = new Set<string>();
    for (const [p, value] of flat) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split('/')[0];
      if (seen.has(first)) continue;
      seen.add(first);
      if (rest.includes('/')) {
        const subPath = prefix + first;
        const subTree = this.dirTreeOid(tree, subPath);
        entries.push({ name: first, path: subPath, type: 'dir', sha: subTree ?? '', size: 0 });
      } else {
        const blob = this.objects.get(value.oid);
        entries.push({ name: first, path: p, type: 'file', sha: value.oid, size: blob?.data.length ?? 0 });
      }
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  /** Create or update a file on a branch (creates the branch at the new commit when unborn). */
  writeContents(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject('blob', content);
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const baseTree = tip ? this.commitTree(tip) : null;
    const flat = baseTree ? this.treeMap(baseTree) : new Map<string, { oid: string; mode: string }>();
    flat.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.mapToTree(flat);
    const time = this.nextCommitTime();
    const parents = tip ? [tip] : [];
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents,
        authorName: VIEWER_NAME,
        authorEmail: VIEWER_EMAIL,
        authorTime: time,
        committerName: VIEWER_NAME,
        committerEmail: VIEWER_EMAIL,
        committerTime: time,
        message,
      }),
    );
    repo.refs.set(refName, commitOid);
    return { commitSha: commitOid, blobSha };
  }

  deleteContents(
    repo: Repo,
    branch: string,
    path: string,
    message: string,
  ): { commitSha: string } | null {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    if (!tip) return null;
    const tree = this.commitTree(tip);
    if (!tree) return null;
    const flat = this.treeMap(tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.mapToTree(flat);
    const time = this.nextCommitTime();
    const commitOid = this.putObject(
      'commit',
      buildCommit({
        tree: treeOid,
        parents: [tip],
        authorName: VIEWER_NAME,
        authorEmail: VIEWER_EMAIL,
        authorTime: time,
        committerName: VIEWER_NAME,
        committerEmail: VIEWER_EMAIL,
        committerTime: time,
        message,
      }),
    );
    repo.refs.set(refName, commitOid);
    return { commitSha: commitOid };
  }

  globalId(kind: string, ...parts: Array<string | number>): string {
    return b64encode(`${kind}:${parts.join(':')}`);
  }

  parseGlobalId(id: string): { kind: string; parts: string[] } | null {
    const decoded = b64decode(id);
    if (!decoded) return null;
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), parts: decoded.slice(colon + 1).split(':') };
  }
}
