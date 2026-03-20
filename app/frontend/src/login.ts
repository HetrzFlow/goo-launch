import './theme.css';
import { api, setToken, isLoggedIn } from './api';
import { renderNav } from './auth';
import { showWalletPicker, getSelectedProvider } from './wallet';

renderNav();

if (isLoggedIn()) {
  window.location.href = '/';
}

const btn = document.getElementById('btn-login') as HTMLButtonElement;
const errorEl = document.getElementById('error')!;

async function login() {
  errorEl.classList.remove('visible');
  btn.disabled = true;
  btn.classList.add('btn-loading');

  try {
    const address = await showWalletPicker();
    const provider = getSelectedProvider();
    if (!provider) throw new Error('No wallet provider available');

    // 1. Request nonce from server
    const { nonce } = await api<{ nonce: string }>('POST', '/api/auth/nonce', {
      wallet_address: address,
    });

    // 2. Sign the nonce with wallet
    const message = `Sign in to Goo\n\nNonce: ${nonce}`;
    const signature: string = await provider.request({
      method: 'personal_sign',
      params: [message, address],
    });

    // 3. Verify signature and get JWT
    const data = await api<{ token: string }>('POST', '/api/auth/login', {
      wallet_address: address,
      signature,
    });
    setToken(data.token);
    window.location.href = '/';
  } catch (e) {
    if (e instanceof Error && e.message === 'Cancelled') {
      // User cancelled wallet picker — do nothing
    } else if ((e as any)?.code === 4001 || (e as any)?.code === 'ACTION_REJECTED') {
      // User rejected signature — do nothing
    } else {
      errorEl.textContent = e instanceof Error ? e.message : String(e);
      errorEl.classList.add('visible');
    }
  } finally {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

btn.addEventListener('click', login);
