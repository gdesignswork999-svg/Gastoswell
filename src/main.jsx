import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import gastoswellLogo from '../LOGO/GWLOGO.png';
import providerLogo from '../LOGO/GDEV.LOGO.jpg';
import './styles.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EXPENSE_CATEGORIES = ['Food & Dining', 'Bills & Utilities', 'Debt Payment', 'Savings Deposit', 'Transportation & Fuel', 'Business & Equipment', 'Personal & Health', 'Subscriptions & Software', 'Other Expense'];
const INCOME_CATEGORIES = ['Salary / Regular Pay', 'Client & Freelance Work', 'Business Sales', 'Side Hustle / Bonus', 'Other Income'];
const APPEARANCE_VERSION = 2;
const ACCOUNT_STORE_KEY = 'gastoswell_local_accounts_v1';
const LEGACY_DATA_KEY = 'gastoswell_app_v1';
const ACCOUNT_KEY_ITERATIONS = 310000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const NAV_ITEMS = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'transactions', label: 'Transactions', icon: 'arrows' },
  { id: 'accounts', label: 'Banks & wallets', icon: 'card' },
  { id: 'bills', label: 'Bills', icon: 'receipt' },
  { id: 'debts', label: 'Debts', icon: 'card' },
  { id: 'goals', label: 'Savings goals', icon: 'target' }
];

const emptyState = () => ({
  selectedMonth: new Date().getMonth(),
  selectedYear: new Date().getFullYear(),
  selectedDay: 'all',
  allTime: false,
  customStartDate: '',
  customEndDate: '',
  analyticsMode: 'monthly',
  theme: 'light',
  appearanceVersion: APPEARANCE_VERSION,
  transactions: [],
  accounts: [],
  bills: [],
  debts: [],
  goals: []
});

const formatMoney = (value) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}).format(Number(value) || 0);

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

function validateWorkspace(value) {
  if (!value || typeof value !== 'object' ||
    !Array.isArray(value.transactions) || !Array.isArray(value.accounts) ||
    !Array.isArray(value.bills) || !Array.isArray(value.debts) || !Array.isArray(value.goals)) {
    throw new Error('Saved finance data is incomplete.');
  }
  const restored = { ...emptyState(), ...value };
  if (value.appearanceVersion !== APPEARANCE_VERSION) restored.theme = 'light';
  return restored;
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveProfileKeys(password, salt) {
  const material = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt,
    iterations: ACCOUNT_KEY_ITERATIONS,
    hash: 'SHA-256'
  }, material, 512));
  const encryptionKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const verifierKey = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { encryptionKey, verifierKey };
}

async function profileVerifier(key) {
  const signature = await crypto.subtle.sign('HMAC', key.verifierKey, textEncoder.encode('gastoswell-local-account-v1'));
  return bytesToBase64(new Uint8Array(signature));
}

async function encryptWorkspace(workspace, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.encryptionKey, textEncoder.encode(JSON.stringify(workspace)));
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptWorkspace(payload, key) {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key.encryptionKey,
    base64ToBytes(payload.ciphertext)
  );
  return validateWorkspace(JSON.parse(textDecoder.decode(decrypted)));
}

function readLocalProfiles() {
  const stored = localStorage.getItem(ACCOUNT_STORE_KEY);
  if (!stored) return [];
  const profiles = JSON.parse(stored);
  if (!Array.isArray(profiles) || profiles.some((profile) => !profile.id || !profile.username || !profile.salt || !profile.verifier || !profile.payload?.iv || !profile.payload?.ciphertext)) {
    throw new Error('The saved local account list is invalid.');
  }
  return profiles;
}

async function persistProfileData(profile, workspace) {
  const profiles = readLocalProfiles();
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index < 0) throw new Error('This local account no longer exists on this device.');
  profiles[index] = { ...profiles[index], payload: await encryptWorkspace(workspace, profile.key) };
  localStorage.setItem(ACCOUNT_STORE_KEY, JSON.stringify(profiles));
}

function billPaymentDate(bill, monthKey, year, month) {
  const day = Math.min(Number(bill.dueDay), daysInMonth(year, month));
  return `${monthKey}-${String(day).padStart(2, '0')}`;
}

function isBillPaymentTransaction(transaction, bill, monthKey, paymentDate) {
  const legacyPaymentDate = `${monthKey}-${String(Math.min(28, Number(bill.dueDay))).padStart(2, '0')}`;
  return (transaction.billId === bill.id && transaction.billMonth === monthKey) ||
    (transaction.type === 'expense' &&
      (transaction.date === paymentDate || transaction.date === legacyPaymentDate) &&
      transaction.category === bill.category &&
      Number(transaction.amount) === Number(bill.amount) &&
      transaction.note === `Paid bill: ${bill.name}`);
}

function updateAccountBalance(accounts, accountId, amount) {
  if (!accountId) return accounts;
  return accounts.map((account) => account.id === accountId
    ? { ...account, balance: Number(account.balance || 0) + amount }
    : account);
}

function applyTransactionToAccounts(accounts, transaction, reverse = false) {
  if (!transaction?.accountId) return accounts;
  const direction = transaction.type === 'income' ? 1 : -1;
  return updateAccountBalance(accounts, transaction.accountId, direction * Number(transaction.amount) * (reverse ? -1 : 1));
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getPeriodWindow(range, year, month, day, customStartDate, customEndDate) {
  const anchor = new Date(year, month, day);
  if (range === 'daily') return { start: anchor, end: anchor };
  if (range === 'weekly') {
    const start = new Date(anchor);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start, end };
  }
  if (range === 'custom') {
    if (!customStartDate || !customEndDate || customStartDate > customEndDate) return null;
    const start = new Date(`${customStartDate}T00:00:00`);
    const end = new Date(`${customEndDate}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return {
      start,
      end
    };
  }
  if (range === 'monthly') return { start: new Date(year, month, 1), end: new Date(year, month + 1, 0) };
  if (range === 'quarterly') {
    const quarterStart = Math.floor(month / 3) * 3;
    return { start: new Date(year, quarterStart, 1), end: new Date(year, quarterStart + 3, 0) };
  }
  if (range === 'half-year') {
    const halfStart = Math.floor(month / 6) * 6;
    return { start: new Date(year, halfStart, 1), end: new Date(year, halfStart + 6, 0) };
  }
  return { start: new Date(year, 0, 1), end: new Date(year, 11, 31) };
}

function periodLabelFor(range, window, year, month) {
  if (range === 'all-time') return 'All time';
  if (range === 'custom' && !window) return 'Choose dates';
  if (range === 'monthly') return `${MONTHS[month]} ${year}`;
  if (range === 'quarterly') return `Q${Math.floor(month / 3) + 1} ${year}`;
  if (range === 'half-year') return `H${Math.floor(month / 6) + 1} ${year}`;
  if (range === 'yearly') return String(year);
  const shortDate = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric' });
  if (range === 'daily') return new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }).format(window.start);
  const endLabel = window.start.getFullYear() === window.end.getFullYear()
    ? `${shortDate.format(window.start)} – ${shortDate.format(window.end)}, ${window.end.getFullYear()}`
    : `${new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }).format(window.start)} – ${new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }).format(window.end)}`;
  return endLabel;
}

function Icon({ name, size = 20 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /></>,
    arrows: <><path d="M7 7h13l-3-3" /><path d="M17 17H4l3 3" /><path d="M20 7v5" /><path d="M4 17v-5" /></>,
    receipt: <><path d="M4 3h16v18l-3-2-3 2-3-2-3 2-4-2z" /><path d="M8 8h8M8 12h8" /></>,
    card: <><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M3 10h18M7 15h3" /></>,
    target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" /></>,
    moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    trend: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="3" /><path d="M3 9h18m-5 5h.01" /><path d="M6 5V3h12v2" /></>,
    logout: <><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></>,
    sparkles: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z" /></>
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.sparkles}</svg>;
}

function LocalAccountGate() {
  const [profiles, setProfiles] = useState(null);
  const [mode, setMode] = useState('login');
  const [activeProfile, setActiveProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accountStoreFailed, setAccountStoreFailed] = useState(false);

  useEffect(() => {
    try {
      const localProfiles = readLocalProfiles();
      setProfiles(localProfiles);
      setMode(localProfiles.length ? 'login' : 'create');
    } catch (loadError) {
      setProfiles([]);
      setError(`Could not read local accounts. ${loadError.message}`);
      setAccountStoreFailed(true);
    }
  }, []);

  async function submitAccount(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const username = String(values.username || '').trim();
    const password = String(values.password || '');
    try {
      if (!crypto?.subtle) throw new Error('Secure local account storage is unavailable in this browser.');
      if (!/^[a-zA-Z0-9._-]{3,24}$/.test(username)) throw new Error('Use 3–24 letters, numbers, dots, underscores, or hyphens for the login name.');
      const currentProfiles = readLocalProfiles();
      setProfiles(currentProfiles);
      if (mode === 'create') {
        if (password.length < 8) throw new Error('Use a password with at least 8 characters.');
        if (password !== values.confirmPassword) throw new Error('The passwords do not match.');
        if (currentProfiles.some((profile) => profile.username.toLowerCase() === username.toLowerCase())) {
          throw new Error('That login name already exists on this device.');
        }

        const legacyData = currentProfiles.length === 0 ? localStorage.getItem(LEGACY_DATA_KEY) : null;
        const workspace = legacyData ? validateWorkspace(JSON.parse(legacyData)) : emptyState();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveProfileKeys(password, salt);
        const profile = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
          username,
          salt: bytesToBase64(salt),
          verifier: await profileVerifier(key),
          payload: await encryptWorkspace(workspace, key)
        };
        const nextProfiles = [...currentProfiles, profile];
        localStorage.setItem(ACCOUNT_STORE_KEY, JSON.stringify(nextProfiles));
        let migrationWarning = '';
        if (legacyData) {
          try {
            localStorage.removeItem(LEGACY_DATA_KEY);
          } catch (storageError) {
            migrationWarning = `Your account was created, but the old unencrypted workspace could not be removed. ${storageError.message}`;
          }
        }
        setProfiles(nextProfiles);
        setActiveProfile({ id: profile.id, username: profile.username, key, workspace, warning: migrationWarning });
      } else {
        const profile = currentProfiles.find((item) => item.username.toLowerCase() === username.toLowerCase());
        if (!profile) throw new Error('Invalid login name or password.');
        const key = await deriveProfileKeys(password, base64ToBytes(profile.salt));
        if (await profileVerifier(key) !== profile.verifier) throw new Error('Invalid login name or password.');
        const workspace = await decryptWorkspace(profile.payload, key);
        setActiveProfile({ id: profile.id, username: profile.username, key, workspace });
      }
    } catch (accountError) {
      setError(accountError.message || 'Could not open this local account.');
    } finally {
      setBusy(false);
    }
  }

  if (activeProfile) {
    return <App profile={activeProfile} onLogout={() => {
      setActiveProfile(null);
      setMode('login');
      setError('');
    }} />;
  }
  if (profiles === null) {
    return <div className="loading-screen"><img className="brand-mark" src={gastoswellLogo} alt="Gastoswell" /><span>Opening your local accounts…</span></div>;
  }

  return <div className="landing-page">
    <header className="landing-header">
      <a className="landing-brand" href="#" onClick={(event) => event.preventDefault()}>
        <img src={gastoswellLogo} alt="" />
        <span>gastoswell<span>.</span><small>MONEY, IN BALANCE</small></span>
      </a>
      <span className="landing-offline"><i />OFFLINE · NO EMAIL REQUIRED</span>
    </header>
    <main className="landing-content">
      <section className="landing-intro">
        <p className="eyebrow">A CALMER WAY TO MANAGE MONEY</p>
        <h1>Your money,<br /><span>in balance.</span></h1>
        <p className="landing-description">See where your money goes, stay ahead of bills, and make progress toward your goals — all in one private workspace.</p>
        <div className="landing-highlights">
          <div><i><Icon name="arrows" size={17} /></i><span><strong>Understand your spending</strong><small>Smart analytics that follow your records.</small></span></div>
          <div><i><Icon name="wallet" size={17} /></i><span><strong>Keep your accounts together</strong><small>Track banks, cards, and e-wallets.</small></span></div>
          <div><i><Icon name="sparkles" size={17} /></i><span><strong>Built for your device</strong><small>Install once, then reopen it offline.</small></span></div>
        </div>
      </section>
      <section className="local-auth-card" aria-labelledby="local-auth-title">
        <div className="local-auth-heading">
          <p className="eyebrow">{mode === 'create' ? 'GET STARTED' : 'WELCOME BACK'}</p>
          <h2 id="local-auth-title">{mode === 'create' ? 'Create your account' : 'Open your workspace'}</h2>
          <p>{mode === 'create' ? 'Choose a login name and password. No email needed.' : 'Sign in with the local account on this device.'}</p>
        </div>
        <form className="local-auth-form" onSubmit={submitAccount}>
          <label className="form-field"><span>Login name</span><input name="username" type="text" autoComplete="username" minLength="3" maxLength="24" placeholder="e.g. GDEV" required disabled={busy} /></label>
          <label className="form-field"><span>Password</span><input name="password" type="password" autoComplete={mode === 'create' ? 'new-password' : 'current-password'} minLength={mode === 'create' ? 8 : undefined} placeholder={mode === 'create' ? 'At least 8 characters' : 'Enter your password'} required disabled={busy} /></label>
          {mode === 'create' && <label className="form-field"><span>Confirm password</span><input name="confirmPassword" type="password" autoComplete="new-password" minLength="8" placeholder="Re-enter your password" required disabled={busy} /></label>}
          {error && <p className="local-auth-error" role="alert">{error}</p>}
          <button type="submit" className="button button-primary local-auth-submit" disabled={busy || accountStoreFailed}>{busy ? 'Please wait…' : mode === 'create' ? 'Create account & open' : 'Open workspace'}</button>
        </form>
        <button type="button" className="local-auth-switch" onClick={() => { setError(''); setMode(mode === 'create' ? 'login' : 'create'); }} disabled={busy || accountStoreFailed}>
          {mode === 'create' ? 'Already have a local account? Sign in' : 'New here? Create an account'}
        </button>
        <p className="local-auth-note">Open Gastoswell once while connected so the app files can cache, then use your browser’s Install app / Add to Home Screen option. Your data is encrypted and saved only on this device; there is no password recovery, so keep a backup.</p>
      </section>
    </main>
    <footer className="landing-footer">
      <span>Made for a little more peace of mind.</span>
      <span className="landing-provider"><img src={providerLogo} alt="G_DEV_SOLUTIONS logo" /><span><strong>G_DEV_SOLUTIONS</strong><small>Since 2026 · We build systems that move businesses.</small></span></span>
    </footer>
  </div>;
}

function App({ profile, onLogout }) {
  const [data, setData] = useState(profile.workspace);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [storageReady, setStorageReady] = useState(false);
  const [activePage, setActivePage] = useState('overview');
  const [modal, setModal] = useState(null);
  const [billConfirmation, setBillConfirmation] = useState(null);
  const [actionTarget, setActionTarget] = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [migrationWarningDismissed, setMigrationWarningDismissed] = useState(false);
  const saveQueue = useRef(Promise.resolve());
  const saveVersion = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = data.theme;
  }, [data.theme]);

  useEffect(() => {
    if (!storageReady) return undefined;
    const version = ++saveVersion.current;
    const snapshot = data;
    setSaveStatus('saving');
    const save = saveQueue.current.catch(() => undefined).then(() => persistProfileData(profile, snapshot));
    saveQueue.current = save;
    save.then(() => {
      if (saveVersion.current === version) {
        setSaveStatus('saved');
        setError('');
      }
    }).catch((saveError) => {
      if (saveVersion.current === version) {
        setSaveStatus('offline');
        setError(`Could not encrypt and save data on this device. ${saveError.message}`);
      }
    });
    return undefined;
  }, [data, profile, storageReady]);

  useEffect(() => {
    setStorageReady(true);
  }, []);

  async function lockWorkspace() {
    try {
      await saveQueue.current;
      onLogout();
    } catch (saveError) {
      setSaveStatus('offline');
      setError(`Could not encrypt and save data on this device. ${saveError.message}`);
    }
  }

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2800);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setModal(null);
        setBillConfirmation(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const monthKey = `${data.selectedYear}-${String(data.selectedMonth + 1).padStart(2, '0')}`;
  const range = data.allTime ? 'all-time' : data.analyticsMode || 'monthly';
  const selectedDay = data.selectedDay && data.selectedDay !== 'all'
    ? Math.max(1, Math.min(Number(data.selectedDay), daysInMonth(data.selectedYear, data.selectedMonth)))
    : Math.min(new Date().getDate(), daysInMonth(data.selectedYear, data.selectedMonth));
  const periodWindow = range === 'all-time'
    ? null
    : getPeriodWindow(range, data.selectedYear, data.selectedMonth, selectedDay, data.customStartDate, data.customEndDate);
  const periodStartKey = periodWindow ? dateKey(periodWindow.start) : '';
  const periodEndKey = periodWindow ? dateKey(periodWindow.end) : '';
  const periodTransactions = useMemo(() => data.transactions.filter((item) => item.date && (
    range === 'all-time' || (periodStartKey && periodEndKey && item.date >= periodStartKey && item.date <= periodEndKey)
  )), [data.transactions, range, periodStartKey, periodEndKey]);
  const previousPeriodKeys = useMemo(() => {
    if (range === 'all-time' || !periodWindow) return null;
    const durationDays = Math.round((periodWindow.end - periodWindow.start) / 86400000) + 1;
    const end = new Date(periodWindow.start);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - durationDays + 1);
    return { start: dateKey(start), end: dateKey(end) };
  }, [range, periodWindow]);
  const previousPeriodTransactions = useMemo(() => previousPeriodKeys
    ? data.transactions.filter((item) => item.date && item.date >= previousPeriodKeys.start && item.date <= previousPeriodKeys.end)
    : [], [data.transactions, previousPeriodKeys]);
  const spendingAnalytics = useMemo(() => {
    const categoryTotals = new Map();
    const previousCategoryTotals = new Map();
    const expenses = periodTransactions.filter((item) => item.type === 'expense');
    const previousExpenses = previousPeriodTransactions.filter((item) => item.type === 'expense');
    expenses.forEach((item) => {
      const category = item.category || 'Uncategorized';
      categoryTotals.set(category, (categoryTotals.get(category) || 0) + Number(item.amount));
    });
    previousExpenses.forEach((item) => {
      const category = item.category || 'Uncategorized';
      previousCategoryTotals.set(category, (previousCategoryTotals.get(category) || 0) + Number(item.amount));
    });
    const categories = [...categoryTotals.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
    const total = expenses.reduce((sum, item) => sum + Number(item.amount), 0);
    const largestExpense = [...expenses].sort((a, b) => Number(b.amount) - Number(a.amount))[0] || null;
    const topCategory = categories[0] || null;
    return {
      categories: categories.slice(0, 5),
      total,
      count: expenses.length,
      average: expenses.length ? total / expenses.length : 0,
      largestExpense,
      topCategory,
      topCategoryShare: topCategory && total ? Math.round(topCategory.amount / total * 100) : 0,
      previousTopCategoryAmount: topCategory ? previousCategoryTotals.get(topCategory.category) || 0 : 0,
      previousTotal: previousExpenses.reduce((sum, item) => sum + Number(item.amount), 0)
    };
  }, [periodTransactions, previousPeriodTransactions]);
  const totals = useMemo(() => {
    const income = periodTransactions.filter((item) => item.type === 'income').reduce((sum, item) => sum + Number(item.amount), 0);
    const expenses = periodTransactions.filter((item) => item.type === 'expense').reduce((sum, item) => sum + Number(item.amount), 0);
    const savings = data.goals.reduce((sum, goal) => sum + Number(goal.current), 0);
    const debt = data.debts.reduce((sum, item) => sum + Number(item.remaining), 0);
    const surplus = income - expenses;
    const paidBills = data.bills.filter((bill) => (bill.paidMonths || []).includes(monthKey)).length;
    return { income, expenses, savings, debt, surplus, paidBills, savingsRate: income ? Math.max(0, Math.round((surplus / income) * 100)) : 0 };
  }, [periodTransactions, data.goals, data.debts, data.bills, monthKey]);
  const filteredTransactions = useMemo(() => periodTransactions
    .filter((item) => typeFilter === 'all' || item.type === typeFilter)
    .filter((item) => `${item.note} ${item.category}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.time || '').localeCompare(a.time || '')), [periodTransactions, typeFilter, search]);

  const notify = (message) => setToast(message);
  const patch = (update) => setData((current) => ({ ...current, ...update }));
  const makeId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const monthLabel = `${MONTHS[data.selectedMonth]} ${data.selectedYear}`;
  const periodLabel = periodLabelFor(range, periodWindow, data.selectedYear, data.selectedMonth);
  const changePeriod = (direction) => {
    if (range === 'all-time' || range === 'custom') return;
    const anchor = new Date(data.selectedYear, data.selectedMonth, selectedDay);
    if (range === 'daily') anchor.setDate(anchor.getDate() + direction);
    else if (range === 'weekly') anchor.setDate(anchor.getDate() + direction * 7);
    else {
      const monthStep = { monthly: 1, quarterly: 3, 'half-year': 6, yearly: 12 }[range] || 1;
      const targetMonth = new Date(anchor.getFullYear(), anchor.getMonth() + direction * monthStep, 1);
      anchor.setFullYear(targetMonth.getFullYear(), targetMonth.getMonth(), Math.min(anchor.getDate(), daysInMonth(targetMonth.getFullYear(), targetMonth.getMonth())));
    }
    patch({
      selectedYear: anchor.getFullYear(),
      selectedMonth: anchor.getMonth(),
      selectedDay: String(anchor.getDate()),
      allTime: false
    });
  };

  function submitForm(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries());
    const amount = Number(values.amount);
    if (modal === 'transaction') {
      const account = data.accounts.find((item) => item.id === values.accountId);
      const transaction = {
        id: makeId(),
        type: values.type,
        amount,
        category: values.category,
        date: values.date,
        time: values.time,
        note: values.note.trim(),
        ...(account ? { accountId: account.id, accountName: account.name } : {})
      };
      patch({
        transactions: [...data.transactions, transaction],
        accounts: applyTransactionToAccounts(data.accounts, transaction),
        selectedYear: Number(values.date.slice(0, 4)),
        selectedMonth: Number(values.date.slice(5, 7)) - 1,
        selectedDay: String(Number(values.date.slice(8, 10)))
      });
      notify('Transaction added');
    } else if (modal === 'account') {
      patch({ accounts: [...data.accounts, { id: makeId(), name: values.name.trim(), type: values.accountType, balance: Number(values.balance) }] });
      notify('Account added');
    } else if (modal === 'account-balance' && actionTarget) {
      patch({
        accounts: data.accounts.map((item) => item.id === actionTarget.id ? { ...item, balance: Number(values.balance) } : item)
      });
      notify('Account balance updated');
    } else if (modal === 'bill') {
      patch({ bills: [...data.bills, { id: makeId(), name: values.name.trim(), amount, dueDay: Number(values.dueDay), category: values.category, paidMonths: [] }] });
      notify('Recurring bill added');
    } else if (modal === 'debt') {
      const total = Number(values.total);
      const remaining = Number(values.remaining);
      patch({ debts: [...data.debts, { id: makeId(), name: values.name.trim(), total: Math.max(total, remaining), remaining, interest: Number(values.interest), minPay: Number(values.minPay) }] });
      notify('Debt added to your tracker');
    } else if (modal === 'goal') {
      patch({ goals: [...data.goals, { id: makeId(), name: values.name.trim(), target: Number(values.target), current: Number(values.current), monthlyTarget: Number(values.monthlyTarget) }] });
      notify('Savings goal created');
    } else if (modal === 'contribute' && actionTarget) {
      if (actionTarget.type === 'debt') {
        const debt = data.debts.find((item) => item.id === actionTarget.id);
        const account = data.accounts.find((item) => item.id === values.accountId);
        const transaction = { id: makeId(), type: 'expense', amount, category: 'Debt Payment', date: `${monthKey}-15`, note: `Debt payment: ${debt.name}`, ...(account ? { accountId: account.id, accountName: account.name } : {}) };
        patch({
          debts: data.debts.map((item) => item.id === actionTarget.id ? { ...item, remaining: Math.max(0, Number(item.remaining) - amount) } : item),
          transactions: values.record === 'yes' ? [...data.transactions, transaction] : data.transactions,
          accounts: values.record === 'yes' ? applyTransactionToAccounts(data.accounts, transaction) : data.accounts
        });
        notify('Debt payment recorded');
      } else {
        const goal = data.goals.find((item) => item.id === actionTarget.id);
        const account = data.accounts.find((item) => item.id === values.accountId);
        const transaction = { id: makeId(), type: 'expense', amount, category: 'Savings Deposit', date: `${monthKey}-15`, note: `Saved to: ${goal.name}`, ...(account ? { accountId: account.id, accountName: account.name } : {}) };
        patch({
          goals: data.goals.map((item) => item.id === actionTarget.id ? { ...item, current: Number(item.current) + amount } : item),
          transactions: values.record === 'yes' ? [...data.transactions, transaction] : data.transactions,
          accounts: values.record === 'yes' ? applyTransactionToAccounts(data.accounts, transaction) : data.accounts
        });
        notify('Savings deposit recorded');
      }
    }
    setModal(null);
    setActionTarget(null);
  }

  function toggleBill(bill) {
    const paidMonths = bill.paidMonths || [];
    const isPaid = paidMonths.includes(monthKey);
    if (!isPaid) {
      setBillConfirmation(bill);
      return;
    }

    const paymentDate = billPaymentDate(bill, monthKey, data.selectedYear, data.selectedMonth);
    const removedTransactions = data.transactions.filter((item) => isBillPaymentTransaction(item, bill, monthKey, paymentDate));
    patch({
      bills: data.bills.map((item) => item.id === bill.id ? { ...item, paidMonths: paidMonths.filter((key) => key !== monthKey) } : item),
      transactions: data.transactions.filter((item) => !removedTransactions.includes(item)),
      accounts: removedTransactions.reduce((accounts, item) => applyTransactionToAccounts(accounts, item, true), data.accounts)
    });
    notify('Bill marked unpaid and removed from analytics');
  }

  function confirmBillPaid(accountId) {
    if (!billConfirmation) return;
    const bill = data.bills.find((item) => item.id === billConfirmation.id);
    if (!bill) {
      setBillConfirmation(null);
      return;
    }

    const paidMonths = bill.paidMonths || [];
    if (paidMonths.includes(monthKey)) {
      setBillConfirmation(null);
      return;
    }

    const paymentDate = billPaymentDate(bill, monthKey, data.selectedYear, data.selectedMonth);
    const recordedPayment = data.transactions.find((item) => isBillPaymentTransaction(item, bill, monthKey, paymentDate));
    const alreadyRecorded = Boolean(recordedPayment);
    const account = data.accounts.find((item) => item.id === accountId);
    const payment = {
      id: makeId(),
      type: 'expense',
      amount: Number(bill.amount),
      category: bill.category,
      date: paymentDate,
      time: new Date().toTimeString().slice(0, 5),
      billId: bill.id,
      billMonth: monthKey,
      note: `Paid bill: ${bill.name}`,
      ...(account ? { accountId: account.id, accountName: account.name } : {})
    };
    const nextTransactions = alreadyRecorded
      ? recordedPayment && !recordedPayment.accountId && account
        ? data.transactions.map((item) => item.id === recordedPayment.id ? { ...item, accountId: account.id, accountName: account.name } : item)
        : data.transactions
      : [...data.transactions, payment];
    const nextAccounts = !alreadyRecorded
      ? applyTransactionToAccounts(data.accounts, payment)
      : recordedPayment && !recordedPayment.accountId && account
        ? applyTransactionToAccounts(data.accounts, { ...recordedPayment, accountId: account.id })
        : data.accounts;

    patch({
      bills: data.bills.map((item) => item.id === bill.id ? { ...item, paidMonths: [...paidMonths, monthKey] } : item),
      transactions: nextTransactions,
      accounts: nextAccounts
    });
    setBillConfirmation(null);
    notify(alreadyRecorded ? 'Bill marked paid; its expense is already in analytics' : 'Bill marked paid and added to analytics');
  }

  function deleteItem(collection, id) {
    const item = data[collection].find((entry) => entry.id === id);
    const message = collection === 'accounts'
      ? `Remove ${item?.name || 'this account'}? Its transaction history will stay, but future payments will no longer update its balance.`
      : 'Remove this item? This cannot be undone.';
    if (!window.confirm(message)) return;
    if (collection === 'transactions') {
      patch({
        transactions: data.transactions.filter((entry) => entry.id !== id),
        accounts: applyTransactionToAccounts(data.accounts, item, true)
      });
    } else {
      patch({ [collection]: data[collection].filter((entry) => entry.id !== id) });
    }
    notify('Item removed');
  }

  async function resetData() {
    if (!window.confirm('Clear all transactions, accounts, bills, debts and savings goals?')) return;
    const clean = { ...emptyState(), theme: data.theme };
    patch(clean);
    notify('Your workspace is clear');
  }

  function exportFile(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function exportBackup() {
    exportFile(JSON.stringify(data, null, 2), `Gastoswell-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    notify('Backup downloaded');
  }

  function exportTransactionsCsv() {
    const rows = [['Date', 'Time', 'Type', 'Category', 'Description', 'Account', 'Amount (PHP)'], ...data.transactions.map((item) => [
      item.date,
      item.time || '',
      item.type,
      item.category,
      item.note,
      item.accountName || '',
      Number(item.amount).toFixed(2)
    ])];
    const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    exportFile(csv, `Gastoswell-transactions-${data.selectedYear}.csv`, 'text/csv;charset=utf-8');
    notify('Transactions exported');
  }

  function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const backup = JSON.parse(reader.result);
        if (!Array.isArray(backup.transactions) || (backup.accounts !== undefined && !Array.isArray(backup.accounts)) || !Array.isArray(backup.bills) || !Array.isArray(backup.debts) || !Array.isArray(backup.goals)) throw new Error('That file is not a valid Gastoswell backup.');
        const restored = { ...emptyState(), ...backup };
        if (backup.appearanceVersion !== APPEARANCE_VERSION) restored.theme = 'light';
        patch(restored);
        notify('Backup restored');
      } catch (backupError) {
        setError(backupError.message);
      } finally {
        event.target.value = '';
      }
    };
    reader.onerror = () => setError('The selected backup could not be read.');
    reader.readAsText(file);
  }

  const allPages = activePage === 'overview';
  const activeNav = (id) => setActivePage(id);
  const showTransactions = allPages || activePage === 'transactions';
  const showAccounts = allPages || activePage === 'accounts';
  const showBills = allPages || activePage === 'bills';
  const showDebts = allPages || activePage === 'debts';
  const showGoals = allPages || activePage === 'goals';
  const topDebt = [...data.debts].filter((debt) => debt.remaining > 0).sort((a, b) => b.interest - a.interest)[0];
  const unpaidCount = data.bills.length - totals.paidBills;
  const coachText = totals.surplus < 0
    ? `Spending is ${formatMoney(Math.abs(totals.surplus))} above income for ${periodLabel}. Review these transactions and prioritize essentials.`
    : unpaidCount > 0
      ? `There ${unpaidCount === 1 ? 'is' : 'are'} ${unpaidCount} bill${unpaidCount === 1 ? '' : 's'} left this month. Clear those first, then put extra cash toward ${topDebt ? topDebt.name : 'your savings goals'}.`
      : `You have ${formatMoney(totals.surplus)} left after expenses for ${periodLabel}. Keep building your savings${topDebt ? ` or pay down ${topDebt.name}` : ''}.`;
  const spendingTrend = !spendingAnalytics.topCategory
    ? 'Add an expense to start seeing how your spending changes over time.'
    : range === 'all-time'
    ? 'Choose a shorter date range to compare spending with the previous period.'
    : spendingAnalytics.previousTotal === 0
      ? 'No expenses were recorded in the previous comparable period.'
      : spendingAnalytics.previousTopCategoryAmount === 0
        ? `${spendingAnalytics.topCategory.category} is a new top spending category this period.`
        : (() => {
          const difference = spendingAnalytics.topCategory.amount - spendingAnalytics.previousTopCategoryAmount;
          const percent = Math.round(Math.abs(difference) / spendingAnalytics.previousTopCategoryAmount * 100);
          return difference === 0
            ? `${spendingAnalytics.topCategory.category} spending is unchanged from the previous period.`
            : `${spendingAnalytics.topCategory.category} spending is ${difference > 0 ? 'up' : 'down'} ${formatMoney(Math.abs(difference))} (${percent}%) vs. the previous period.`;
        })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); activeNav('overview'); }}>
          <img className="brand-mark" src={gastoswellLogo} alt="" />
          <span className="brand-name">gastoswell<span>.</span><small>MONEY, IN BALANCE</small></span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => <NavButton key={item.id} item={item} active={activePage === item.id} onClick={() => activeNav(item.id)} />)}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="tip-icon"><Icon name="sparkles" size={17} /></span>
            <strong>Small steps add up.</strong>
            <p>A little progress today is still progress.</p>
          </div>
          <button className="profile-button" onClick={exportBackup}><span className="avatar">{profile.username.slice(0, 1).toUpperCase()}</span><span><strong>{profile.username}</strong><small>Encrypted local account</small></span><Icon name="download" size={17} /></button>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><img className="brand-mark" src={gastoswellLogo} alt="" /><strong>gastoswell<span>.</span></strong></div>
          <div className="breadcrumbs"><span>Workspace</span><Icon name="chevron" size={14} /><strong>{NAV_ITEMS.find((item) => item.id === activePage)?.label}</strong></div>
          <div className="topbar-actions">
            <span className={`save-indicator ${saveStatus}`}><i />{saveStatus === 'saving' ? 'Saving…' : saveStatus === 'offline' ? 'Local save failed' : 'Saved on this device'}</span>
            <button className="icon-button theme-toggle" aria-label={`Switch to ${data.theme === 'dark' ? 'light' : 'dark'} mode`} title="Toggle appearance" onClick={() => patch({ theme: data.theme === 'dark' ? 'light' : 'dark' })}><Icon name={data.theme === 'dark' ? 'sun' : 'moon'} size={19} /></button>
            <button className="icon-button logout-button" aria-label="Lock and sign out" title={`Sign out ${profile.username}`} onClick={lockWorkspace}><Icon name="logout" size={18} /></button>
            <button className="button button-primary top-add" onClick={() => setModal('transaction')}><Icon name="plus" size={17} /><span>New transaction</span></button>
          </div>
        </header>

        <main className="main-content">
          {profile.warning && !migrationWarningDismissed && <div className="notice" role="alert"><span>{profile.warning}</span><button aria-label="Dismiss storage warning" onClick={() => setMigrationWarningDismissed(true)}><Icon name="close" size={16} /></button></div>}
          {error && <div className="notice" role="status"><span>{error}</span><button aria-label="Dismiss" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
          <section className="page-heading">
            <div><p className="eyebrow">{activePage === 'overview' ? 'YOUR FINANCIAL SNAPSHOT' : 'YOUR MONEY, ORGANIZED'}</p><h1>{activePage === 'overview' ? 'Good things are growing.' : NAV_ITEMS.find((item) => item.id === activePage)?.label}</h1><p className="page-subtitle">{activePage === 'overview' ? 'A clear picture of where you are, and where you’re headed.' : `Your ${NAV_ITEMS.find((item) => item.id === activePage)?.label.toLowerCase()} at a glance.`}</p></div>
            <div className="period-picker">
              <button className="icon-button period-arrow" aria-label={`Previous ${range}`} disabled={range === 'all-time' || range === 'custom'} onClick={() => changePeriod(-1)}>‹</button>
              <select aria-label="Analytics period" value={range} onChange={(event) => {
                const analyticsMode = event.target.value;
                const customDates = analyticsMode === 'custom' ? {
                  customStartDate: data.customStartDate || `${monthKey}-01`,
                  customEndDate: data.customEndDate || dateKey(new Date(data.selectedYear, data.selectedMonth + 1, 0))
                } : {};
                patch({ analyticsMode, allTime: analyticsMode === 'all-time', ...customDates });
              }}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarter</option>
                <option value="half-year">Half year</option>
                <option value="yearly">Whole year</option>
                <option value="all-time">All time</option>
                <option value="custom">Custom date</option>
              </select>
              <span className="period-label" aria-live="polite">{periodLabel}</span>
              {range === 'custom' && <div className="custom-date-fields">
                <label>From<input type="date" aria-label="Custom date start" max={data.customEndDate || undefined} value={data.customStartDate || ''} onChange={(event) => {
                  const customStartDate = event.target.value;
                  patch({ customStartDate, customEndDate: data.customEndDate && data.customEndDate < customStartDate ? customStartDate : data.customEndDate });
                }} /></label>
                <label>To<input type="date" aria-label="Custom date end" min={data.customStartDate || undefined} value={data.customEndDate || ''} onChange={(event) => {
                  const customEndDate = event.target.value;
                  patch({ customEndDate, customStartDate: data.customStartDate && data.customStartDate > customEndDate ? customEndDate : data.customStartDate });
                }} /></label>
              </div>}
              <button className="icon-button period-arrow" aria-label={`Next ${range}`} disabled={range === 'all-time' || range === 'custom'} onClick={() => changePeriod(1)}>›</button>
            </div>
          </section>

          {(allPages || activePage === 'overview') && <>
            <section className="metrics-grid" aria-label="Selected period summary">
              <MetricCard title="Income" value={formatMoney(totals.income)} note={`${periodTransactions.filter((tx) => tx.type === 'income').length} deposits in period`} color="green" icon="trend" />
              <MetricCard title="Expenses" value={formatMoney(totals.expenses)} note={totals.income ? `${Math.round(totals.expenses / totals.income * 100)}% of income used` : 'No income logged in period'} color="coral" icon="arrows" />
              <MetricCard title="Available to grow" value={formatMoney(totals.surplus)} note={totals.surplus >= 0 ? 'After your recorded expenses' : 'Spending is above income'} color="blue" icon="wallet" />
              <MetricCard title="Savings balance" value={formatMoney(totals.savings)} note={`${data.goals.length} active savings ${data.goals.length === 1 ? 'goal' : 'goals'}`} color="purple" icon="target" />
            </section>

            <section className="content-grid">
              <article className="panel flow-panel">
                <div className="panel-heading"><div><p className="eyebrow">CASH FLOW</p><h2>Money in, money out</h2></div><div className="legend"><span><i className="legend-income" />Income</span><span><i className="legend-expense" />Expenses</span></div></div>
                <FlowChart transactions={periodTransactions} range={range} year={data.selectedYear} month={data.selectedMonth} periodWindow={periodWindow} />
                <div className="chart-foot"><span>{periodLabel}</span><span><strong>{formatMoney(totals.surplus)}</strong> net cash flow</span></div>
              </article>
              <article className="panel coach-panel">
                <div className="coach-ornament"><Icon name="sparkles" size={21} /></div>
                <p className="eyebrow">A LITTLE GUIDANCE</p><h2>Your next best move</h2>
                <p className="coach-copy">{coachText}</p>
                <div className="coach-divider" />
                <div className="coach-stats"><div><span>PERIOD SAVINGS RATE</span><strong>{totals.savingsRate}%</strong></div><div><span>BILLS PAID THIS MONTH</span><strong>{totals.paidBills}<small> / {data.bills.length}</small></strong></div></div>
                <button className="text-button" onClick={() => activeNav(topDebt ? 'debts' : 'goals')}>{topDebt ? 'See debt payoff plan' : 'Explore your savings goals'}<Icon name="chevron" size={16} /></button>
              </article>
            </section>
            <section className="panel spending-panel" aria-label="Smart spending analytics">
              <div className="panel-heading spending-heading">
                <div><p className="eyebrow">SMART ANALYTICS</p><h2>Where your money goes</h2><p className="section-description">Spending breakdown for {periodLabel}</p></div>
                <span className="spending-count">{spendingAnalytics.count} {spendingAnalytics.count === 1 ? 'expense' : 'expenses'}</span>
              </div>
              {spendingAnalytics.topCategory ? <div className="spending-content">
                <div className="spending-breakdown">
                  <div className="spending-list-heading"><span>TOP SPENDING CATEGORIES</span><span>AMOUNT</span></div>
                  {spendingAnalytics.categories.map((item) => {
                    const share = Math.round(item.amount / spendingAnalytics.total * 100);
                    return <div className="spending-row" key={item.category}>
                      <div className="spending-category"><strong>{item.category}</strong><div className="spending-track" role="progressbar" aria-label={`${item.category} share of expenses`} aria-valuenow={share} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${share}%` }} /></div></div>
                      <span className="spending-amount">{formatMoney(item.amount)}<small>{share}%</small></span>
                    </div>;
                  })}
                  <div className="spending-average"><span>Average per expense</span><strong>{formatMoney(spendingAnalytics.average)}</strong></div>
                </div>
                <aside className="spending-insights">
                  <div className="spending-insight-card"><span>TOP CATEGORY</span><strong>{spendingAnalytics.topCategory.category}</strong><b>{formatMoney(spendingAnalytics.topCategory.amount)}</b><small>{spendingAnalytics.topCategoryShare}% of recorded expenses</small></div>
                  {spendingAnalytics.largestExpense && <div className="spending-insight-card"><span>LARGEST EXPENSE</span><strong>{spendingAnalytics.largestExpense.note || spendingAnalytics.largestExpense.category}</strong><b>{formatMoney(spendingAnalytics.largestExpense.amount)}</b><small>{spendingAnalytics.largestExpense.category} · {spendingAnalytics.largestExpense.date}</small></div>}
                  <p className="spending-trend">{spendingTrend}</p>
                </aside>
              </div> : <p className="spending-empty">No expenses recorded for this period. Add transactions to see your top categories and spending patterns.</p>}
            </section>
          </>}

          {showTransactions && <section className="panel section-panel">
            <div className="panel-heading section-heading"><div><p className="eyebrow">YOUR ACTIVITY</p><h2>Recent transactions</h2><p className="section-description">Income and spending for {periodLabel}</p></div><div className="section-tools"><label className="search-field"><span>⌕</span><input aria-label="Search transactions" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search activity" /></label><select aria-label="Filter transaction type" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="all">Everything</option><option value="income">Income</option><option value="expense">Expenses</option></select><button className="button button-outline" onClick={() => setModal('transaction')}><Icon name="plus" size={16} /><span>Add</span></button></div></div>
            <TransactionsTable transactions={filteredTransactions} onDelete={(id) => deleteItem('transactions', id)} />
          </section>}

          {showAccounts && <section className="panel section-panel">
            <div className="panel-heading section-heading"><div><p className="eyebrow">YOUR PAYMENT SOURCES</p><h2>Banks, cards & e-wallets</h2><p className="section-description">Set balances manually. Linked income adds to a balance; linked expenses subtract from it.</p></div><button className="button button-outline" onClick={() => { setActionTarget(null); setModal('account'); }}><Icon name="plus" size={16} /><span>Add account</span></button></div>
            {data.accounts.length ? <>
              <div className="account-summary"><span>{data.accounts.length} payment {data.accounts.length === 1 ? 'account' : 'accounts'}</span><strong>{formatMoney(data.accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0))}<small> total balance</small></strong></div>
              <div className="account-grid">{data.accounts.map((account) => <AccountCard key={account.id} account={account} onEdit={() => { setActionTarget({ type: 'account-balance', id: account.id }); setModal('account-balance'); }} onDelete={() => deleteItem('accounts', account.id)} />)}</div>
            </> : <EmptyState title="Add your first account" text="Add a bank account, card, GCash, or e-wallet and enter its current balance." action="Add a bank or wallet" onClick={() => { setActionTarget(null); setModal('account'); }} />}
          </section>}

          {showBills && <section className="panel section-panel">
            <div className="panel-heading section-heading"><div><p className="eyebrow">STAY ON TOP OF THINGS</p><h2>Monthly bills</h2><p className="section-description">Confirm a bill payment to add it to your analytics.</p></div><button className="button button-outline" onClick={() => setModal('bill')}><Icon name="plus" size={16} /><span>Add a bill</span></button></div>
            <div className="bill-summary"><span><strong>{formatMoney(data.bills.reduce((sum, bill) => sum + Number(bill.amount), 0))}</strong> planned this month</span><span><strong>{data.bills.length - totals.paidBills}</strong> still to pay</span></div>
            {data.bills.length ? <div className="item-list">{[...data.bills].sort((a, b) => a.dueDay - b.dueDay).map((bill) => <BillRow key={bill.id} bill={bill} paid={(bill.paidMonths || []).includes(monthKey)} onToggle={() => toggleBill(bill)} onDelete={() => deleteItem('bills', bill.id)} />)}</div> : <EmptyState title="No bills just yet" text="Add your recurring bills to keep everything in one place." action="Add a bill" onClick={() => setModal('bill')} />}
          </section>}

          {showDebts && <section className="panel section-panel">
            <div className="panel-heading section-heading"><div><p className="eyebrow">ONE STEP AT A TIME</p><h2>Debt payoff</h2><p className="section-description">Every payment gets you closer to a clean slate.</p></div><button className="button button-outline" onClick={() => setModal('debt')}><Icon name="plus" size={16} /><span>Track debt</span></button></div>
            <DebtSection debts={data.debts} onPay={(id) => { setActionTarget({ type: 'debt', id }); setModal('contribute'); }} onDelete={(id) => deleteItem('debts', id)} />
          </section>}

          {showGoals && <section className="panel section-panel">
            <div className="panel-heading section-heading"><div><p className="eyebrow">BUILD YOUR FUTURE</p><h2>Savings goals</h2><p className="section-description">Make room for the things that matter to you.</p></div><button className="button button-outline" onClick={() => setModal('goal')}><Icon name="plus" size={16} /><span>New goal</span></button></div>
            {data.goals.length ? <div className="goal-grid">{data.goals.map((goal) => <GoalCard key={goal.id} goal={goal} onAdd={() => { setActionTarget({ type: 'goal', id: goal.id }); setModal('contribute'); }} onDelete={() => deleteItem('goals', goal.id)} />)}</div> : <EmptyState title="Give your savings a purpose" text="Create a goal and watch your progress grow." action="Create a goal" onClick={() => setModal('goal')} />}
          </section>}

          <footer className="page-footer"><div className="footer-branding"><span>Made for a little more peace of mind.</span><span className="provider-attribution"><img src={providerLogo} alt="G_DEV_SOLUTIONS logo" /><span className="provider-copy"><strong>G_DEV_SOLUTIONS</strong><span>Since 2026</span><small>We build systems that move businesses.</small></span></span></div><div className="footer-actions"><button onClick={exportTransactionsCsv}>Export CSV</button><button onClick={exportBackup}>Download backup</button><label className="file-button">Restore backup<input type="file" accept=".json,application/json" onChange={importBackup} /></label><button onClick={resetData}>Clear workspace</button></div></footer>
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation">{NAV_ITEMS.map((item) => <NavButton key={item.id} item={item} active={activePage === item.id} onClick={() => activeNav(item.id)} mobile />)}</nav>
      <button className="mobile-fab" onClick={() => setModal('transaction')} aria-label="Add transaction"><Icon name="plus" size={24} /></button>
      {modal && <Modal type={modal} actionTarget={actionTarget} accounts={data.accounts} debts={data.debts} goals={data.goals} monthKey={monthKey} onClose={() => { setModal(null); setActionTarget(null); }} onSubmit={submitForm} />}
      {billConfirmation && <BillPaymentConfirmation bill={billConfirmation} accounts={data.accounts} monthLabel={monthLabel} onClose={() => setBillConfirmation(null)} onConfirm={confirmBillPaid} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function NavButton({ item, active, onClick, mobile = false }) {
  return <button className={`nav-button${active ? ' active' : ''}${mobile ? ' mobile-nav-button' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}><Icon name={item.icon} size={19} /><span>{mobile ? item.label.split(' ')[0] : item.label}</span></button>;
}

function MetricCard({ title, value, note, color, icon }) {
  return <article className={`metric-card metric-${color}`}><div className="metric-top"><span>{title}</span><i><Icon name={icon} size={19} /></i></div><strong className="metric-value">{value}</strong><span className="metric-note">{note}</span></article>;
}

function FlowChart({ transactions, range, year, month, periodWindow }) {
  const dayCount = daysInMonth(year, month);
  let groups;
  if (range === 'daily') {
    groups = ['12–4 AM', '4–8 AM', '8 AM–12 PM', '12–4 PM', '4–8 PM', '8 PM–12 AM'].map((label) => ({ label, income: 0, expense: 0 }));
    if (transactions.some((tx) => !tx.time || !/^\d{2}:\d{2}$/.test(tx.time) || Number(tx.time.slice(0, 2)) > 23)) {
      groups.push({ label: 'No time', income: 0, expense: 0 });
    }
  } else if (range === 'weekly') {
    groups = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({ label, income: 0, expense: 0 }));
  } else if (range === 'monthly') {
    groups = Array.from({ length: Math.ceil(dayCount / 7) }, (_, index) => {
      const start = index * 7 + 1;
      return { label: `${start}–${Math.min(start + 6, dayCount)}`, income: 0, expense: 0 };
    });
  } else if (range === 'quarterly' || range === 'half-year' || range === 'yearly') {
    const startMonth = range === 'quarterly'
      ? Math.floor(month / 3) * 3
      : range === 'half-year' ? Math.floor(month / 6) * 6 : 0;
    const count = range === 'quarterly' ? 3 : range === 'half-year' ? 6 : 12;
    groups = Array.from({ length: count }, (_, index) => ({
      label: MONTHS[startMonth + index].slice(0, 3),
      income: 0,
      expense: 0
    }));
  } else if (range === 'custom' && periodWindow) {
    groups = [];
    const cursor = new Date(periodWindow.start.getFullYear(), periodWindow.start.getMonth(), 1);
    const lastMonth = periodWindow.end.getFullYear() * 12 + periodWindow.end.getMonth();
    while (cursor.getFullYear() * 12 + cursor.getMonth() <= lastMonth) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      const label = periodWindow.start.getFullYear() === periodWindow.end.getFullYear()
        ? MONTHS[cursor.getMonth()].slice(0, 3)
        : `${MONTHS[cursor.getMonth()].slice(0, 3)} ${String(cursor.getFullYear()).slice(-2)}`;
      groups.push({ key, label, income: 0, expense: 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  } else if (range === 'custom') {
    groups = [];
  } else {
    groups = [...new Set(transactions.map((tx) => tx.date.slice(0, 4)))].sort().map((label) => ({ label, income: 0, expense: 0 }));
  }
  transactions.forEach((tx) => {
    const date = new Date(`${tx.date}T00:00:00`);
    const transactionMonth = Number(tx.date.slice(5, 7)) - 1;
    let index;
    if (range === 'daily') {
      const hour = tx.time && /^\d{2}:\d{2}$/.test(tx.time) ? Number(tx.time.slice(0, 2)) : -1;
      index = hour < 0 || hour > 23 ? groups.findIndex((group) => group.label === 'No time') : Math.floor(hour / 4);
    } else if (range === 'weekly') index = (date.getDay() + 6) % 7;
    else if (range === 'monthly') index = Math.floor((Number(tx.date.slice(-2)) - 1) / 7);
    else if (range === 'quarterly') index = transactionMonth % 3;
    else if (range === 'half-year') index = transactionMonth % 6;
    else if (range === 'yearly') index = transactionMonth;
    else if (range === 'custom') index = groups.findIndex((group) => group.key === tx.date.slice(0, 7));
    else index = groups.findIndex((group) => group.label === tx.date.slice(0, 4));
    if (groups[index]) groups[index][tx.type === 'income' ? 'income' : 'expense'] += Number(tx.amount);
  });
  const maxValue = Math.max(1, ...groups.flatMap((group) => [group.income, group.expense]));
  const descriptor = { daily: 'Daily', weekly: 'Weekly', monthly: 'Weekly', quarterly: 'Monthly', 'half-year': 'Monthly', yearly: 'Monthly', 'all-time': 'Annual', custom: 'Monthly' }[range];
  return <div className="flow-chart" role="group" aria-label={`${descriptor} income and expense comparison`}>{groups.length ? groups.map((group) => <div className="bar-group" key={group.key || group.label}><div className="bar-pair"><button type="button" className="bar income-bar" style={{ height: `${Math.max(3, group.income / maxValue * 100)}%` }} aria-label={`Income ${formatMoney(group.income)} for ${group.label}`} title={`Income ${formatMoney(group.income)}`} /><button type="button" className="bar expense-bar" style={{ height: `${Math.max(3, group.expense / maxValue * 100)}%` }} aria-label={`Expenses ${formatMoney(group.expense)} for ${group.label}`} title={`Expenses ${formatMoney(group.expense)}`} /></div><span>{group.label}</span></div>) : <span className="chart-empty">{range === 'custom' ? 'Choose dates to view this range' : 'No transactions yet'}</span>}</div>;
}

function TransactionsTable({ transactions, onDelete }) {
  if (!transactions.length) return <EmptyState title="Nothing to show yet" text="Add your first transaction to start understanding your money." />;
  return <div className="table-scroll"><table className="transaction-table"><thead><tr><th>TRANSACTION</th><th>CATEGORY</th><th>DATE / TIME</th><th className="align-right">AMOUNT</th><th /></tr></thead><tbody>{transactions.map((tx) => <tr key={tx.id}><td><span className={`transaction-icon ${tx.type}`}><Icon name={tx.type === 'income' ? 'trend' : 'arrows'} size={17} /></span><span className="transaction-name"><strong>{tx.note}</strong><small>{tx.type === 'income' ? 'Money in' : 'Money out'}{tx.accountName ? ` · ${tx.accountName}` : ''}</small></span></td><td><span className="category-pill">{tx.category}</span></td><td className="date-cell"><time dateTime={tx.time ? `${tx.date}T${tx.time}` : tx.date}>{tx.date}{tx.time ? ` · ${tx.time}` : ''}</time></td><td className={`amount-cell align-right ${tx.type}`}>{tx.type === 'income' ? '+' : '−'}{formatMoney(tx.amount)}</td><td><button className="delete-button" aria-label={`Delete ${tx.note}`} onClick={() => onDelete(tx.id)}><Icon name="close" size={16} /></button></td></tr>)}</tbody></table></div>;
}

function AccountCard({ account, onEdit, onDelete }) {
  return <article className="account-card">
    <div className="account-card-top"><span className="account-icon"><Icon name="wallet" size={19} /></span><button className="delete-button" aria-label={`Remove ${account.name}`} onClick={onDelete}><Icon name="close" size={16} /></button></div>
    <p>{account.type}</p>
    <h3>{account.name}</h3>
    <div className="account-balance"><span>AVAILABLE BALANCE</span><strong>{formatMoney(account.balance)}</strong></div>
    <button className="account-update-button" onClick={onEdit}>Update balance</button>
  </article>;
}

function BillRow({ bill, paid, onToggle, onDelete }) {
  return <div className={`bill-row${paid ? ' bill-paid' : ''}`}><button className={`check-button${paid ? ' checked' : ''}`} onClick={onToggle} aria-label={paid ? `Mark ${bill.name} unpaid` : `Confirm ${bill.name} paid`}>{paid ? '✓' : ''}</button><div className="bill-info"><strong>{bill.name}</strong><span>Due on the {bill.dueDay}th · {bill.category}</span></div><div className="bill-amount"><strong>{formatMoney(bill.amount)}</strong><span>{paid ? 'Paid' : 'Upcoming'}</span></div><button className="delete-button" aria-label={`Delete ${bill.name}`} onClick={onDelete}><Icon name="close" size={16} /></button></div>;
}

function BillPaymentConfirmation({ bill, accounts, monthLabel, onClose, onConfirm }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card bill-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="bill-confirmation-title" aria-describedby="bill-confirmation-copy">
      <div className="modal-header">
        <div><p className="eyebrow">PAYMENT CONFIRMATION</p><h2 id="bill-confirmation-title">Have you paid this bill?</h2></div>
        <button className="icon-button" aria-label="Close confirmation" onClick={onClose}><Icon name="close" size={19} /></button>
      </div>
      <p className="bill-confirmation-copy" id="bill-confirmation-copy">Confirm that you have paid <strong>{bill.name}</strong>. This adds the payment as an expense in your {monthLabel} analytics.</p>
      <div className="bill-confirmation-summary"><span>Amount</span><strong>{formatMoney(bill.amount)}</strong></div>
      {accounts.length > 0 && <AccountField accounts={accounts} label="Paid from" value={accountId} onChange={(event) => setAccountId(event.target.value)} />}
      <div className="modal-actions">
        <button type="button" className="button button-quiet" onClick={onClose}>Not yet</button>
        <button type="button" className="button button-primary" onClick={() => onConfirm(accountId)}>Yes, I paid this</button>
      </div>
    </section>
  </div>;
}

function DebtSection({ debts, onPay, onDelete }) {
  if (!debts.length) return <EmptyState title="No debt to track" text="If you’re working on a balance, add it here and celebrate each payment." />;
  const original = debts.reduce((sum, debt) => sum + Number(debt.total), 0);
  const remaining = debts.reduce((sum, debt) => sum + Number(debt.remaining), 0);
  const progress = original ? Math.min(100, Math.round((original - remaining) / original * 100)) : 100;
  return <><div className="debt-overview"><div><span>REMAINING BALANCE</span><strong>{formatMoney(remaining)}</strong></div><div className="debt-progress"><div className="progress-heading"><span>{progress}% paid off</span><span>{formatMoney(original)} total</span></div><Progress value={progress} /></div></div><div className="item-list">{debts.map((debt) => { const pct = debt.total ? Math.min(100, Math.round((debt.total - debt.remaining) / debt.total * 100)) : 100; return <div className="debt-row" key={debt.id}><div className="debt-row-main"><div className="debt-name"><strong>{debt.name}</strong><span>{debt.interest}% monthly interest · {formatMoney(debt.minPay)} minimum</span></div><strong className="debt-balance">{formatMoney(debt.remaining)}<small> left</small></strong></div><Progress value={pct} /><div className="debt-row-actions"><span>{pct}% paid off</span><button className="text-button" onClick={() => onPay(debt.id)}>Make a payment <Icon name="chevron" size={15} /></button><button className="delete-button" aria-label={`Delete ${debt.name}`} onClick={() => onDelete(debt.id)}><Icon name="close" size={16} /></button></div></div>; })}</div></>;
}

function GoalCard({ goal, onAdd, onDelete }) {
  const progress = goal.target ? Math.min(100, Math.round(goal.current / goal.target * 100)) : 100;
  const left = Math.max(0, goal.target - goal.current);
  return <article className="goal-card"><div className="goal-card-top"><span className="goal-icon"><Icon name="target" size={19} /></span><button className="delete-button" aria-label={`Delete ${goal.name}`} onClick={onDelete}><Icon name="close" size={16} /></button></div><h3>{goal.name}</h3><div className="goal-balance"><strong>{formatMoney(goal.current)}</strong><span>of {formatMoney(goal.target)}</span></div><Progress value={progress} /><div className="goal-footer"><span>{progress}% funded</span><span>{left ? `${formatMoney(left)} to go` : 'Goal reached!'}</span></div><button className="goal-add-button" onClick={onAdd}><Icon name="plus" size={15} />Add to goal</button></article>;
}

function Progress({ value }) {
  return <div className="progress-track" role="progressbar" aria-valuenow={value} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${value}%` }} /></div>;
}

function EmptyState({ title, text, action, onClick }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="sparkles" size={20} /></span><strong>{title}</strong><p>{text}</p>{action && <button className="button button-outline" onClick={onClick}><Icon name="plus" size={16} />{action}</button>}</div>;
}

function Modal({ type, actionTarget, accounts, debts, goals, monthKey, onClose, onSubmit }) {
  const [transactionType, setTransactionType] = useState('expense');
  const [year, month] = monthKey.split('-').map(Number);
  const currentDate = new Date();
  const selectedIsCurrent = currentDate.getFullYear() === year && currentDate.getMonth() + 1 === month;
  const day = selectedIsCurrent ? currentDate.getDate() : 15;
  const today = `${monthKey}-${String(Math.min(day, new Date(year, month, 0).getDate())).padStart(2, '0')}`;
  const activeDebt = type === 'contribute' && actionTarget?.type === 'debt' ? debts.find((item) => item.id === actionTarget.id) : null;
  const activeGoal = type === 'contribute' && actionTarget?.type === 'goal' ? goals.find((item) => item.id === actionTarget.id) : null;
  const activeAccount = type === 'account-balance' ? accounts.find((item) => item.id === actionTarget?.id) : null;
  const isContribution = type === 'contribute';
  const title = { transaction: 'Add a transaction', account: 'Add a bank or wallet', bill: 'Add a recurring bill', debt: 'Track a debt', goal: 'Create a savings goal' }[type] || (activeAccount ? `Update ${activeAccount.name}` : activeDebt ? `Pay down ${activeDebt.name}` : `Add to ${activeGoal?.name || 'your goal'}`);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><p className="eyebrow">GASTOSWELL</p><h2 id="modal-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close" size={19} /></button></div>
    <form className="modal-form" onSubmit={onSubmit}>
      {type === 'transaction' && <><div className="segmented-control"><button type="button" className={transactionType === 'expense' ? 'selected expense-selected' : ''} onClick={() => setTransactionType('expense')}>Expense</button><button type="button" className={transactionType === 'income' ? 'selected income-selected' : ''} onClick={() => setTransactionType('income')}>Income</button><input type="hidden" name="type" value={transactionType} /></div><Field label="Amount" name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required prefix="₱" /><Field label="Description" name="note" placeholder="What was this for?" required /><SelectField label="Category" name="category" options={transactionType === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES} />{accounts.length ? <AccountField accounts={accounts} label="Account used" required /> : <p className="modal-hint">Add a bank, card, GCash, or e-wallet account to track its balance.</p>}<div className="form-grid"><Field label="Date" name="date" type="date" defaultValue={today} required /><Field label="Time" name="time" type="time" defaultValue={currentDate.toTimeString().slice(0, 5)} required /></div></>}
      {type === 'account' && <><Field label="Account name" name="name" placeholder="e.g. BDO Savings, Maya, or Travel card" required /><Field label="Account type / provider" name="accountType" placeholder="Enter any bank, card, or e-wallet type" required /><Field label="Current balance" name="balance" type="number" min="0" step="0.01" placeholder="0.00" required prefix="₱" /><p className="modal-hint">Enter the balance you see now. Add as many accounts as you need; linked expenses reduce the balance automatically.</p></>}
      {type === 'account-balance' && <><p className="modal-hint">Enter the latest available balance for {activeAccount?.name}. This replaces the tracked amount; it won’t change transaction history.</p><Field label="Current balance" name="balance" type="number" step="0.01" defaultValue={activeAccount?.balance ?? 0} required prefix="₱" /></>}
      {type === 'bill' && <><Field label="Bill name" name="name" placeholder="e.g. Internet" required /><div className="form-grid"><Field label="Monthly amount" name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /><Field label="Due day" name="dueDay" type="number" min="1" max="31" defaultValue="15" required /></div><SelectField label="Category" name="category" options={['Bills & Utilities', 'Subscriptions & Software', 'Housing & Rent', 'Business Overhead']} /></>}
      {type === 'debt' && <><Field label="Debt name" name="name" placeholder="e.g. Credit card" required /><div className="form-grid"><Field label="Original balance" name="total" type="number" min="0.01" step="0.01" required /><Field label="Balance remaining" name="remaining" type="number" min="0" step="0.01" required /></div><div className="form-grid"><Field label="Monthly interest (%)" name="interest" type="number" min="0" step="0.1" defaultValue="0" required /><Field label="Minimum monthly payment" name="minPay" type="number" min="0.01" step="0.01" required /></div></>}
      {type === 'goal' && <><Field label="Goal name" name="name" placeholder="e.g. Emergency fund" required /><div className="form-grid"><Field label="Savings target" name="target" type="number" min="0.01" step="0.01" required /><Field label="Already saved" name="current" type="number" min="0" step="0.01" defaultValue="0" required /></div><Field label="Monthly contribution target" name="monthlyTarget" type="number" min="0.01" step="0.01" required /></>}
      {isContribution && <><p className="modal-hint">{activeDebt ? `Current balance: ${formatMoney(activeDebt.remaining)}` : `Saved so far: ${formatMoney(activeGoal?.current)} of ${formatMoney(activeGoal?.target)}`}</p><Field label="Amount" name="amount" type="number" min="0.01" step="0.01" defaultValue={activeDebt ? Math.min(activeDebt.remaining, activeDebt.minPay) : activeGoal?.monthlyTarget} required prefix="₱" />{accounts.length > 0 && <AccountField accounts={accounts} label="Paid from (optional)" />}<label className="checkbox-field"><input type="checkbox" name="record" value="yes" defaultChecked /><span>Also add this to monthly expenses</span></label></>}
      <div className="modal-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary">{isContribution ? 'Confirm' : 'Save'}</button></div>
    </form>
  </section></div>;
}

function Field({ label, name, prefix, ...props }) {
  return <label className="form-field"><span>{label}</span><div className={prefix ? 'input-with-prefix' : ''}>{prefix && <i>{prefix}</i>}<input name={name} {...props} /></div></label>;
}

function SelectField({ label, name, options }) {
  return <label className="form-field"><span>{label}</span><select name={name} defaultValue={options[0]} required>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function AccountField({ accounts, label, name = 'accountId', value, onChange, required = false }) {
  const controlProps = value === undefined ? { defaultValue: '' } : { value, onChange };
  return <label className="form-field"><span>{label}</span><select name={name} required={required} {...controlProps}><option value="" disabled={required}>Select an account</option><option value="none">Don’t update a balance</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {formatMoney(account.balance)}</option>)}</select><small className="form-help">Linked expenses subtract from this balance; linked income adds to it.</small></label>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><LocalAccountGate /></React.StrictMode>);
