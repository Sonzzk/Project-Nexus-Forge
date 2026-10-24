import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installErrorReporting } from './lib/report-errors';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

installErrorReporting(window.api);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
