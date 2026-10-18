export interface TelegramAdminStatus {
  configured: boolean;
  connected: boolean;
  account: { id: string; name: string } | null;
  loginStep: 'phone' | 'code' | 'password';
  loginExpiresAt: number | null;
}
export interface HistoryCleanup {
  id: string;
  chatId: string;
  userId: string;
  name: string;
  throughMessageId: number;
  requestedAt: number;
  updatedAt: number;
  status: 'queued' | 'running' | 'complete' | 'failed';
  attempts: number;
  nextAt: number;
  error: string;
}
