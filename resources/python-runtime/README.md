# Bundled Python runtime

This directory holds a portable Python interpreter that's packaged into the
Electron build via electron-builder's `extraResources`. The CI release workflow
(`.github/workflows/release.yml`) downloads a per-platform build of
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)
into this directory before invoking `electron-builder`.

On developer machines this directory is empty, and `electron/bridge.ts` falls
back to system Python (`python3` from PATH) so local dev is unaffected.

## Layout after CI populates it

```
resources/python-runtime/
├── bin/python3        (macOS/Linux)
├── python.exe         (Windows)
├── lib/
└── ...
```

`electron/bridge.ts` looks for `bin/python3` (or `python.exe` on Windows)
relative to this directory.
