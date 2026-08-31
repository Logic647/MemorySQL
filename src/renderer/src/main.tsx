import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SpotlightView from './SpotlightView'
import './styles.css'

// the spotlight window reuses this bundle with ?spotlight=1
const isSpotlight = new URLSearchParams(window.location.search).has('spotlight')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isSpotlight ? <SpotlightView /> : <App />}</React.StrictMode>
)
