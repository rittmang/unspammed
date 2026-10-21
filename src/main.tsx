import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { initializeMiniApp } from './mini-app';
import { AuthGate } from './SignIn';

initializeMiniApp();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
