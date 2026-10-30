/// <reference types="vite/client" />

export {}

declare global {
  interface Window {
    api: {
      getServerPort: () => Promise<number>
      getStartTime: () => Promise<number>
    }
  }
}
