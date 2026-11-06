/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: {
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
      onMenuImport: (callback: () => void) => () => void
      onMenuImportRecording: (callback: () => void) => () => void
      onMenuOpen: (callback: () => void) => () => void
      onMenuSave: (callback: () => void) => () => void
      onMenuSaveAs: (callback: () => void) => () => void
    }
  }
}
