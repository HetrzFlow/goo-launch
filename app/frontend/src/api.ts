export function getToken(): string | null {
  return localStorage.getItem('token');
}

export function setToken(token: string): void {
  localStorage.setItem('token', token);
}

export function removeToken(): void {
  localStorage.removeItem('token');
}

export function decodeToken(token: string): { user_id: number; wallet_address: string; role: string; exp: number } | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  const decoded = decodeToken(token);
  if (!decoded) return false;
  return decoded.exp * 1000 > Date.now();
}

export function requireAuth(): void {
  if (!isLoggedIn()) {
    removeToken();
    window.location.href = '/login.html';
  }
}

const DEFAULT_TIMEOUT = 30_000;
const DEPLOY_TIMEOUT = 150_000;
const API_BASE = import.meta.env.VITE_API_URL || '';

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isDeployRequest = path === '/api/deploy' || path.startsWith('/api/launch') || path.startsWith('/api/sandbox') || path.startsWith('/api/agos');
  const timeout = isDeployRequest ? DEPLOY_TIMEOUT : DEFAULT_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (res.status === 401) {
      removeToken();
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    const text = await res.text();
    if (!text) throw new Error(`Server returned empty response (HTTP ${res.status}). Is the backend running?`);
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Server returned non-JSON response (HTTP ${res.status}). Is the backend running?`);
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(
        isDeployRequest
          ? 'Creation timed out. The blockchain transaction may still be processing — check your dashboard shortly.'
          : 'Request timed out. Please try again.'
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
