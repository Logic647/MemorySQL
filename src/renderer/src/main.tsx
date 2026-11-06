import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import SpotlightView from './SpotlightView'
import { initThemeBridge } from './theme'
import './styles.css'

// the spotlight window reuses this bundle with ?spotlight=1

const isSpotlight = new URLSearchParams(window.location.search).has('spotlight')

// 主题必须在 render 之前落定:否则浅色用户会先看到一帧深色背景
initThemeBridge()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{isSpotlight ? <SpotlightView /> : <App />}</React.StrictMode>
)
