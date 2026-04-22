import { beforeEach, describe, expect, it } from 'vitest';
import { getLocalAbsolutePath, getLocalImageTarget } from '@/lib/local-images';

const SNAPSHOT_BASENAME = `${'c'.repeat(64)}.png`;

describe('local image helpers', () => {
  beforeEach(() => {
    window.electronAPI = {
      apiPort: 3001,
      homeDir: '/Users/mockuser',
      platform: 'darwin',
      snapshotDir: '/Users/mockuser/Library/Application Support/CloudChat/image-snapshots',
      versions: { electron: '1', node: '1', chrome: '1' },
    };
  });

  it('round-trips snapshot asset URLs to the snapshot directory', () => {
    const assetUrl = `cloudchat-asset://snapshot/${SNAPSHOT_BASENAME}`;
    expect(getLocalAbsolutePath(assetUrl)).toBe(
      `/Users/mockuser/Library/Application Support/CloudChat/image-snapshots/${SNAPSHOT_BASENAME}`,
    );
    expect(
      getLocalImageTarget(
        `/Users/mockuser/Library/Application Support/CloudChat/image-snapshots/${SNAPSHOT_BASENAME}`,
      )?.srcUrl,
    ).toBe(assetUrl);
  });

  it('keeps legacy tmp and hermes asset URLs resolving for backward compatibility', () => {
    expect(getLocalAbsolutePath('cloudchat-asset://tmp/foo.png')).toBe('/tmp/foo.png');
    expect(getLocalAbsolutePath('cloudchat-asset://hermes/foo.png')).toBe('/Users/mockuser/.hermes/images/foo.png');
  });
});
