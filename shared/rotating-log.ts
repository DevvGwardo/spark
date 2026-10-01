/**
 * Minimal size-based rotating file log (spec Phase 3.4).
 *
 * `spark-bridge.log` is the live file; on overflow it shifts to `.1`, `.1` to
 * `.2`, and so on, keeping `maxFiles` files in total. Writes go through an
 * append stream so the Electron main thread never blocks on disk I/O; only the
 * (rare) rotation renames are synchronous.
 *
 * Logging must never take the bridge down, so every filesystem failure is
 * swallowed after the first warning.
 */
import { createWriteStream, existsSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export interface RotatingLogOptions {
  path: string;
  /** Bytes per file before rotating. Default 5 MB. */
  maxBytes?: number;
  /** Total files kept, including the live one. Default 5. */
  maxFiles?: number;
}

export interface RotatingLog {
  write(line: string): void;
  close(): void;
}

export function createRotatingLog(opts: RotatingLogOptions): RotatingLog {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 5);
  let stream: WriteStream | null = null;
  let size = 0;
  let broken = false;

  const fail = (err: unknown) => {
    if (!broken) console.warn(`[rotating-log] disabling ${opts.path}: ${(err as Error)?.message ?? err}`);
    broken = true;
    stream = null;
  };

  const open = () => {
    mkdirSync(dirname(opts.path), { recursive: true });
    // Opened synchronously so the file exists before the next rotation check;
    // buffered writes on a rotated-away stream follow its fd into `.1`.
    const fd = openSync(opts.path, 'a');
    size = fstatSync(fd).size;
    stream = createWriteStream(opts.path, { fd });
    stream.on('error', fail);
  };

  const rotate = () => {
    stream?.end();
    stream = null;
    const name = (i: number) => (i === 0 ? opts.path : `${opts.path}.${i}`);
    if (existsSync(name(maxFiles - 1))) rmSync(name(maxFiles - 1), { force: true });
    for (let i = maxFiles - 2; i >= 0; i--) {
      if (existsSync(name(i))) renameSync(name(i), name(i + 1));
    }
  };

  return {
    write(line: string) {
      if (broken) return;
      try {
        const text = line.endsWith('\n') ? line : `${line}\n`;
        const bytes = Buffer.byteLength(text);
        if (!stream) open();
        if (size > 0 && size + bytes > maxBytes) {
          rotate();
          open();
        }
        stream!.write(text);
        size += bytes;
      } catch (err) {
        fail(err);
      }
    },
    close() {
      stream?.end();
      stream = null;
    },
  };
}
