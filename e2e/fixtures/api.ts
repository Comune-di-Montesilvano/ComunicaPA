import { randomBytes } from 'node:crypto';
import { API_URL } from './env';

/** Suffisso random per i dati di un flusso: solo [a-z0-9], cercabile in Mailpit come parola intera. */
export function runSuffix(): string {
  return `e2e${randomBytes(5).toString('hex')}`;
}

export interface MailConfig {
  id: string;
  type: 'EMAIL' | 'PEC';
  name: string;
  host: string;
  port: number;
  password: string;
  active: boolean;
  isDefault: boolean;
  fromAddress: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`${what}: HTTP ${status} ${body.slice(0, 300)}`);
  }
}

/** Client minimo delle API backend (via proxy /api del frontend admin). */
export class Api {
  private constructor(private readonly token: string) {}

  static async login(username: string, password: string, baseUrl = API_URL): Promise<Api> {
    const res = await fetch(`${baseUrl}/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text, `login ${username}`);
    return new Api((JSON.parse(text) as { access_token: string }).access_token);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API_URL}${path}`, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text, `${method} ${path}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async mailConfigs(): Promise<MailConfig[]> {
    return (await this.get<{ configs: MailConfig[] }>('/admin/mail-configs?type=EMAIL')).configs;
  }

  /** Stato corrente di una campagna (draft, queued, running, completed, ...). */
  async campaignStatus(id: string): Promise<string> {
    return (await this.get<{ status: string }>(`/admin/campaigns/${id}`)).status;
  }
}
