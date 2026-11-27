import React from 'react'
import ReactDOM from 'react-dom/client'
import './global.css'
import App from './App'
import OpcodeReferenceWindow from './components/OpcodeReferenceWindow'

// Every window loads this same bundle (see main/index.ts's createWindow and
// createOpcodesWindow) - a URL hash is the only thing distinguishing "the
// opcode reference window" from an ordinary instrument-editing window,
// since there's no separate HTML entry point for it.
const isOpcodeReferenceWindow = window.location.hash === '#/opcodes'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isOpcodeReferenceWindow ? <OpcodeReferenceWindow /> : <App />}</React.StrictMode>
)
