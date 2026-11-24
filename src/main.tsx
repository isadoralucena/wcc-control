import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ToastProvider } from './components/Toasts';
import { ConfirmProvider } from './components/Confirm';
import { StoreProvider } from './state/store';
import { SyncProvider } from './services/sync';
import './styles/base.css';
import './styles/shell.css';
import './styles/screens.css';
import './styles/panel.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <ConfirmProvider>
        <StoreProvider>
          <SyncProvider>
            <App />
          </SyncProvider>
        </StoreProvider>
      </ConfirmProvider>
    </ToastProvider>
  </StrictMode>,
);
