import { useEffect, useRef, useState } from 'react'
import appIconUrl from '../../../../resources/icon.svg'
import './TopMenuBar.css'

// macOS puts the application menu in the system menu bar (see
// Menu.setApplicationMenu in main/index.ts) - there's nothing for this
// component to draw there, it already looks exactly as expected. Every
// other platform has that native row hidden (win.setMenuBarVisibility in
// main/index.ts) in favor of this self-drawn equivalent, which mirrors the
// same File menu contents/accelerators (the accelerators still fire via the
// hidden native Menu - this is purely the visible, clickable half).
const NATIVE_MENU_PLATFORM = 'darwin'

interface MenuItemEntry {
  type: 'item'
  label: string
  accelerator?: string
  onClick: () => void
}

interface SeparatorEntry {
  type: 'separator'
}

type MenuEntry = MenuItemEntry | SeparatorEntry

export interface FileMenuActions {
  onNew: () => void
  onImportSf2: () => void
  onImportAudio: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onDiscardChanges: () => void
  onApplyToMuseScore: () => void
}

interface Props {
  actions: FileMenuActions
}

export default function TopMenuBar({ actions }: Props): React.JSX.Element | null {
  const [openMenu, setOpenMenu] = useState<'file' | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Closes on an outside click/Escape - the two ways a native dropdown
  // dismisses itself without picking anything.
  useEffect(() => {
    if (!openMenu) return
    function onPointerDown(e: PointerEvent): void {
      if (!containerRef.current?.contains(e.target as Node)) setOpenMenu(null)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openMenu])

  if (window.api.platform === NATIVE_MENU_PLATFORM) return null

  function runAndClose(fn: () => void): void {
    setOpenMenu(null)
    fn()
  }

  const fileEntries: MenuEntry[] = [
    { type: 'item', label: 'New…', accelerator: 'Ctrl+N', onClick: () => runAndClose(actions.onNew) },
    { type: 'item', label: 'Import SF2/SF3…', onClick: () => runAndClose(actions.onImportSf2) },
    { type: 'item', label: 'Import Audio…', onClick: () => runAndClose(actions.onImportAudio) },
    { type: 'item', label: 'Open…', accelerator: 'Ctrl+O', onClick: () => runAndClose(actions.onOpen) },
    { type: 'separator' },
    { type: 'item', label: 'Save', accelerator: 'Ctrl+S', onClick: () => runAndClose(actions.onSave) },
    {
      type: 'item',
      label: 'Save As…',
      accelerator: 'Ctrl+Shift+S',
      onClick: () => runAndClose(actions.onSaveAs)
    },
    { type: 'item', label: 'Discard Changes', onClick: () => runAndClose(actions.onDiscardChanges) },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Apply to MuseScore…',
      onClick: () => runAndClose(actions.onApplyToMuseScore)
    },
    { type: 'separator' },
    { type: 'item', label: 'Quit', accelerator: 'Ctrl+Q', onClick: () => runAndClose(() => window.api.quitApp()) }
  ]

  return (
    <div className="top-menu-bar" ref={containerRef}>
      <img className="top-menu-bar__icon" src={appIconUrl} alt="" />
      <button
        type="button"
        className={`top-menu-bar__label ${openMenu === 'file' ? 'is-open' : ''}`}
        onClick={() => setOpenMenu((v) => (v === 'file' ? null : 'file'))}
      >
        File
      </button>
      {/* On Windows there's no native title bar left at all (titleBarStyle
          'hidden' in main/index.ts) - this is the only place a window
          title shows up now. Static text, not the open file's path (that
          already has its own row further down) - just enough to still
          read as "a title bar" at a glance. */}
      <span className="top-menu-bar__title">subito sfz</span>
      {openMenu === 'file' && (
        <div className="top-menu-bar__dropdown">
          {fileEntries.map((entry, i) =>
            entry.type === 'separator' ? (
              <div key={i} className="top-menu-bar__separator" />
            ) : (
              <button
                key={entry.label}
                type="button"
                className="top-menu-bar__item"
                onClick={entry.onClick}
              >
                <span>{entry.label}</span>
                {entry.accelerator && (
                  <span className="top-menu-bar__accelerator">{entry.accelerator}</span>
                )}
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
