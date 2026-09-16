import path from 'node:path';
import { readMediaFile } from './shared.js';

const API_BASE = 'https://api.telegram.org';

async function callTelegram(token, method, { json, form } = {}) {
  const init = form
    ? { method: 'POST', body: form }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json ?? {}) };
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed (${res.status}): ${data.description || 'unknown error'}`);
  }
  return data.result;
}

async function appendFile(form, field, media) {
  const buffer = await readMediaFile(media);
  form.append(field, new Blob([buffer]), path.basename(media.url));
}

// A media group can hold photos and videos but not animations, so a lone gif goes out on
// its own and gifs inside a group are sent as video (Telegram transcodes).
function groupType(mediaType) {
  return mediaType === 'video' || mediaType === 'gif' ? 'video' : 'photo';
}

export async function publish(post) {
  const token = post.access_token;
  const chatId = post.external_account_id;
  if (!chatId) {
    throw new Error('Telegram account is missing its channel/chat id');
  }
  const media = (post.media || []).slice(0, 10);

  if (media.length === 0) {
    const result = await callTelegram(token, 'sendMessage', { json: { chat_id: chatId, text: post.content } });
    return String(result.message_id);
  }

  if (media.length === 1) {
    const only = media[0];
    const method =
      only.media_type === 'gif' ? 'sendAnimation' : only.media_type === 'video' ? 'sendVideo' : 'sendPhoto';
    const field = only.media_type === 'gif' ? 'animation' : only.media_type === 'video' ? 'video' : 'photo';
    const form = new FormData();
    form.append('chat_id', chatId);
    if (post.content) form.append('caption', post.content);
    await appendFile(form, field, only);
    const result = await callTelegram(token, method, { form });
    return String(result.message_id);
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(
    'media',
    JSON.stringify(
      media.map((m, i) => {
        const spec = { type: groupType(m.media_type), media: `attach://file${i}` };
        if (i === 0 && post.content) spec.caption = post.content;
        return spec;
      })
    )
  );
  for (let i = 0; i < media.length; i++) {
    await appendFile(form, `file${i}`, media[i]);
  }
  const result = await callTelegram(token, 'sendMediaGroup', { form });
  return String(Array.isArray(result) ? result[0]?.message_id : result?.message_id);
}
