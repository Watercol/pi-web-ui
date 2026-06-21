import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type GitPaths = {
  repoDir: string;
  headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular repos (.git is a directory) and worktrees (.git is a file).
 * Implementation mirrors the official pi TUI FooterDataProvider.findGitPaths.
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = cwd;

  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          // Worktree: .git is a file containing "gitdir: /actual/path"
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice(8).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            return { repoDir: dir, headPath };
          }
        } else if (stat.isDirectory()) {
          // Regular repo: .git is a directory
          const headPath = join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { repoDir: dir, headPath };
        }
      } catch {
        return null;
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGit(repoDir: string): string | null {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    },
  );
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch || null;
}

/**
 * Resolve the current git branch from cwd.
 * Returns the branch name, "detached" for detached HEAD, or null if not in a git repo.
 *
 * Logic mirrors the official pi TUI FooterDataProvider.resolveGitBranchSync:
 * 1. Walk up from cwd to find .git (handles worktrees)
 * 2. Read HEAD file
 * 3. Parse "ref: refs/heads/<branch>" → return branch name
 * 4. ".invalid" marker (reftable repos) → fall back to git symbolic-ref
 * 5. Otherwise → return "detached"
 */
export function resolveGitBranch(cwd: string): string | null {
  try {
    const gitPaths = findGitPaths(cwd);
    if (!gitPaths) return null;

    const content = readFileSync(gitPaths.headPath, "utf8").trim();

    if (content.startsWith("ref: refs/heads/")) {
      const branch = content.slice(16);
      // ".invalid" is a reftable placeholder — ask git for the real branch
      return branch === ".invalid"
        ? (resolveBranchWithGit(gitPaths.repoDir) ?? "detached")
        : branch;
    }

    return "detached";
  } catch {
    return null;
  }
}
