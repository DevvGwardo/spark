// electron-builder afterPack hook.
//
// Signs every Mach-O binary inside resources/python-runtime/ with the app's
// Developer ID before electron-builder's main signing pass runs. Without this,
// the bundled Python interpreter fails to launch under hardened runtime at
// runtime because its binaries aren't signed by the same team as the parent
// .app — notarization would also flag the unsigned nested executables.
//
// No-op outside macOS, and no-op when signing credentials are absent (so local
// `electron:build` on a dev machine still produces a runnable unsigned app).

const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  if (!process.env.CSC_LINK || !process.env.APPLE_TEAM_ID) {
    console.log('[afterPack] skipping python-runtime signing (no signing credentials)');
    return;
  }

  const appName = packager.appInfo.productFilename;
  const pythonDir = path.join(appOutDir, `${appName}.app/Contents/Resources/python-runtime`);

  if (!existsSync(pythonDir)) {
    console.log(`[afterPack] python-runtime not found at ${pythonDir}, nothing to sign`);
    return;
  }

  const teamId = process.env.APPLE_TEAM_ID;
  const identities = execSync('security find-identity -v -p codesigning').toString();
  const match = identities.match(new RegExp(`"(Developer ID Application:[^"]+\\(${teamId}\\))"`));
  if (!match) {
    throw new Error(`[afterPack] no Developer ID Application identity for team ${teamId} in keychain`);
  }
  const signIdentity = match[1];
  const entitlements = path.join(__dirname, 'entitlements.mac.plist');

  console.log(`[afterPack] signing python-runtime with: ${signIdentity}`);

  const signCmd = [
    'codesign',
    '--force',
    '--timestamp',
    '--options', 'runtime',
    '--entitlements', `"${entitlements}"`,
    '--sign', `"${signIdentity}"`,
  ].join(' ');

  // Sign dylibs and .so extensions first (inside-out), then executables in bin/.
  // codesign accepts multiple paths via `find ... -exec ... {} +` batching.
  execSync(
    `find "${pythonDir}" -type f \\( -name "*.dylib" -o -name "*.so" \\) -exec ${signCmd} {} +`,
    { stdio: 'inherit' }
  );
  execSync(
    `find "${pythonDir}/bin" -type f -perm +111 -exec ${signCmd} {} +`,
    { stdio: 'inherit' }
  );

  console.log('[afterPack] python-runtime signed');
};
