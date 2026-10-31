/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: {
      getServerPort: () => Promise<number>
      getStartTime: () => Promise<number>
      chooseSf2File: () => Promise<string | null>
      chooseDirectory: () => Promise<string | null>
      chooseSfzFile: () => Promise<string | null>
    }
  }
}
