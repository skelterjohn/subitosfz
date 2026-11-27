/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: {
      // Node's process.platform, exposed as a plain string (not
      // NodeJS.Platform) - the renderer's own tsconfig deliberately has no
      // Node ambient types, to avoid leaking Node globals into browser code.
      platform: string
      quitApp: () => Promise<void>
      newWindow: () => Promise<void>
      openOpcodesWindow: () => Promise<void>
      shouldAutoReopen: () => Promise<boolean>
      openGitHubRepo: () => Promise<void>
      openGitHubIssues: () => Promise<void>
      getServerPort: () => Promise<number>
      getStartTime: () => Promise<number>
      getWorkingSfzPath: (originalPath: string) => Promise<string>
      chooseSf2File: () => Promise<string | null>
      chooseDirectory: () => Promise<string | null>
      chooseSfzFile: () => Promise<string | null>
      getLastSfzFile: () => Promise<string | null>
      setLastSfzFile: (filePath: string | null) => Promise<void>
      getLastPivot: () => Promise<{ axis: string; value: string } | null>
      setLastPivot: (axis: string, value: string) => Promise<void>
      readAudioFile: (sfzFilePath: string, relativeSamplePath: string) => Promise<Uint8Array>
      listDirectory: (sfzFilePath: string) => Promise<string[]>
      deleteSampleFile: (sfzFilePath: string, relativeSamplePath: string) => Promise<void>
      chooseAudioFile: () => Promise<string | null>
      chooseMuseScoreFile: () => Promise<string | null>
      onMenuNew: (callback: () => void) => () => void
      onMenuImport: (callback: () => void) => () => void
      onMenuImportRecording: (callback: () => void) => () => void
      onMenuOpen: (callback: () => void) => () => void
      onMenuSave: (callback: () => void) => () => void
      onMenuSaveAs: (callback: () => void) => () => void
      onMenuDiscard: (callback: () => void) => () => void
      onMenuApplyMuseScore: (callback: () => void) => () => void
      onMenuAbout: (callback: () => void) => () => void
    }
  }
}
