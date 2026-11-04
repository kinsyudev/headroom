import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ClockProvider } from './deck';

createRoot(document.getElementById('root')!).render(
  <ClockProvider>
    <App />
  </ClockProvider>,
);
