import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import { ToastProvider } from './components/Toast';
import Overview from './pages/Overview';
import Clients from './pages/Clients';
import ClientDetail from './pages/ClientDetail';
import Campaigns from './pages/Campaigns';
import Calendar from './pages/Calendar';
import WhatsApp from './pages/WhatsApp';
import Contacts from './pages/Contacts';
import Reels from './pages/Reels';
import Voice from './pages/Voice';
import { api, AuthError, clearToken, setToken, getToken } from './lib/api';

function Login({ onDone }) {
  const [token, setTok] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setToken(token.trim());
    try {
      await api('/api/auth/check');
      onDone();
    } catch (err) {
      clearToken();
      setError(err instanceof AuthError ? 'Incorrect access token' : err.message);
    }
  }
  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-7">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-2xl font-bold text-white">∞</div>
        <h1 className="mt-4 text-center text-xl">Infinity Sales Dashboard</h1>
        <p className="mt-1 text-center text-sm">Enter your admin access token</p>
        <input type="password" autoFocus className="input mt-6" placeholder="ADMIN_TOKEN" value={token} onChange={(e) => setTok(e.target.value)} aria-label="Admin token" />
        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        <button className="btn-primary mt-4 w-full">Sign in</button>
      </form>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState('checking');

  useEffect(() => {
    api('/api/auth/check')
      .then(() => setAuth('ok'))
      .catch((err) => setAuth(err instanceof AuthError ? 'login' : 'ok')); // network errors surface on pages
  }, []);

  if (auth === 'checking') return <div className="grid min-h-screen place-items-center text-sm">Loading…</div>;
  if (auth === 'login') return <Login onDone={() => setAuth('ok')} />;

  return (
    <ToastProvider>
      <Sidebar onLogout={getToken() ? () => { clearToken(); setAuth('login'); } : null} />
      <main className="min-h-screen px-4 py-6 sm:px-6 lg:ml-60 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-7xl">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/clients/:id" element={<ClientDetail />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/calendar" element={<Calendar />} />
            <Route path="/whatsapp" element={<WhatsApp />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/reels" element={<Reels />} />
            <Route path="/voice" element={<Voice />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </ToastProvider>
  );
}
