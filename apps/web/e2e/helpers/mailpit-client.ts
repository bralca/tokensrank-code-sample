export type MailpitAddress = {
  Address?: string;
  Name?: string;
};

export type MailpitMessageSummary = {
  ID: string;
  MessageID?: string;
  Read?: boolean;
  From?: MailpitAddress;
  To?: MailpitAddress[];
  Subject?: string;
  Created?: string;
  Size?: number;
};

export type MailpitMessage = MailpitMessageSummary & {
  Text?: string;
  HTML?: string;
};

type MailpitMessagesResponse = {
  messages?: MailpitMessageSummary[];
  Messages?: MailpitMessageSummary[];
};

const DEFAULT_MAILPIT_API_BASE = 'http://127.0.0.1:8025';
const RESET_LINK_PATH = '/auth/password-reset/confirm';
const POLL_INTERVAL_MS = 250;
const POLL_TIMEOUT_MS = 30_000;

function mailpitApiBase(): string {
  return (process.env.MAILPIT_API_BASE ?? DEFAULT_MAILPIT_API_BASE).replace(/\/$/, '');
}

function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

function messageRecipients(message: Pick<MailpitMessageSummary, 'To'>): string[] {
  return (message.To ?? [])
    .map((recipient) => recipient.Address ?? '')
    .filter(Boolean)
    .map(normalizeRecipient);
}

async function mailpitFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${mailpitApiBase()}${path}`, init);

  if (!response.ok) {
    throw new Error(`[mailpit] ${init?.method ?? 'GET'} ${path} failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

async function getMessage(id: string): Promise<MailpitMessage> {
  return await mailpitFetch<MailpitMessage>(`/api/v1/message/${encodeURIComponent(id)}`);
}

export async function clearEmails(): Promise<void> {
  await mailpitFetch<void>('/api/v1/messages', { method: 'DELETE' });
}

export async function isMailpitAvailable(): Promise<boolean> {
  try {
    await mailpitFetch<MailpitMessagesResponse>('/api/v1/messages');
    return true;
  } catch {
    return false;
  }
}

export async function getEmails(recipientEmail?: string): Promise<MailpitMessage[]> {
  const response = await mailpitFetch<MailpitMessagesResponse>('/api/v1/messages');
  const summaries = response.messages ?? response.Messages ?? [];
  const recipient = recipientEmail ? normalizeRecipient(recipientEmail) : null;
  const filteredSummaries = recipient
    ? summaries.filter((message) => messageRecipients(message).includes(recipient))
    : summaries;

  return await Promise.all(filteredSummaries.map((message) => getMessage(message.ID)));
}

export async function getLatestEmail(recipientEmail: string, timeoutMs = POLL_TIMEOUT_MS): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const messages = await getEmails(recipientEmail);
    const latest = messages
      .filter((message) => messageRecipients(message).includes(normalizeRecipient(recipientEmail)))
      .sort((left, right) => Date.parse(right.Created ?? '') - Date.parse(left.Created ?? ''))[0];

    if (latest) {
      return latest;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL_MS);
    });
  }

  throw new Error(`[mailpit] No email received for ${recipientEmail} within ${timeoutMs}ms`);
}

export function extractResetLink(message: Pick<MailpitMessage, 'Text' | 'HTML'>): string {
  const body = `${message.Text ?? ''}\n${message.HTML ?? ''}`;
  const escapedPath = RESET_LINK_PATH.replace(/\//g, '\\/');
  const linkPattern = new RegExp(`https?:\\/\\/[^\\s"'<>]+${escapedPath}[^\\s"'<>]*`, 'i');
  const match = body.match(linkPattern);

  if (!match?.[0]) {
    throw new Error('[mailpit] Reset link not found in email body');
  }

  return match[0].replace(/&amp;/g, '&');
}
