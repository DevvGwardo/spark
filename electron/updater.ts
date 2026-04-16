import { autoUpdater } from 'electron-updater'
import { dialog, BrowserWindow } from 'electron'

export function setupAutoUpdater(mainWindow: BrowserWindow) {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Private repo: a fine-grained read-only PAT is baked into the build at
  // CI time via the CLOUDCHAT_UPDATE_TOKEN env var (see .github/workflows/release.yml).
  // electron-updater needs it set on the GitHub provider to fetch releases.
  // For local dev / unsigned builds without the token, updates silently no-op.
  const updateToken = process.env.CLOUDCHAT_UPDATE_TOKEN
  if (updateToken) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'DevvGwardo',
      repo: 'cloud-chat-hub',
      private: true,
      token: updateToken,
    })
  }

  autoUpdater.on('update-available', (info) => {
    console.log(`Update available: ${info.version}`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart CloudChat to install the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('Auto-updater error:', error)
  })

  // Check for updates (silently fails if no internet or no releases)
  autoUpdater.checkForUpdates().catch(() => {})
}
