import { afterEach, describe, expect, it } from 'vitest';
import { getApiBaseUrl, getApiPortFromUrl, getStoredApiPort } from '@/lib/api';

describe('getApiBaseUrl', () => {
  afterEach(() => {
    window.electronAPI = undefined;
    window.history.replaceState({}, '', '/');
    window.sessionStorage.clear();
  });

  it('extracts the embedded API port from the renderer URL', () => {
    expect(getApiPortFromUrl('http://localhost:5173/?apiPort=4312#/chat')).toBe(4312);
    expect(getApiPortFromUrl('file:///app/index.html?apiPort=9988#/chat')).toBe(9988);
    expect(getApiPortFromUrl('http://localhost:5173/')).toBeNull();
  });

  it('prefers the URL query param over the preload-exposed Electron API port', () => {
    window.electronAPI = {
      apiPort: 3555,
      platform: 'darwin',
      versions: {
        electron: '1',
        node: '1',
        chrome: '1',
      },
    };
    window.history.replaceState({}, '', '/?apiPort=4312');

    // URL param wins — Electron main process sets it on every launch
    expect(getApiBaseUrl()).toBe('http://localhost:4312');
  });

  it('falls back to the preload-exposed Electron API port when no URL param', () => {
    window.electronAPI = {
      apiPort: 3555,
      platform: 'darwin',
      versions: {
        electron: '1',
        node: '1',
        chrome: '1',
      },
    };

    expect(getApiBaseUrl()).toBe('http://localhost:3555');
  });

  it('falls back to the renderer URL query param when preload is unavailable', () => {
    window.history.replaceState({}, '', '/?apiPort=4312#/chat');

    expect(getApiBaseUrl()).toBe('http://localhost:4312');
  });

  it('reuses the cached API port when preload and query params are unavailable', () => {
    window.history.replaceState({}, '', '/?apiPort=4312#/chat');
    expect(getApiBaseUrl()).toBe('http://localhost:4312');
    expect(getStoredApiPort()).toBe(4312);

    window.history.replaceState({}, '', '/');

    expect(getApiBaseUrl()).toBe('http://localhost:4312');
  });
});
