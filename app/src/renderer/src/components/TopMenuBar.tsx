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
  onNewWindow: () => void
  onNew: () => void
  onImportSf2: () => void
  onImportAudio: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onDiscardChanges: () => void
  onApplyToMuseScore: () => void
}

export interface HelpMenuActions {
  onGitHubRepo: () => void
  onGitHubIssues: () => void
  onAbout: () => void
}

interface Props {
  fileActions: FileMenuActions
  helpActions: HelpMenuActions
}

export default function TopMenuBar({ fileActions, helpActions }: Props): React.JSX.Element | null {
  // Menu id (not just 'file') since there's now more than one top-level
  // menu - generalized here rather than one boolean per menu, since the
  // original File-only comment already anticipated more menus arriving.
  const [openMenu, setOpenMenu] = useState<string | null>(null)
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
    {
      type: 'item',
      label: 'New Window',
      accelerator: 'Ctrl+Shift+N',
      onClick: () => runAndClose(fileActions.onNewWindow)
    },
    { type: 'separator' },
    { type: 'item', label: 'New…', accelerator: 'Ctrl+N', onClick: () => runAndClose(fileActions.onNew) },
    { type: 'item', label: 'Import SF2/SF3…', onClick: () => runAndClose(fileActions.onImportSf2) },
    { type: 'item', label: 'Import Audio…', onClick: () => runAndClose(fileActions.onImportAudio) },
    { type: 'item', label: 'Open…', accelerator: 'Ctrl+O', onClick: () => runAndClose(fileActions.onOpen) },
    { type: 'separator' },
    { type: 'item', label: 'Save', accelerator: 'Ctrl+S', onClick: () => runAndClose(fileActions.onSave) },
    {
      type: 'item',
      label: 'Save As…',
      accelerator: 'Ctrl+Shift+S',
      onClick: () => runAndClose(fileActions.onSaveAs)
    },
    { type: 'item', label: 'Discard Changes', onClick: () => runAndClose(fileActions.onDiscardChanges) },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Apply to MuseScore…',
      onClick: () => runAndClose(fileActions.onApplyToMuseScore)
    },
    { type: 'separator' },
    { type: 'item', label: 'Quit', accelerator: 'Ctrl+Q', onClick: () => runAndClose(() => window.api.quitApp()) }
  ]

  const helpEntries: MenuEntry[] = [
    { type: 'item', label: 'GitHub Repository', onClick: () => runAndClose(helpActions.onGitHubRepo) },
    { type: 'item', label: 'Report an Issue', onClick: () => runAndClose(helpActions.onGitHubIssues) },
    { type: 'separator' },
    { type: 'item', label: 'About Subito sfz', onClick: () => runAndClose(helpActions.onAbout) }
  ]

  const menus: { id: string; label: string; entries: MenuEntry[] }[] = [
    { id: 'file', label: 'File', entries: fileEntries },
    { id: 'help', label: 'Help', entries: helpEntries }
  ]

  return (
    <div className="top-menu-bar" ref={containerRef}>
      <img className="top-menu-bar__icon" src={appIconUrl} alt="" />
      {menus.map((menu) => (
        <div key={menu.id} className="top-menu-bar__menu">
          <button
            type="button"
            className={`top-menu-bar__label ${openMenu === menu.id ? 'is-open' : ''}`}
            onClick={() => setOpenMenu((v) => (v === menu.id ? null : menu.id))}
            // Native menu bars switch which menu is open just by hovering,
            // but only once one is already open - moving the mouse across
            // the bar with nothing open shouldn't pop a menu open on its
            // own, so this only fires the switch when openMenu is already
            // set to something else.
            onMouseEnter={() => {
              if (openMenu !== null && openMenu !== menu.id) setOpenMenu(menu.id)
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.id && (
            <div className="top-menu-bar__dropdown">
              {menu.entries.map((entry, i) =>
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
      ))}
      {/* On Windows there's no native title bar left at all (titleBarStyle
          'hidden' in main/index.ts) - this is the only place a window
          title shows up now. Static text, not the open file's path (that
          already has its own row further down) - just enough to still
          read as "a title bar" at a glance. */}
      <span className="top-menu-bar__title">subito sfz</span>
    </div>
  )
}
