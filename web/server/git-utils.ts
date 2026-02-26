import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GitRepoInfo {
  repoRoot: string;
  repoName: string;
  currentBranch: string;
  defaultBranch: string;
  isWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  worktreePath: string | null;
  ahead: number;
  behind: number;
}

export interface GitWorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
  isDirty: boolean;
}

export interface WorktreeCreateResult {
  worktreePath: string;
  /** The conceptual branch the user selected */
  branch: string;
  /** The actual git branch in the worktree (may be e.g. `main-wt-2` for duplicate sessions) */
  actualBranch: string;
  isNew: boolean;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const WORKTREES_BASE = join(homedir(), ".companion", "worktrees");

function sanitizeBranch(branch: string): string {
  return branch.replace(/\//g, "--");
}

function worktreeDir(repoName: string, branch: string): string {
  return join(WORKTREES_BASE, repoName, sanitizeBranch(branch));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitSafe(cmd: string, cwd: string): string | null {
  try {
    return git(cmd, cwd);
  } catch {
    return null;
  }
}

// ─── Functions ──────────────────────────────────────────────────────────────

export function getRepoInfo(cwd: string): GitRepoInfo | null {
  const repoRoot = gitSafe("rev-parse --show-toplevel", cwd);
  if (!repoRoot) return null;

  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", cwd) || "HEAD";
  const gitDir = gitSafe("rev-parse --git-dir", cwd) || "";
  // A linked worktree's .git dir is inside the main repo's .git/worktrees/
  const isWorktree = gitDir.includes("/worktrees/");

  const defaultBranch = resolveDefaultBranch(repoRoot);

  return {
    repoRoot,
    repoName: basename(repoRoot),
    currentBranch,
    defaultBranch,
    isWorktree,
  };
}

function resolveDefaultBranch(repoRoot: string): string {
  // Try origin HEAD
  const originRef = gitSafe("symbolic-ref refs/remotes/origin/HEAD", repoRoot);
  if (originRef) {
    return originRef.replace("refs/remotes/origin/", "");
  }
  // Fallback: check if main or master exists
  const branches = gitSafe("branch --list main master", repoRoot) || "";
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  // Last resort
  return "main";
}

export function listBranches(repoRoot: string): GitBranchInfo[] {
  // Get worktree mappings first
  const worktrees = listWorktrees(repoRoot);
  const worktreeByBranch = new Map<string, string>();
  for (const wt of worktrees) {
    if (wt.branch) worktreeByBranch.set(wt.branch, wt.path);
  }

  const result: GitBranchInfo[] = [];

  // Local branches
  const localRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)%09%(HEAD)' refs/heads/",
    repoRoot,
  );
  if (localRaw) {
    for (const line of localRaw.split("\n")) {
      if (!line.trim()) continue;
      const [name, head] = line.split("\t");
      const isCurrent = head?.trim() === "*";
      const { ahead, behind } = getBranchStatus(repoRoot, name);
      result.push({
        name,
        isCurrent,
        isRemote: false,
        worktreePath: worktreeByBranch.get(name) || null,
        ahead,
        behind,
      });
    }
  }

  // Remote branches (only those without a local counterpart)
  const localNames = new Set(result.map((b) => b.name));
  const remoteRaw = gitSafe(
    "for-each-ref '--format=%(refname:short)' refs/remotes/origin/",
    repoRoot,
  );
  if (remoteRaw) {
    for (const line of remoteRaw.split("\n")) {
      const full = line.trim();
      if (!full || full === "origin/HEAD") continue;
      const name = full.replace("origin/", "");
      if (localNames.has(name)) continue;
      result.push({
        name,
        isCurrent: false,
        isRemote: true,
        worktreePath: null,
        ahead: 0,
        behind: 0,
      });
    }
  }

  return result;
}

export function listWorktrees(repoRoot: string): GitWorktreeInfo[] {
  const raw = gitSafe("worktree list --porcelain", repoRoot);
  if (!raw) return [];

  const worktrees: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as GitWorktreeInfo);
      }
      current = { path: line.slice(9), isDirty: false, isMainWorktree: false };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.isMainWorktree = true;
    } else if (line === "") {
      // End of entry — check if main worktree (first one is always main)
      if (worktrees.length === 0 && current.path) {
        current.isMainWorktree = true;
      }
    }
  }
  // Push last entry
  if (current.path) {
    if (worktrees.length === 0) current.isMainWorktree = true;
    worktrees.push(current as GitWorktreeInfo);
  }

  // Check dirty status for each worktree
  for (const wt of worktrees) {
    wt.isDirty = isWorktreeDirty(wt.path);
  }

  return worktrees;
}

export function ensureWorktree(
  repoRoot: string,
  branchName: string,
  options?: { baseBranch?: string; createBranch?: boolean; forceNew?: boolean },
): WorktreeCreateResult {
  const repoName = basename(repoRoot);

  // Check if a worktree already exists for this branch
  const existing = listWorktrees(repoRoot);
  const found = existing.find((wt) => wt.branch === branchName);

  if (found && !options?.forceNew) {
    // Don't reuse the main worktree — it's the original repo checkout
    if (!found.isMainWorktree) {
      return { worktreePath: found.path, branch: branchName, actualBranch: branchName, isNew: false };
    }
  }

  // Find a unique path: append random 4-digit suffix if the base path is taken
  const basePath = worktreeDir(repoName, branchName);
  let targetPath = basePath;
  for (let attempt = 0; attempt < 100 && existsSync(targetPath); attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    targetPath = `${basePath}-${suffix}`;
  }
  if (existsSync(targetPath)) {
    targetPath = `${basePath}-${Date.now()}`;
  }

  // Ensure parent directory exists
  mkdirSync(join(WORKTREES_BASE, repoName), { recursive: true });

  // A worktree already exists for this branch — create a new uniquely-named
  // branch so multiple sessions can work on the same branch independently.
  if (found) {
    const commitHash = git("rev-parse HEAD", found.path);
    const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName);
    git(`worktree add -b ${uniqueBranch} "${targetPath}" ${commitHash}`, repoRoot);
    return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
  }

  // Check if branch already exists locally or on remote
  const branchExists =
    gitSafe(`rev-parse --verify refs/heads/${branchName}`, repoRoot) !== null;
  const remoteBranchExists =
    gitSafe(`rev-parse --verify refs/remotes/origin/${branchName}`, repoRoot) !== null;

  if (branchExists) {
    if (options?.forceNew) {
      // Create a uniquely-named branch so multiple sessions can work independently
      const commitHash = git(`rev-parse refs/heads/${branchName}`, repoRoot);
      const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName);
      git(`worktree add -b ${uniqueBranch} "${targetPath}" ${commitHash}`, repoRoot);
      return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
    }
    // Worktree add with existing local branch
    git(`worktree add "${targetPath}" ${branchName}`, repoRoot);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: false };
  }

  if (remoteBranchExists) {
    if (options?.forceNew) {
      const uniqueBranch = generateUniqueWorktreeBranch(repoRoot, branchName);
      git(`worktree add -b ${uniqueBranch} "${targetPath}" origin/${branchName}`, repoRoot);
      return { worktreePath: targetPath, branch: branchName, actualBranch: uniqueBranch, isNew: false };
    }
    // Create local tracking branch from remote
    git(`worktree add -b ${branchName} "${targetPath}" origin/${branchName}`, repoRoot);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: false };
  }

  if (options?.createBranch !== false) {
    // Create new branch from base — prefer remote ref (up-to-date after fetch)
    // over the potentially stale local ref
    const base = options?.baseBranch || resolveDefaultBranch(repoRoot);
    const remoteRef = `origin/${base}`;
    const startPoint =
      gitSafe(`rev-parse --verify refs/remotes/${remoteRef}`, repoRoot) !== null
        ? remoteRef
        : base;
    git(`worktree add -b ${branchName} "${targetPath}" ${startPoint}`, repoRoot);
    return { worktreePath: targetPath, branch: branchName, actualBranch: branchName, isNew: true };
  }

  throw new Error(`Branch "${branchName}" does not exist and createBranch is false`);
}

/**
 * Generate a unique branch name for a companion-managed worktree.
 * Pattern: `{branch}-wt-{random4digit}` (e.g. `main-wt-8374`).
 * Uses random suffixes to avoid collisions with leftover branches.
 */
export function generateUniqueWorktreeBranch(repoRoot: string, baseBranch: string): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${baseBranch}-wt-${suffix}`;
    if (gitSafe(`rev-parse --verify refs/heads/${candidate}`, repoRoot) === null) {
      return candidate;
    }
  }
  // Fallback: use timestamp if all random attempts collide (extremely unlikely)
  return `${baseBranch}-wt-${Date.now()}`;
}

export function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  options?: { force?: boolean; branchToDelete?: string },
): { removed: boolean; reason?: string } {
  if (!existsSync(worktreePath)) {
    // Already gone, clean up git's reference
    gitSafe("worktree prune", repoRoot);
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot);
    }
    return { removed: true };
  }

  if (!options?.force && isWorktreeDirty(worktreePath)) {
    return {
      removed: false,
      reason: "Worktree has uncommitted changes. Use force to remove anyway.",
    };
  }

  try {
    const forceFlag = options?.force ? " --force" : "";
    git(`worktree remove "${worktreePath}"${forceFlag}`, repoRoot);
    // Clean up the companion-managed branch after worktree removal
    if (options?.branchToDelete) {
      gitSafe(`branch -D ${options.branchToDelete}`, repoRoot);
    }
    return { removed: true };
  } catch (e: unknown) {
    return {
      removed: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export function isWorktreeDirty(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const status = gitSafe("status --porcelain", worktreePath);
  return status !== null && status.length > 0;
}

export function gitFetch(cwd: string): { success: boolean; output: string } {
  try {
    const output = git("fetch --prune", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}

export function gitPull(
  cwd: string,
): { success: boolean; output: string } {
  try {
    const output = git("pull", cwd);
    return { success: true, output };
  } catch (e: unknown) {
    return { success: false, output: e instanceof Error ? e.message : String(e) };
  }
}


export function checkoutBranch(cwd: string, branchName: string): void {
  git(`checkout ${branchName}`, cwd);
}

/**
 * Checkout an existing branch, or create a new one from origin/{defaultBranch}
 * (falling back to local defaultBranch if no remote ref exists).
 */
export function checkoutOrCreateBranch(
  cwd: string,
  branchName: string,
  options?: { createBranch?: boolean; defaultBranch?: string },
): { created: boolean } {
  // Try regular checkout first (works for existing local and remote-tracking branches)
  const checkoutResult = gitSafe(`checkout ${branchName}`, cwd);
  if (checkoutResult !== null) {
    return { created: false };
  }

  // Branch doesn't exist — create it if allowed
  if (!options?.createBranch) {
    throw new Error(`Branch "${branchName}" does not exist. Pass createBranch to create it.`);
  }

  const base = options.defaultBranch || resolveDefaultBranch(cwd);
  // Prefer remote ref (up-to-date after fetch) over potentially stale local ref
  const remoteRef = `origin/${base}`;
  const startPoint =
    gitSafe(`rev-parse --verify refs/remotes/${remoteRef}`, cwd) !== null
      ? remoteRef
      : base;
  git(`checkout -b ${branchName} ${startPoint}`, cwd);
  return { created: true };
}

export function getBranchStatus(
  repoRoot: string,
  branchName: string,
): { ahead: number; behind: number } {
  const raw = gitSafe(
    `rev-list --left-right --count origin/${branchName}...${branchName}`,
    repoRoot,
  );
  if (!raw) return { ahead: 0, behind: 0 };
  const [behind, ahead] = raw.split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

// ─── Commit History ──────────────────────────────────────────────────────────

export interface GitCommitInfo {
  hash: string;
  hashShort: string;
  subject: string;
  author: string;
  date: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitCommitLogResult {
  commits: GitCommitInfo[];
  total: number;
  scope: "branch" | "all";
  baseBranch: string;
}

export interface GitCommitFileInfo {
  path: string;
  insertions: number;
  deletions: number;
}

export interface GitCommitDetail {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  files: GitCommitFileInfo[];
  diff: string;
}

/**
 * Get commit log. Defaults to branch scope (main..HEAD) and falls back to
 * "recent N" when on the default branch itself.
 */
export function getCommitLog(
  cwd: string,
  options?: { limit?: number; offset?: number; scope?: "branch" | "all" },
): GitCommitLogResult {
  const limit = options?.limit ?? 20;
  const offset = options?.offset ?? 0;
  const requestedScope = options?.scope ?? "branch";

  const defaultBranch = resolveDefaultBranch(cwd);
  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", cwd) || "HEAD";

  let scope: "branch" | "all" = requestedScope;
  let range = "";

  if (scope === "branch" && currentBranch !== defaultBranch && currentBranch !== "HEAD") {
    // Count total commits in branch range
    const countRaw = gitSafe(`rev-list --count ${defaultBranch}..HEAD`, cwd);
    const total = countRaw ? parseInt(countRaw, 10) : 0;
    range = `${defaultBranch}..HEAD`;

    if (total === 0) {
      scope = "all";
    } else {
      const logRaw = gitSafe(
        `log ${range} --skip=${offset} -n ${limit} --format=%H|%h|%s|%an|%aI --shortstat`,
        cwd,
      );
      return {
        commits: parseCommitLog(logRaw || ""),
        total,
        scope: "branch",
        baseBranch: defaultBranch,
      };
    }
  } else {
    scope = "all";
  }

  // "all" scope: recent commits
  const countRaw = gitSafe("rev-list --count HEAD", cwd);
  const total = countRaw ? parseInt(countRaw, 10) : 0;
  const logRaw = gitSafe(
    `log --skip=${offset} -n ${limit} --format=%H|%h|%s|%an|%aI --shortstat`,
    cwd,
  );
  return {
    commits: parseCommitLog(logRaw || ""),
    total: Math.min(total, 200), // Cap total for pagination sanity
    scope: "all",
    baseBranch: defaultBranch,
  };
}

function parseCommitLog(raw: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]?.trim();
    if (!line) { i++; continue; }

    const parts = line.split("|");
    if (parts.length < 5) { i++; continue; }

    const [hash, hashShort, subject, author, date] = parts;
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    // Next non-empty line might be --shortstat output
    i++;
    while (i < lines.length && lines[i]?.trim() === "") i++;
    if (i < lines.length) {
      const statLine = lines[i].trim();
      const filesMatch = statLine.match(/(\d+) files? changed/);
      const insMatch = statLine.match(/(\d+) insertions?\(\+\)/);
      const delMatch = statLine.match(/(\d+) deletions?\(-\)/);
      if (filesMatch || insMatch || delMatch) {
        filesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
        insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
        deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
        i++;
      }
    }

    commits.push({ hash, hashShort, subject, author, date, filesChanged, insertions, deletions });
  }

  return commits;
}

/**
 * Get details for a single commit: metadata, file list, and optionally
 * a diff scoped to a single file.
 */
export function getCommitDetail(
  cwd: string,
  hash: string,
  file?: string,
): GitCommitDetail {
  // Metadata
  const metaRaw = git(`show ${hash} --format=%H|%s|%b|%an|%aI --no-patch`, cwd);
  const metaParts = metaRaw.split("|");
  const commitHash = metaParts[0] || hash;
  const subject = metaParts[1] || "";
  const body = metaParts[2] || "";
  const author = metaParts[3] || "";
  const date = metaParts[4] || "";

  // File stats
  const statRaw = gitSafe(`diff-tree --no-commit-id -r --numstat ${hash}`, cwd) || "";
  const files: GitCommitFileInfo[] = statRaw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [ins, del, path] = l.split("\t");
      return {
        path: path || "",
        insertions: ins === "-" ? 0 : parseInt(ins, 10) || 0,
        deletions: del === "-" ? 0 : parseInt(del, 10) || 0,
      };
    });

  // Diff
  let diff = "";
  if (file) {
    diff = gitSafe(`show ${hash} -- "${file}"`, cwd) || "";
  } else {
    diff = gitSafe(`show ${hash} --format=`, cwd) || "";
  }

  return { hash: commitHash, subject, body, author, date, files, diff };
}
