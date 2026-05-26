import { logger } from './lib/logger';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface FileEntry {
  path: string;        // relative path from root
  name: string;        // filename only
  isDirectory: boolean;
  size: number;        // bytes, 0 for directories
}

interface CachedScan {
  entries: FileEntry[];
  timestamp: number;
  rootPath: string;
}

const CACHE_TTL_MS = 15_000;      // 15 seconds
const MAX_ENTRIES = 25_000;
const GIT_CHECK_IGNORE_MAX_STDIN = 256 * 1024; // 256KB

export class WorkspaceIndex {
  private cache: Map<string, CachedScan> = new Map();

  async scan(rootPath: string): Promise<FileEntry[]> {
    const cached = this.cache.get(rootPath);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.entries;
    }

    const entries: FileEntry[] = [];
    await this.scanDir(rootPath, '', entries, 0);

    const filtered = await this.filterGitIgnored(rootPath, entries);

    this.cache.set(rootPath, {
      entries: filtered,
      timestamp: Date.now(),
      rootPath,
    });

    return filtered;
  }

  private async scanDir(
    rootPath: string,
    relativePath: string,
    entries: FileEntry[],
    depth: number,
  ): Promise<void> {
    if (entries.length >= MAX_ENTRIES) return;
    if (depth > 20) return;

    const absolutePath = relativePath ? join(rootPath, relativePath) : rootPath;

    let dirents;
    try {
      dirents = await readdir(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) break;

      if (dirent.name === '.git') continue;
      if (dirent.name === 'node_modules' || dirent.name === '.DS_Store') continue;
      if (dirent.name.startsWith('.') && !['.github', '.vscode', '.claude', '.env.example'].includes(dirent.name)) continue;

      const entryRelativePath = relativePath ? `${relativePath}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        entries.push({
          path: entryRelativePath,
          name: dirent.name,
          isDirectory: true,
          size: 0,
        });
        await this.scanDir(rootPath, entryRelativePath, entries, depth + 1);
      } else {
        let size = 0;
        try {
          const stats = await stat(join(rootPath, entryRelativePath));
          size = stats.size;
        } catch {}

        entries.push({
          path: entryRelativePath,
          name: dirent.name,
          isDirectory: false,
          size,
        });
      }
    }
  }

  private async filterGitIgnored(rootPath: string, entries: FileEntry[]): Promise<FileEntry[]> {
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd: rootPath });
    } catch {
      return entries;
    }

    const filePaths = entries
      .filter(e => !e.isDirectory)
      .map(e => e.path);

    if (filePaths.length === 0) return entries;

    const ignoredSet = new Set<string>();
    let batch: string[] = [];
    let batchBytes = 0;

    for (const path of filePaths) {
      const pathBytes = Buffer.byteLength(path) + 1;
      if (batchBytes + pathBytes > GIT_CHECK_IGNORE_MAX_STDIN) {
        await this.runCheckIgnore(rootPath, batch, ignoredSet);
        batch = [];
        batchBytes = 0;
      }
      batch.push(path);
      batchBytes += pathBytes;
    }
    if (batch.length > 0) {
      await this.runCheckIgnore(rootPath, batch, ignoredSet);
    }

    return entries.filter(e => !ignoredSet.has(e.path));
  }

  private async runCheckIgnore(rootPath: string, paths: string[], ignoredSet: Set<string>): Promise<void> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const proc = spawn('git', ['check-ignore', '--stdin'], { cwd: rootPath });
        let out = '';
        let err = '';
        proc.stdout.on('data', (d) => { out += d.toString(); });
        proc.stderr.on('data', (d) => { err += d.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
          // git check-ignore exit codes: 0 = matches found, 1 = no matches, >1 = error
          if (code === 0 || code === 1) resolve(out);
          else reject(Object.assign(new Error(err || `git check-ignore exited ${code}`), { code }));
        });
        proc.stdin.end(paths.join('\n'));
      });
      for (const line of stdout.trim().split('\n')) {
        if (line) ignoredSet.add(line);
      }
    } catch (err: any) {
      if (err.code !== 1) {
        logger.warn('[workspace-indexer] git check-ignore failed:', err.message);
      }
    }
  }

  search(query: string, entries: FileEntry[], limit: number = 50): FileEntry[] {
    const lowerQuery = query.toLowerCase();
    const scored: Array<{ entry: FileEntry; score: number }> = [];

    for (const entry of entries) {
      const nameLower = entry.name.toLowerCase();
      const pathLower = entry.path.toLowerCase();

      let score = 0;

      if (nameLower === lowerQuery) {
        score = 1000;
      } else if (nameLower.startsWith(lowerQuery)) {
        score = 500;
      } else if (nameLower.includes(lowerQuery)) {
        score = 200;
      } else if (pathLower.includes(lowerQuery)) {
        score = 100;
      } else if (this.fuzzyMatch(lowerQuery, nameLower)) {
        score = 50;
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(s => s.entry);
  }

  private fuzzyMatch(query: string, target: string): boolean {
    let qi = 0;
    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  invalidate(rootPath?: string): void {
    if (rootPath) {
      this.cache.delete(rootPath);
    } else {
      this.cache.clear();
    }
  }
}

export const workspaceIndex = new WorkspaceIndex();
