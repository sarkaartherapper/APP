'use strict';

const MAILEROO_API_URL = 'https://smtp.maileroo.com/api/v2/emails';
const SENDER_EMAIL = 'no-reply@e5d05d38afd7807d.maileroo.org';
const SENDER_NAME = 'Lethem';

function normalizeRecipient(to) {
  if (Array.isArray(to)) return to.map(normalizeRecipient);
  if (to && typeof to === 'object') {
    const address = String(to.address || to.email || '').trim();
    const displayName = String(to.display_name || to.name || '').trim();
    return displayName ? { address, display_name: displayName } : { address };
  }
  return { address: String(to || '').trim() };
}

async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.MAILEROO_API_KEY;
  const recipients = normalizeRecipient(to);
  if (!apiKey) {
    console.error('Maileroo email send skipped: MAILEROO_API_KEY is not configured', { to, subject });
    return { sent: false, skipped: true, provider: 'maileroo', reason: 'MAILEROO_API_KEY missing' };
  }
  if (!to || !subject || (!html && !text)) {
    console.error('Maileroo email send skipped: missing required email fields', { hasTo: Boolean(to), hasSubject: Boolean(subject), hasHtml: Boolean(html), hasText: Boolean(text) });
    return { sent: false, skipped: true, provider: 'maileroo', reason: 'Missing to, subject, or content' };
  }

  try {
    const res = await fetch(MAILEROO_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: { address: SENDER_EMAIL, display_name: SENDER_NAME },
        to: recipients,
        subject,
        html: html || undefined,
        plain: text || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      const message = data?.message || data?.error?.message || data?.error || `Maileroo HTTP ${res.status}`;
      console.error('Maileroo email send failed', { status: res.status, message, to, subject, response: data });
      return { sent: false, provider: 'maileroo', status: res.status, error: message, response: data };
    }
    return { sent: true, provider: 'maileroo', id: data?.data?.reference_id || data?.reference_id || null, response: data };
  } catch (err) {
    console.error('Maileroo email send failed', { message: err.message, to, subject });
    return { sent: false, provider: 'maileroo', error: err.message || 'Maileroo request failed' };
  }
}

module.exports = { sendEmail, SENDER_EMAIL, SENDER_NAME };
