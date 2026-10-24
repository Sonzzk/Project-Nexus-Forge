import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installErrorReporting } from './lib/report-errors';
import './design/tokens.css';
import './design/base.css';
import './app/shell.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root element.');

installErrorReporting(window.api);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
