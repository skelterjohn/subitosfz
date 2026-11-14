import './ImportSf2Modal.css'
import './AboutModal.css'

interface Props {
  onClose: () => void
}

// Placeholder copy - the user plans to edit this text directly.
export default function AboutModal({ onClose }: Props): React.JSX.Element {
  return (
    <div className="import-modal__backdrop" onClick={onClose}>
      <div className="import-modal is-compact" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal__header">
          <h2>about subito sfz</h2>
          <button type="button" className="import-modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="import-modal__body about-modal__body">
          <p>Subito sfz is a low-friction tool for building SFZ instruments from your own recordings.</p>
          <p className="about-modal__version">Version 0.1.0</p>
        </div>
      </div>
    </div>
  )
}
