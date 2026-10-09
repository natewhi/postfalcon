const PLATFORM_DISPLAY_OVERRIDES = { tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', twitter: 'X' };
function platformDisplayName(platform) {
  if (!platform) return 'Unknown';
  return PLATFORM_DISPLAY_OVERRIDES[platform] || platform.charAt(0).toUpperCase() + platform.slice(1);
}

// Header stat strip (scheduled/drafts/failed counts) — a nice-to-have glance at account
// health, independent of loadDrafts()/loadFailedBanner() below (which fetch the same statuses
// but for rendering their own lists, not just counting), so it fails quietly on its own.
async function loadDashboardStats() {
  try {
    const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'draft,scheduled,failed' })}`);
    const counts = { draft: 0, scheduled: 0, failed: 0 };
    posts.forEach((p) => {
      if (counts[p.status] !== undefined) counts[p.status]++;
    });
    document.getElementById('stat-scheduled').textContent = counts.scheduled;
    document.getElementById('stat-drafts').textContent = counts.draft;
    document.getElementById('stat-failed').textContent = counts.failed;
  } catch {
    // stats are a nice-to-have — the rest of the dashboard works fine without them
  }
}

let activeAccountId = new URLSearchParams(window.location.search).get('account');

// v2: the default gained 'posted' — bumping the key resets older saved selections, which
// would otherwise keep hiding a post the moment it publishes.
const CALENDAR_STATUS_STORAGE_KEY = 'postfalcon-calendar-statuses-v2';
const ALL_CALENDAR_STATUSES = ['scheduled', 'failed', 'posted', 'canceled'];
const CALENDAR_VIEW_STORAGE_KEY = 'postfalcon-calendar-view';
const ALL_CALENDAR_VIEWS = ['dayGridMonth', 'timeGridWeek'];

function loadSavedCalendarView() {
  try {
    const saved = localStorage.getItem(CALENDAR_VIEW_STORAGE_KEY);
    if (ALL_CALENDAR_VIEWS.includes(saved)) return saved;
  } catch {
    // ignore malformed storage value, fall back to default
  }
  return 'dayGridMonth';
}

function loadSavedCalendarStatuses() {
  try {
    const saved = JSON.parse(localStorage.getItem(CALENDAR_STATUS_STORAGE_KEY));
    if (Array.isArray(saved)) {
      return saved.filter((s) => ALL_CALENDAR_STATUSES.includes(s));
    }
  } catch {
    // ignore malformed storage value, fall back to default
  }
  return ['scheduled', 'failed', 'posted'];
}

const activeCalendarStatuses = new Set(loadSavedCalendarStatuses());

function setChipActive(chip, active) {
  chip.classList.toggle('active', active);
  chip.setAttribute('aria-pressed', String(active));
}

document.querySelectorAll('.status-filter-chip').forEach((chip) => {
  setChipActive(chip, activeCalendarStatuses.has(chip.dataset.status));
});

function buildPostsQuery(extra = {}) {
  const params = new URLSearchParams();
  if (activeAccountId) params.set('social_account_id', activeAccountId);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

window.filterByAccount = (accountId) => {
  activeAccountId = accountId;
  const url = new URL(window.location.href);
  if (accountId) {
    url.searchParams.set('account', accountId);
  } else {
    url.searchParams.delete('account');
  }
  history.replaceState(null, '', url);
  loadDrafts();
  loadFailedBanner();
  loadDashboardStats();
  calendar.refetchEvents();
};

document.querySelectorAll('.status-filter-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const status = chip.dataset.status;
    if (activeCalendarStatuses.has(status)) {
      activeCalendarStatuses.delete(status);
      setChipActive(chip, false);
    } else {
      activeCalendarStatuses.add(status);
      setChipActive(chip, true);
    }
    localStorage.setItem(CALENDAR_STATUS_STORAGE_KEY, JSON.stringify(Array.from(activeCalendarStatuses)));
    calendar.refetchEvents();
  });
});

async function loadFailedBanner() {
  const banner = document.getElementById('failed-posts-banner');
  try {
    const failed = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'failed' })}`);
    if (failed.length > 0) {
      document.getElementById('failed-posts-message').textContent =
        failed.length === 1
          ? '⚠ 1 post failed to send. Check the calendar (Failed filter) for details.'
          : `⚠ ${failed.length} posts failed to send. Check the calendar (Failed filter) for details.`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch {
    banner.hidden = true;
  }
}

let hasAccounts = false;
let accountsCache = [];

const PLATFORM_CHAR_LIMITS = {
  twitter: 280,
  mastodon: 500,
  threads: 500,
  bluesky: 300,
  facebook: 63206,
  instagram: 2200,
  linkedin: 3000,
  tiktok: 2200,
  pinterest: 500,
};

// Accounts whose platform rejected their credentials (or whose token is about to lapse):
// scheduled posts to them will fail, so say so above the calendar.
function renderReconnectBanner() {
  const banner = document.getElementById('reconnect-banner');
  const broken = accountsCache.filter((a) => accountConnectionIssue(a) === 'reconnect');
  const expiring = accountsCache.filter((a) => accountConnectionIssue(a) === 'expiring');
  const names = (list) => list.map((a) => a.display_name).join(', ');
  if (broken.length) {
    banner.textContent = `⚠ ${names(broken)} ${broken.length === 1 ? 'needs' : 'need'} reconnecting. Posts to ${broken.length === 1 ? 'it' : 'them'} will fail until you do. Reconnect →`;
  } else if (expiring.length) {
    banner.textContent = `⚠ The connection to ${names(expiring)} expires within a week. Reconnect →`;
  }
  banner.hidden = !(broken.length || expiring.length);
}

async function loadAccountOptions() {
  try {
    accountsCache = await apiJson('/api/v1/social-accounts');
    hasAccounts = accountsCache.length > 0;
    renderAccountPicker();
    renderReconnectBanner();
  } catch (err) {
    showToast(err.message);
  }
}

function renderAccountPicker() {
  const picker = document.getElementById('account-picker');
  picker.innerHTML = accountsCache
    .map(
      (a) => `
    <button type="button" class="account-chip" data-account-id="${a.id}"
      title="${escapeHtml(a.display_name)} (${escapeHtml(platformDisplayName(a.platform))})">
      ${accountAvatarHtml(a)}
      <span class="account-chip-name">${escapeHtml(a.display_name)}</span>
    </button>
  `
    )
    .join('');

  picker.querySelectorAll('.account-chip').forEach((chip) => {
    chip.addEventListener('click', () => toggleAccount(chip.dataset.accountId));
  });
}

function selectedAccountIds() {
  return [...document.querySelectorAll('#account-picker .account-chip.selected')].map((c) => c.dataset.accountId);
}

function syncAccountSelection() {
  const ids = selectedAccountIds();
  document.getElementById('account-select').value = ids[0] || '';
  updateCharCount();
  refreshTikTokPanel();
  refreshYouTubePanel();
  updatePostPreview();
}

// --- Live preview (composer side column) ---------------------------------------------------
// One tab per selected channel, each laid out roughly the way that platform shows a post:
// a 16:9 player for YouTube, a 9:16 frame for TikTok, media-first for Instagram/Pinterest,
// and a feed post for everything else. Text past a platform's character limit is
// highlighted, and a platform that needs media it doesn't have yet says so. Media comes
// from the files picked in this session or, when editing, the post's existing media.
let editingMedia = [];
let previewAccountId = null;

document.addEventListener(
  'error',
  (e) => {
    const video = e.target;
    if (!(video instanceof HTMLVideoElement) || !video.closest('#post-dialog')) return;
    const fallback = document.createElement('div');
    fallback.className = video.closest('.media-preview-thumb') ? 'media-thumb-fallback' : 'pv-placeholder';
    fallback.textContent = video.closest('.media-preview-thumb')
      ? 'Video'
      : "This browser can't preview this video format, but it will still upload.";
    if (video.dataset.previewSrc) fallback.dataset.previewSrc = video.dataset.previewSrc;
    video.replaceWith(fallback);
  },
  true
);

function composerMediaItems() {
  return selectedMedia.length
    ? selectedMedia.map((m) => ({ url: m.previewUrl, video: m.file.type.startsWith('video/') }))
    : editingMedia.map((m) => ({ url: m.url, video: m.media_type === 'video' }));
}

function previewMediaEl(item, { controls = true } = {}) {
  return item.video
    ? `<video src="${escapeHtml(item.url)}" data-preview-src="${escapeHtml(item.url)}" muted playsinline preload="metadata"${controls ? ' controls' : ''}></video>`
    : `<img src="${escapeHtml(item.url)}" alt="">`;
}

// Caption with anything past the platform's limit wrapped in <mark>, so it's obvious what
// would be cut.
function previewCaptionHtml(content, limit) {
  if (!limit || content.length <= limit) return escapeHtml(content);
  return `${escapeHtml(content.slice(0, limit))}<mark class="pv-overflow">${escapeHtml(content.slice(limit))}</mark>`;
}

function previewWhenLabel() {
  const value = document.getElementById('scheduled-for-input').value;
  if (!value) return 'Draft';
  return new Date(value).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function previewPlaceholder(message) {
  return `<div class="pv-placeholder">${escapeHtml(message)}</div>`;
}

function renderYouTubePreview(account, content, media) {
  const video = media.find((m) => m.video);
  const title = youtubeEls.title.value.trim();
  const visibility = youtubeEls.privacy.selectedOptions[0];
  return `
    <div class="pv-yt">
      <div class="pv-yt-frame">${video ? previewMediaEl(video) : previewPlaceholder('YouTube needs a video')}</div>
      <p class="pv-yt-title${title ? '' : ' is-empty'}">${escapeHtml(title || 'Add a title in YouTube settings')}</p>
      <div class="pv-head">
        ${accountAvatarHtml(account)}
        <span class="pv-name">${escapeHtml(account.display_name)}</span>
        ${youtubeEls.privacy.value ? `<span class="pv-chip">${escapeHtml(visibility.textContent)}</span>` : ''}
      </div>
      ${content ? `<p class="pv-text pv-clamp">${escapeHtml(content)}</p>` : ''}
    </div>`;
}

function renderTikTokPreview(account, content, media, limit) {
  const video = media.find((m) => m.video);
  return `
    <div class="pv-tt-frame">
      ${video ? previewMediaEl(video, { controls: false }) : previewPlaceholder('TikTok needs a video')}
      <div class="pv-tt-overlay">
        <span class="pv-tt-handle">${escapeHtml(account.display_name)}</span>
        ${content ? `<p class="pv-tt-caption">${previewCaptionHtml(content, limit)}</p>` : ''}
      </div>
    </div>`;
}

function renderMediaFirstPreview(account, content, media, limit, { needs }) {
  const first = media.find((m) => (needs === 'image' ? !m.video : true));
  return `
    <div class="pv-card">
      <div class="pv-head">
        ${accountAvatarHtml(account)}
        <span class="pv-name">${escapeHtml(account.display_name)}</span>
      </div>
      <div class="pv-square">${first ? previewMediaEl(first) : previewPlaceholder(`${platformDisplayName(account.platform)} needs ${needs === 'image' ? 'an image' : 'a photo or video'}`)}</div>
      ${content ? `<p class="pv-text"><strong>${escapeHtml(account.display_name)}</strong> ${previewCaptionHtml(content, limit)}</p>` : ''}
    </div>`;
}

function renderFeedPreview(account, content, media, limit) {
  const shown = media.slice(0, 4);
  const extra = media.length - shown.length;
  return `
    <div class="pv-card">
      <div class="pv-head">
        ${accountAvatarHtml(account)}
        <div class="pv-head-text">
          <span class="pv-name">${escapeHtml(account.display_name)}</span>
          <span class="pv-meta">${escapeHtml(previewWhenLabel())} · ${escapeHtml(platformDisplayName(account.platform))}</span>
        </div>
      </div>
      <p class="pv-text${content ? '' : ' is-empty'}">${content ? previewCaptionHtml(content, limit) : 'Your caption will appear here.'}</p>
      ${
        shown.length
          ? `<div class="pv-grid pv-grid-${shown.length}">${shown
              .map(
                (m, i) =>
                  `<div class="pv-grid-item">${previewMediaEl(m)}${i === shown.length - 1 && extra > 0 ? `<span class="pv-grid-more">+${extra}</span>` : ''}</div>`
              )
              .join('')}</div>`
          : ''
      }
    </div>`;
}

function updatePostPreview() {
  const tabs = document.getElementById('post-preview-tabs');
  const body = document.getElementById('post-preview-body');
  const note = document.getElementById('post-preview-note');

  const ids = selectedAccountIds();
  const accounts = accountsCache.filter((a) => ids.includes(String(a.id)));
  if (accounts.length === 0) {
    tabs.innerHTML = '';
    body.innerHTML = previewPlaceholder('Pick a channel to see a preview');
    note.hidden = true;
    return;
  }
  if (!accounts.some((a) => String(a.id) === previewAccountId)) {
    previewAccountId = String(accounts[0].id);
  }
  const account = accounts.find((a) => String(a.id) === previewAccountId);

  tabs.innerHTML =
    accounts.length > 1
      ? accounts
          .map(
            (a) => `
        <button type="button" class="pv-tab${String(a.id) === previewAccountId ? ' active' : ''}" data-preview-id="${a.id}"
          title="${escapeHtml(a.display_name)}">
          <span class="cal-platform-badge" style="background:${(PLATFORM_META[a.platform] || { color: '#666666' }).color}">${platformBadgeInner(a.platform)}</span>
          <span class="pv-tab-name">${escapeHtml(a.display_name)}</span>
        </button>`
          )
          .join('')
      : '';
  tabs.querySelectorAll('.pv-tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      previewAccountId = btn.dataset.previewId;
      updatePostPreview();
    })
  );

  const content = document.getElementById('post-content').value.trim();
  const media = composerMediaItems();
  const limit = PLATFORM_CHAR_LIMITS[account.platform];

  let html;
  if (account.platform === 'youtube') html = renderYouTubePreview(account, content, media);
  else if (account.platform === 'tiktok') html = renderTikTokPreview(account, content, media, limit);
  else if (account.platform === 'instagram') {
    html = renderMediaFirstPreview(account, content, media, limit, { needs: 'media' });
  } else if (account.platform === 'pinterest') {
    html = renderMediaFirstPreview(account, content, media, limit, { needs: 'image' });
  } else html = renderFeedPreview(account, content, media, limit);

  // The preview re-renders on every keystroke; carry the existing <video> elements (and any
  // "can't preview" fallback that replaced one) across by source, so playback isn't reset and
  // the video isn't reloaded each time.
  const keep = new Map(
    [...body.querySelectorAll('[data-preview-src]')].map((el) => [el.dataset.previewSrc, el])
  );
  body.innerHTML = html;
  body.querySelectorAll('video[data-preview-src]').forEach((el) => {
    const old = keep.get(el.dataset.previewSrc);
    if (old) el.replaceWith(old);
  });

  const over = limit ? content.length - limit : 0;
  note.hidden = over <= 0;
  note.textContent =
    over > 0 ? `${over} character${over === 1 ? '' : 's'} over ${platformDisplayName(account.platform)}'s ${limit} limit.` : '';
}

// --- TikTok panel -------------------------------------------------------------------------
// TikTok's Content Sharing Guidelines require that, before posting, the user sees which
// account they're posting as, picks a privacy level themselves (no default), opts in to
// comments/duets/stitches (all off by default, greyed out when the creator disabled them),
// can disclose commercial content, and sees the music-usage / branded-content consent line.
// The choices travel with the post as tiktok_options (posts.platform_options.tiktok).

const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};
const TIKTOK_MUSIC_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
const TIKTOK_BRANDED_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';

const tiktokEls = {
  panel: document.getElementById('tiktok-panel'),
  creator: document.getElementById('tiktok-creator'),
  status: document.getElementById('tiktok-status'),
  controls: document.getElementById('tiktok-controls'),
  privacy: document.getElementById('tiktok-privacy'),
  comment: document.getElementById('tiktok-allow-comment'),
  duet: document.getElementById('tiktok-allow-duet'),
  stitch: document.getElementById('tiktok-allow-stitch'),
  interactionsNote: document.getElementById('tiktok-interactions-note'),
  disclose: document.getElementById('tiktok-disclose'),
  discloseOptions: document.getElementById('tiktok-disclose-options'),
  brandOrganic: document.getElementById('tiktok-brand-organic'),
  brandContent: document.getElementById('tiktok-brand-content'),
  discloseLabel: document.getElementById('tiktok-disclose-label'),
  durationWarning: document.getElementById('tiktok-duration-warning'),
  consent: document.getElementById('tiktok-consent'),
};

let tiktokAccountId = null;
let tiktokCreator = null;
let tiktokPrefill = null;
let tiktokLoadSeq = 0;

function selectedTikTokAccounts() {
  const ids = selectedAccountIds();
  return accountsCache.filter((a) => a.platform === 'tiktok' && ids.includes(String(a.id)));
}

// Called once per dialog open, before the account is selected, so the panel reloads fresh
// creator_info and (for an edit) re-applies the post's saved choices.
function prepareTikTokPanel(prefill) {
  tiktokAccountId = null;
  tiktokCreator = null;
  tiktokPrefill = prefill || null;
  tiktokEls.panel.hidden = true;
}

function setTikTokStatus(message) {
  tiktokEls.status.hidden = !message;
  tiktokEls.status.textContent = message || '';
  tiktokEls.controls.hidden = Boolean(message);
}

async function refreshTikTokPanel() {
  const accounts = selectedTikTokAccounts();
  if (accounts.length === 0) {
    tiktokEls.panel.hidden = true;
    tiktokAccountId = null;
    tiktokCreator = null;
    updateTikTokState();
    return;
  }
  tiktokEls.panel.hidden = false;
  if (accounts.length > 1) {
    tiktokAccountId = null;
    tiktokCreator = null;
    tiktokEls.creator.textContent = '';
    setTikTokStatus('Pick one TikTok account per post — each account has its own privacy and interaction settings.');
    updateTikTokState();
    return;
  }

  const id = String(accounts[0].id);
  if (id === tiktokAccountId) return;
  tiktokAccountId = id;
  tiktokCreator = null;
  tiktokEls.creator.textContent = '';
  setTikTokStatus('Loading your TikTok settings…');
  updateTikTokState();

  const seq = ++tiktokLoadSeq;
  let info;
  try {
    info = await apiJson(`/api/tiktok/accounts/${id}/creator-info`);
  } catch (err) {
    if (seq !== tiktokLoadSeq) return;
    setTikTokStatus(`TikTok says this account can't post right now: ${err.message}`);
    updateTikTokState();
    return;
  }
  if (seq !== tiktokLoadSeq) return;
  tiktokCreator = info;
  renderTikTokCreator(info);
  setTikTokStatus(info.privacy_level_options.length ? null : "TikTok says this account can't post right now.");
  updateTikTokState();
}

function renderTikTokCreator(info) {
  const name = info.nickname || accountsCache.find((a) => String(a.id) === tiktokAccountId)?.display_name || '';
  tiktokEls.creator.innerHTML = `
    ${info.avatar_url ? `<img src="${escapeHtml(info.avatar_url)}" alt="" class="tiktok-creator-avatar">` : ''}
    <span>Posting as <strong>${escapeHtml(name)}</strong>${info.username ? ` (@${escapeHtml(info.username)})` : ''}</span>
  `;

  tiktokEls.privacy.innerHTML =
    '<option value="">Select privacy level</option>' +
    info.privacy_level_options
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(TIKTOK_PRIVACY_LABELS[p] || p)}</option>`)
      .join('');

  const toggles = [
    [tiktokEls.comment, info.comment_disabled],
    [tiktokEls.duet, info.duet_disabled],
    [tiktokEls.stitch, info.stitch_disabled],
  ];
  for (const [box, disabled] of toggles) {
    box.disabled = disabled;
    box.checked = false;
  }
  tiktokEls.interactionsNote.hidden = !toggles.some(([, disabled]) => disabled);

  const p = tiktokPrefill || {};
  tiktokEls.privacy.value = info.privacy_level_options.includes(p.privacy_level) ? p.privacy_level : '';
  tiktokEls.comment.checked = !info.comment_disabled && !!p.allow_comment;
  tiktokEls.duet.checked = !info.duet_disabled && !!p.allow_duet;
  tiktokEls.stitch.checked = !info.stitch_disabled && !!p.allow_stitch;
  tiktokEls.brandOrganic.checked = !!p.brand_organic;
  tiktokEls.brandContent.checked = !!p.brand_content;
  tiktokEls.disclose.checked = !!(p.brand_organic || p.brand_content);
  tiktokPrefill = null;
}

// Re-derives everything that depends on the current choices: the disclosure label, the
// consent line, "Only me" being unavailable for branded content, and the duration check.
function updateTikTokState() {
  const branded = tiktokEls.disclose.checked && tiktokEls.brandContent.checked;
  const organic = tiktokEls.disclose.checked && tiktokEls.brandOrganic.checked;

  tiktokEls.discloseOptions.hidden = !tiktokEls.disclose.checked;
  if (tiktokEls.disclose.checked && !branded && !organic) {
    tiktokEls.discloseLabel.textContent =
      'You need to indicate if your content promotes yourself, a third party, or both.';
    tiktokEls.discloseLabel.classList.add('is-warning');
  } else {
    tiktokEls.discloseLabel.textContent = branded
      ? "Your video will be labeled as 'Paid partnership'."
      : organic
        ? "Your video will be labeled as 'Promotional content'."
        : '';
    tiktokEls.discloseLabel.classList.remove('is-warning');
  }

  const selfOnly = tiktokEls.privacy.querySelector('option[value="SELF_ONLY"]');
  if (selfOnly) {
    selfOnly.disabled = branded;
    selfOnly.textContent = branded ? 'Only me (not available for branded content)' : TIKTOK_PRIVACY_LABELS.SELF_ONLY;
    if (branded && tiktokEls.privacy.value === 'SELF_ONLY') tiktokEls.privacy.value = '';
  }

  tiktokEls.consent.innerHTML = branded
    ? `By posting, you agree to TikTok's <a href="${TIKTOK_BRANDED_URL}" target="_blank" rel="noopener">Branded Content Policy</a> and <a href="${TIKTOK_MUSIC_URL}" target="_blank" rel="noopener">Music Usage Confirmation</a>.`
    : `By posting, you agree to TikTok's <a href="${TIKTOK_MUSIC_URL}" target="_blank" rel="noopener">Music Usage Confirmation</a>.`;

  const maxSec = tiktokCreator?.max_video_post_duration_sec;
  const tooLong = maxSec ? selectedMedia.find((m) => m.duration && m.duration > maxSec) : null;
  tiktokEls.durationWarning.hidden = !tooLong;
  tiktokEls.durationWarning.textContent = tooLong
    ? `This video is ${Math.round(tooLong.duration)}s long — this TikTok account can post videos up to ${maxSec}s.`
    : '';
  tiktokEls.durationWarning.classList.toggle('is-warning', Boolean(tooLong));

  updateSubmitBlocked();
}

// Why a post can't be *scheduled* for TikTok yet (null if it can). Drafts aren't publishes,
// so they're saved with whatever's been chosen so far.
function tiktokPublishProblem() {
  if (tiktokEls.panel.hidden) return null;
  const scheduling = document.querySelector('.schedule-option.active')?.dataset.mode === 'schedule';
  if (!scheduling) return null;
  if (selectedTikTokAccounts().length > 1) return 'Pick one TikTok account per post.';
  if (!tiktokCreator || !tiktokCreator.privacy_level_options.length) {
    return "Your TikTok settings haven't loaded — TikTok may not allow this account to post right now.";
  }
  if (!tiktokEls.privacy.value) return 'Choose who can view this video on TikTok.';
  if (tiktokEls.disclose.checked && !tiktokEls.brandOrganic.checked && !tiktokEls.brandContent.checked) {
    return 'You need to indicate if your content promotes yourself, a third party, or both.';
  }
  if (!tiktokEls.durationWarning.hidden) return tiktokEls.durationWarning.textContent;
  if (!editingPostId && !selectedMedia.some((m) => m.file.type.startsWith('video/'))) {
    return 'TikTok posts need a video attached.';
  }
  return null;
}

function tiktokOptionsPayload() {
  if (tiktokEls.panel.hidden || !tiktokCreator) return null;
  const disclose = tiktokEls.disclose.checked;
  return {
    ...(tiktokEls.privacy.value ? { privacy_level: tiktokEls.privacy.value } : {}),
    allow_comment: tiktokEls.comment.checked,
    allow_duet: tiktokEls.duet.checked,
    allow_stitch: tiktokEls.stitch.checked,
    brand_organic: disclose && tiktokEls.brandOrganic.checked,
    brand_content: disclose && tiktokEls.brandContent.checked,
  };
}

[
  tiktokEls.privacy,
  tiktokEls.comment,
  tiktokEls.duet,
  tiktokEls.stitch,
  tiktokEls.disclose,
  tiktokEls.brandOrganic,
  tiktokEls.brandContent,
].forEach((el) => el.addEventListener('change', updateTikTokState));

// --- YouTube panel ------------------------------------------------------------------------
// The upload settings YouTube Studio itself asks for: a title, a visibility the user picks
// (no default), and the made-for-kids declaration YouTube requires on every video (COPPA).
// They travel with the post as youtube_options (posts.platform_options.youtube).

const youtubeEls = {
  panel: document.getElementById('youtube-panel'),
  title: document.getElementById('youtube-title'),
  privacy: document.getElementById('youtube-privacy'),
};

let youtubePrefill = null;

function youtubeKidsValue() {
  return document.querySelector('input[name="youtube-kids"]:checked')?.value || '';
}

function preparePlatformPanels(post) {
  prepareTikTokPanel(post?.platform_options?.tiktok);
  youtubePrefill = post?.platform_options?.youtube || null;
  youtubeEls.panel.hidden = true;
}

function refreshYouTubePanel() {
  const ids = selectedAccountIds();
  const show = accountsCache.some((a) => a.platform === 'youtube' && ids.includes(String(a.id)));
  const wasHidden = youtubeEls.panel.hidden;
  youtubeEls.panel.hidden = !show;
  if (show && wasHidden && youtubePrefill) {
    youtubeEls.title.value = youtubePrefill.title || '';
    youtubeEls.privacy.value = youtubePrefill.privacy_status || '';
    const kids = document.querySelector(
      `input[name="youtube-kids"][value="${youtubePrefill.made_for_kids ? 'yes' : 'no'}"]`
    );
    if (kids) kids.checked = true;
    youtubePrefill = null;
  }
  updateSubmitBlocked();
}

// Why a post can't be *scheduled* for YouTube yet (null if it can); drafts save as-is.
function youtubePublishProblem() {
  if (youtubeEls.panel.hidden) return null;
  const scheduling = document.querySelector('.schedule-option.active')?.dataset.mode === 'schedule';
  if (!scheduling) return null;
  const title = youtubeEls.title.value.trim();
  if (!title) return 'Add a title for the YouTube video.';
  if (/[<>]/.test(title)) return "YouTube titles can't contain < or >.";
  if (!youtubeEls.privacy.value) return 'Choose who can see the video on YouTube.';
  if (!youtubeKidsValue()) return 'Tell YouTube whether this video is made for kids.';
  if (!editingPostId && !selectedMedia.some((m) => m.file.type.startsWith('video/'))) {
    return 'YouTube posts need a video attached.';
  }
  return null;
}

function youtubeOptionsPayload() {
  if (youtubeEls.panel.hidden) return null;
  const title = youtubeEls.title.value.trim();
  return {
    ...(title ? { title } : {}),
    ...(youtubeEls.privacy.value ? { privacy_status: youtubeEls.privacy.value } : {}),
    made_for_kids: youtubeKidsValue() === 'yes',
  };
}

[youtubeEls.title, youtubeEls.privacy, ...document.querySelectorAll('input[name="youtube-kids"]')].forEach((el) =>
  el.addEventListener(el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change', () => {
    updateSubmitBlocked();
    updatePostPreview();
  })
);

function platformPublishProblem() {
  return tiktokPublishProblem() || youtubePublishProblem();
}

function updateSubmitBlocked() {
  postDialogSubmitBtn?.classList.toggle('is-blocked', Boolean(platformPublishProblem()));
}

function showTikTokProcessingNote() {
  showToast(
    'Scheduled. Once it publishes, TikTok can take a few minutes to process the video before it shows on your profile.',
    'success'
  );
}

function readVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => resolve(null);
    video.src = URL.createObjectURL(file);
  });
}

// New-post picker is multi-select (cross-posting); the edit dialog locks it to one channel.
function toggleAccount(id) {
  const picker = document.getElementById('account-picker');
  if (picker.classList.contains('locked')) return;
  picker.querySelector(`.account-chip[data-account-id="${id}"]`)?.classList.toggle('selected');
  syncAccountSelection();
}

function selectAccount(id) {
  document.querySelectorAll('#account-picker .account-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.accountId === String(id));
  });
  syncAccountSelection();
}

function updateCharCount() {
  const content = document.getElementById('post-content').value;
  const length = content.length;
  const accountId = document.getElementById('account-select').value;
  const account = accountsCache.find((a) => String(a.id) === String(accountId));
  const limit = account ? PLATFORM_CHAR_LIMITS[account.platform] : null;
  const counter = document.getElementById('char-count');

  if (limit) {
    const remaining = limit - length;
    counter.textContent = `${remaining} characters left`;
    counter.classList.toggle('char-count-warning', remaining < limit * 0.1 && remaining >= 0);
    counter.classList.toggle('char-count-over', remaining < 0);
  } else {
    counter.textContent = `${length} characters`;
    counter.classList.remove('char-count-warning', 'char-count-over');
  }
}

document.getElementById('post-content').addEventListener('input', () => {
  updateCharCount();
  updatePostPreview();
});

const MAX_MEDIA_PER_POST = 10;
const mediaInput = document.getElementById('media-input');
const mediaPreviewGrid = document.getElementById('media-preview-grid');
const mediaUploadLabel = document.getElementById('media-upload-label');

let selectedMedia = [];

function renderMediaPreview() {
  mediaPreviewGrid.innerHTML = selectedMedia
    .map(
      (item, i) => `
    <div class="media-preview-item">
      <div class="media-preview-thumb">
        ${
          item.file.type.startsWith('video/')
            ? `<video src="${item.previewUrl}" muted></video>`
            : `<img src="${item.previewUrl}" alt="">`
        }
        <button type="button" class="media-remove" data-index="${i}" aria-label="Remove">&times;</button>
      </div>
      <input type="text" class="media-alt-input" data-index="${i}" placeholder="Alt text (optional)" value="${escapeHtml(item.altText)}">
    </div>
  `
    )
    .join('');

  mediaPreviewGrid.querySelectorAll('.media-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.index);
      URL.revokeObjectURL(selectedMedia[i].previewUrl);
      selectedMedia.splice(i, 1);
      renderMediaPreview();
    });
  });

  mediaPreviewGrid.querySelectorAll('.media-alt-input').forEach((input) => {
    input.addEventListener('input', () => {
      selectedMedia[Number(input.dataset.index)].altText = input.value;
    });
  });

  mediaUploadLabel.style.display = selectedMedia.length >= MAX_MEDIA_PER_POST ? 'none' : '';
  updateTikTokState();
  updatePostPreview();
}

function resetMediaPreview() {
  selectedMedia.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  selectedMedia = [];
  renderMediaPreview();
}

mediaInput.addEventListener('change', () => {
  const remaining = MAX_MEDIA_PER_POST - selectedMedia.length;
  const files = Array.from(mediaInput.files).slice(0, remaining);
  if (mediaInput.files.length > remaining) {
    showToast(`You can attach up to ${MAX_MEDIA_PER_POST} files per post.`, 'warning');
  }
  for (const file of files) {
    const item = { file, altText: '', previewUrl: URL.createObjectURL(file), duration: null };
    selectedMedia.push(item);
    // Feeds the TikTok panel's max_video_post_duration_sec check once the metadata loads.
    if (file.type.startsWith('video/')) {
      readVideoDuration(file).then((duration) => {
        item.duration = duration;
        updateTikTokState();
      });
    }
  }
  mediaInput.value = '';
  renderMediaPreview();
});

const scheduledForInput = document.getElementById('scheduled-for-input');
const repeatSelect = document.getElementById('repeat-select');
const repeatUntilInput = document.getElementById('repeat-until-input');
const repeatUntilField = document.getElementById('repeat-until-field');
const repeatFields = document.getElementById('repeat-fields');

// --- Schedule picker ----------------------------------------------------------------------
// A date field, a time dropdown in 5-minute steps, and quick picks, in place of a native
// datetime-local, whose popup differs per browser and (in Chrome/Edge) shows only a Cancel
// button, which reads as if the choice can't be confirmed. The chosen moment is mirrored
// into the hidden #scheduled-for-input as a local "YYYY-MM-DDTHH:MM" string, which is what
// the submit handler reads.

const schedulePicker = document.getElementById('schedule-picker');
const scheduleDateInput = document.getElementById('schedule-date');
const scheduleTimeSelect = document.getElementById('schedule-time');
const scheduleSummary = document.getElementById('schedule-summary');
const SCHEDULE_STEP_MINUTES = 5;
const QUICK_PICK_HOUR = 9;

const pad2 = (n) => String(n).padStart(2, '0');
const toDateValue = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const toTimeValue = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

function timeLabel(value) {
  const [h, m] = value.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The 5-minute grid, plus `extra` (an existing post's off-grid time) so editing never
// silently moves it.
function renderTimeOptions(extra) {
  const values = [];
  for (let min = 0; min < 24 * 60; min += SCHEDULE_STEP_MINUTES) {
    values.push(`${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`);
  }
  if (extra && !values.includes(extra)) {
    values.push(extra);
    values.sort();
  }
  scheduleTimeSelect.innerHTML =
    '<option value="">Select time</option>' +
    values.map((v) => `<option value="${v}">${escapeHtml(timeLabel(v))}</option>`).join('');
}

function relativeTime(date) {
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

// Mirrors the visible controls into the hidden value, greys out today's already-past
// times, and spells out the chosen moment so it's unambiguous.
function syncScheduledFor() {
  const date = scheduleDateInput.value;
  const time = scheduleTimeSelect.value;
  scheduledForInput.value = date && time ? `${date}T${time}` : '';
  updatePostPreview();

  const today = toDateValue(new Date());
  const nowTime = toTimeValue(new Date());
  for (const opt of scheduleTimeSelect.options) {
    opt.disabled = Boolean(opt.value) && date === today && opt.value <= nowTime;
  }

  if (!scheduledForInput.value) {
    scheduleSummary.hidden = true;
    return;
  }
  const when = new Date(scheduledForInput.value);
  const past = when.getTime() <= Date.now();
  scheduleSummary.hidden = false;
  scheduleSummary.classList.toggle('is-warning', past);
  scheduleSummary.textContent = past
    ? 'That time has already passed. Pick a later one.'
    : `Publishes ${when.toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })} (${relativeTime(when)}).`;
}

function setScheduledFor(date) {
  const time = date ? toTimeValue(date) : '';
  renderTimeOptions(time);
  scheduleDateInput.value = date ? toDateValue(date) : '';
  scheduleTimeSelect.value = time;
  syncScheduledFor();
}

function quickPickDate(kind) {
  const d = new Date();
  if (kind === 'hour') {
    d.setMinutes(d.getMinutes() + 60, 0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / SCHEDULE_STEP_MINUTES) * SCHEDULE_STEP_MINUTES);
    return d;
  }
  if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1);
  } else if (kind === 'monday') {
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  }
  d.setHours(QUICK_PICK_HOUR, 0, 0, 0);
  return d;
}

const morningLabel = timeLabel(`${pad2(QUICK_PICK_HOUR)}:00`);
document.querySelector('.schedule-quick-btn[data-quick="tomorrow"]').textContent = `Tomorrow, ${morningLabel}`;
document.querySelector('.schedule-quick-btn[data-quick="monday"]').textContent = `Next Monday, ${morningLabel}`;
document.querySelectorAll('.schedule-quick-btn').forEach((btn) => {
  btn.addEventListener('click', () => setScheduledFor(quickPickDate(btn.dataset.quick)));
});
scheduleDateInput.addEventListener('change', syncScheduledFor);
scheduleTimeSelect.addEventListener('change', syncScheduledFor);
renderTimeOptions(null);

function refreshScheduleMin() {
  scheduleDateInput.min = toDateValue(new Date());
  repeatUntilInput.min = toDateValue(new Date());
}

function setScheduleMode(isSchedule) {
  schedulePicker.hidden = !isSchedule;
  repeatFields.hidden = !isSchedule;
  if (isSchedule) {
    refreshScheduleMin();
    syncScheduledFor();
  } else {
    setScheduledFor(null);
    repeatSelect.value = '';
    repeatUntilInput.value = '';
    repeatUntilField.hidden = true;
  }
}

document.querySelectorAll('.schedule-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.schedule-option').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    setScheduleMode(btn.dataset.mode === 'schedule');
    updateTikTokState();
  });
});

repeatSelect.addEventListener('change', () => {
  repeatUntilField.hidden = repeatSelect.value === '';
  if (repeatSelect.value === '') repeatUntilInput.value = '';
});

let draftsCache = [];

function renderDraftsList(posts, { noMatchMessage } = {}) {
  const list = document.getElementById('drafts-list');
  list.innerHTML =
    posts
      .map(
        (p) => `
    <li class="draft-card" data-id="${p.id}" data-content="${escapeHtml(p.content)}">
      <div class="draft-card-top">
        <span class="cal-platform-badge" style="background:${(PLATFORM_META[p.platform] || { color: '#666666' }).color}" title="${escapeHtml(p.platform || '')}">${platformBadgeInner(p.platform)}</span>
        <span class="status status-${p.status}">${p.status}</span>
        ${
          p.media && p.media.length > 0
            ? `<span class="thumb-group">${p.media
                .slice(0, 3)
                .map((m) =>
                  m.media_type === 'video'
                    ? `<video class="thumb" src="${escapeHtml(m.url)}" muted></video>`
                    : `<img class="thumb" src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt_text || '')}">`
                )
                .join('')}${p.media.length > 3 ? `<span class="thumb-more">+${p.media.length - 3}</span>` : ''}</span>`
            : ''
        }
      </div>
      <p class="draft-card-content">${escapeHtml(p.content)}</p>
      <div class="draft-card-footer">
        <span class="draft-card-when">Created ${new Date(p.created_at).toLocaleDateString()}</span>
        <div class="draft-card-actions">
          <button data-id="${p.id}" class="edit-btn">Edit</button>
          <button data-id="${p.id}" class="delete-btn">Delete</button>
        </div>
      </div>
    </li>
  `
      )
      .join('') ||
    `<li class="empty">${noMatchMessage || 'No drafts &mdash; click + New post above to start one.'}</li>`;

  list.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const post = draftsCache.find((p) => String(p.id) === btn.dataset.id);
      if (post) openEditDialog(post);
    });
  });

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener(
      'click',
      withLoading(btn, 'Deleting…', async () => {
        const ok = await confirmDialog('Delete this draft post?', { confirmText: 'Delete' });
        if (!ok) return;
        try {
          await apiJson(`/api/v1/posts/${btn.dataset.id}`, { method: 'DELETE' });
          loadDrafts();
          loadDashboardStats();
          calendar.refetchEvents();
        } catch (err) {
          showToast(err.message);
        }
      })
    );
  });
}

function populateDraftsPlatformFilter(posts) {
  const select = document.getElementById('drafts-platform-filter');
  const current = select.value;
  const platforms = [...new Set(posts.map((p) => p.platform))].sort();
  select.innerHTML =
    '<option value="">All platforms</option>' +
    platforms.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(platformDisplayName(p))}</option>`).join('');
  select.value = platforms.includes(current) ? current : '';
}

function applyDraftsFilter() {
  const search = document.getElementById('drafts-search').value.trim().toLowerCase();
  const platform = document.getElementById('drafts-platform-filter').value;
  const filtered = draftsCache.filter(
    (p) => (!search || p.content.toLowerCase().includes(search)) && (!platform || p.platform === platform)
  );
  renderDraftsList(filtered, { noMatchMessage: draftsCache.length > 0 ? 'No drafts match your search.' : undefined });
}

document.getElementById('drafts-search').addEventListener('input', applyDraftsFilter);
document.getElementById('drafts-platform-filter').addEventListener('change', applyDraftsFilter);

async function loadDrafts() {
  const list = document.getElementById('drafts-list');
  const count = document.getElementById('drafts-count');
  list.innerHTML = '<li class="loading"><span class="spinner"></span> Loading drafts…</li>';
  try {
    const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: 'draft' })}`);
    draftsCache = posts;
    count.hidden = posts.length === 0;
    count.textContent = posts.length;
    populateDraftsPlatformFilter(posts);
    applyDraftsFilter();
  } catch (err) {
    count.hidden = true;
    list.innerHTML = '<li class="empty">Failed to load drafts.</li>';
    showToast(err.message);
  }
}

let editingPostId = null;

function openPostDialog(prefillDate) {
  if (!hasAccounts) {
    showToast('Connect a social account before scheduling a post.', 'warning', '/accounts');
    return;
  }
  editingPostId = null;
  document.getElementById('post-dialog-title').textContent = 'New post';
  document.getElementById('post-dialog-delete').hidden = true;
  document.getElementById('account-picker').classList.remove('locked');
  document.getElementById('crosspost-hint').hidden = false;
  document.getElementById('media-edit-hint').hidden = true;
  mediaUploadLabel.style.display = '';

  const form = document.getElementById('post-dialog-form');
  form.reset();
  preparePlatformPanels(null);

  const defaultAccountId = activeAccountId || accountsCache[0]?.id;
  if (defaultAccountId) {
    selectAccount(defaultAccountId);
  }

  editingMedia = [];
  resetMediaPreview();

  const scheduleMode = prefillDate ? 'schedule' : 'draft';
  document.querySelectorAll('.schedule-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === scheduleMode);
  });
  setScheduleMode(scheduleMode === 'schedule');
  setScheduledFor(prefillDate || null);
  repeatSelect.value = '';
  repeatUntilInput.value = '';
  repeatUntilField.hidden = true;

  updateCharCount();
  updateTikTokState();
  openComposer();
}

function openEditDialog(post) {
  editingPostId = post.id;
  document.getElementById('post-dialog-title').textContent = 'Edit post';
  document.getElementById('post-dialog-delete').hidden = false;

  const form = document.getElementById('post-dialog-form');
  form.reset();
  preparePlatformPanels(post);

  renderAccountPicker();
  selectAccount(post.social_account_id);
  document.getElementById('account-picker').classList.add('locked');
  document.getElementById('crosspost-hint').hidden = true;

  document.getElementById('post-content').value = post.content;

  editingMedia = post.media || [];
  resetMediaPreview();
  mediaUploadLabel.style.display = 'none';
  if (post.media && post.media.length > 0) {
    mediaPreviewGrid.innerHTML = post.media
      .map(
        (m) => `
      <div class="media-preview-item">
        <div class="media-preview-thumb">
          ${
            m.media_type === 'video'
              ? `<video src="${escapeHtml(m.url)}" muted></video>`
              : `<img src="${escapeHtml(m.url)}" alt="${escapeHtml(m.alt_text || '')}">`
          }
        </div>
      </div>
    `
      )
      .join('');
    document.getElementById('media-edit-hint').hidden = false;
  } else {
    mediaPreviewGrid.innerHTML = '<p class="media-empty">No media attached</p>';
    document.getElementById('media-edit-hint').hidden = true;
  }

  const scheduleMode = post.scheduled_for ? 'schedule' : 'draft';
  document.querySelectorAll('.schedule-option').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === scheduleMode);
  });
  setScheduleMode(scheduleMode === 'schedule');
  setScheduledFor(post.scheduled_for ? new Date(post.scheduled_for) : null);
  repeatSelect.value = post.repeat_interval || '';
  repeatUntilField.hidden = !post.repeat_interval;
  repeatUntilInput.value = post.repeat_until ? toDateValue(new Date(post.repeat_until)) : '';

  updateCharCount();
  updateTikTokState();
  openComposer();
}

document.getElementById('new-post-btn').addEventListener('click', () => openPostDialog(null));

document.getElementById('post-dialog-delete').addEventListener(
  'click',
  withLoading(document.getElementById('post-dialog-delete'), 'Deleting…', async () => {
    if (!editingPostId) return;
    const ok = await confirmDialog('Delete this post?', { confirmText: 'Delete' });
    if (!ok) return;
    try {
      await apiJson(`/api/v1/posts/${editingPostId}`, { method: 'DELETE' });
      document.getElementById('post-dialog').close();
      loadDrafts();
      loadFailedBanner();
      loadDashboardStats();
      calendar.refetchEvents();
    } catch (err) {
      showToast(err.message);
    }
  })
);

// --- Unsaved changes -------------------------------------------------------------------------
// Any edit inside the composer marks it dirty; Cancel / × / Escape, a sidebar link, or
// leaving the page then asks before throwing the work away. Saving closes the dialog
// directly (not through requestCloseComposer), so it never prompts.
let composerDirty = false;

function markComposerClean() {
  composerDirty = false;
}

['input', 'change'].forEach((type) =>
  document.getElementById('post-dialog-form').addEventListener(type, () => {
    composerDirty = true;
  })
);
document.getElementById('account-picker').addEventListener('click', () => {
  composerDirty = true;
});
document.querySelectorAll('.schedule-option, .schedule-quick-btn').forEach((b) =>
  b.addEventListener('click', () => {
    composerDirty = true;
  })
);

async function confirmDiscardComposer() {
  if (!composerDirty) return true;
  return confirmDialog(
    editingPostId ? 'Discard your changes to this post?' : 'Discard this post? It hasn\u2019t been saved.',
    { confirmText: 'Discard', cancelText: 'Keep editing' }
  );
}

async function requestCloseComposer() {
  if (await confirmDiscardComposer()) document.getElementById('post-dialog').close();
}

document.getElementById('post-dialog-cancel').addEventListener('click', requestCloseComposer);
document.getElementById('post-dialog-close').addEventListener('click', requestCloseComposer);

// The composer sits beside the sidebar (non-modal), so its links are live while editing.
document.querySelector('.sidebar')?.addEventListener('click', async (e) => {
  const link = e.target.closest('a[href]');
  if (!link || !document.getElementById('post-dialog').open || !composerDirty) return;
  e.preventDefault();
  if (await confirmDiscardComposer()) {
    composerDirty = false;
    window.location.href = link.href;
  }
});

window.addEventListener('beforeunload', (e) => {
  if (document.getElementById('post-dialog').open && composerDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// The composer opens non-modally (show(), not showModal()) so the app sidebar stays visible
// and usable beside it; the dialog itself is laid out over just the main area (see
// dialog#post-dialog.composer in style.css). A non-modal dialog gets no built-in Escape
// handling or page-scroll lock, so both are added here.
function openComposer() {
  const dialog = document.getElementById('post-dialog');
  markComposerClean();
  if (!dialog.open) dialog.show();
  document.body.classList.add('composer-open');
  dialog.querySelector('.composer-body').scrollTop = 0;
}

document.getElementById('post-dialog').addEventListener('close', () => {
  document.body.classList.remove('composer-open');
});

document.getElementById('post-dialog').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.defaultPrevented) {
    e.preventDefault();
    requestCloseComposer();
  }
});

const postDialogForm = document.getElementById('post-dialog-form');
const postDialogSubmitBtn = postDialogForm.querySelector('button[type="submit"]');
postDialogForm.addEventListener(
  'submit',
  withLoading(postDialogSubmitBtn, 'Saving…', async (e) => {
    e.preventDefault();
    const form = e.target;

    const accountIds = selectedAccountIds();
    if (accountIds.length === 0) {
      showToast('Choose at least one channel to post to.');
      return;
    }

    const scheduleMode = document.querySelector('.schedule-option.active')?.dataset.mode;
    const scheduledLocal = scheduleMode === 'schedule' ? scheduledForInput.value : '';
    const repeatInterval = scheduleMode === 'schedule' ? repeatSelect.value : '';
    // "Until" is a date; repeats run through the end of that day.
    const repeatUntilLocal = repeatInterval && repeatUntilInput.value ? `${repeatUntilInput.value}T23:59` : '';

    if (scheduleMode === 'schedule') {
      if (!scheduledLocal) {
        showToast('Pick a date and time to schedule for.');
        return;
      }
      if (new Date(scheduledLocal).getTime() <= Date.now()) {
        showToast('Scheduled time must be in the future.');
        return;
      }
      if (repeatUntilLocal && new Date(repeatUntilLocal).getTime() <= new Date(scheduledLocal).getTime()) {
        showToast('The repeat end date must be after the first post.');
        return;
      }
    }

    const platformProblem = platformPublishProblem();
    if (platformProblem) {
      showToast(platformProblem);
      return;
    }
    const tiktokOptions = tiktokOptionsPayload();
    const youtubeOptions = youtubeOptionsPayload();
    const tiktokScheduled = Boolean(tiktokOptions) && scheduleMode === 'schedule';

    if (editingPostId) {
      const payload = {
        content: form.content.value,
        status: scheduleMode === 'schedule' ? 'scheduled' : 'draft',
        scheduled_for: scheduledLocal ? new Date(scheduledLocal).toISOString() : null,
        repeat_interval: repeatInterval || null,
        repeat_until: repeatUntilLocal ? new Date(repeatUntilLocal).toISOString() : null,
        ...(tiktokOptions ? { tiktok_options: tiktokOptions } : {}),
        ...(youtubeOptions ? { youtube_options: youtubeOptions } : {}),
      };
      try {
        await apiJson(`/api/v1/posts/${editingPostId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (tiktokScheduled) showTikTokProcessingNote();
        document.getElementById('post-dialog').close();
        loadDrafts();
        loadFailedBanner();
        loadDashboardStats();
        calendar.refetchEvents();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const body = new FormData();
    if (accountIds.length > 1) {
      accountIds.forEach((id) => body.append('social_account_ids', id));
    } else {
      body.set('social_account_id', accountIds[0]);
    }
    body.set('content', form.content.value);
    if (scheduledLocal) {
      body.set('scheduled_for', new Date(scheduledLocal).toISOString());
    }
    if (repeatInterval) {
      body.set('repeat_interval', repeatInterval);
      if (repeatUntilLocal) body.set('repeat_until', new Date(repeatUntilLocal).toISOString());
    }
    if (selectedMedia.length > 0) {
      selectedMedia.forEach((item) => body.append('media', item.file));
      body.set('alt_texts', JSON.stringify(selectedMedia.map((item) => item.altText)));
    }
    if (tiktokOptions) {
      body.set('tiktok_options', JSON.stringify(tiktokOptions));
    }
    if (youtubeOptions) {
      body.set('youtube_options', JSON.stringify(youtubeOptions));
    }

    try {
      if (selectedMedia.length > 0) {
        await apiUpload('/api/v1/posts', body, (pct) => {
          postDialogSubmitBtn.textContent = `Uploading… ${pct}%`;
        });
      } else {
        await apiJson('/api/v1/posts', { method: 'POST', body });
      }
      if (tiktokScheduled) showTikTokProcessingNote();
      document.getElementById('post-dialog').close();
      resetMediaPreview();
      loadDrafts();
      loadDashboardStats();
      calendar.refetchEvents();
    } catch (err) {
      showToast(err.message);
    }
  })
);

// A failed post's scheduled_for is already in the past by definition, and the scheduler's
// due-posts query (scheduler.js) is just `status = 'scheduled' AND scheduled_for <= now()` — so
// flipping status back to 'scheduled' with no other change makes it due again on the very next
// per-minute run, with no need to touch scheduled_for at all.
async function retryPost(id) {
  try {
    await apiJson(`/api/v1/posts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'scheduled' }),
    });
    showToast('Post queued for retry.', 'success');
    calendar.refetchEvents();
    loadFailedBanner();
    loadDashboardStats();
  } catch (err) {
    showToast(err.message);
  }
}

const calendar = new FullCalendar.Calendar(document.getElementById('calendar'), {
  initialView: loadSavedCalendarView(),
  headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'dayGridMonth,timeGridWeek',
  },
  editable: true,
  eventStartEditable: true,
  eventDurationEditable: false,
  eventAllow: (dropInfo, draggedEvent) => draggedEvent.extendedProps.status === 'scheduled',
  dayCellClassNames: (arg) => (arg.isPast ? ['fc-day-past'] : []),

  // Lets a draft be dragged from the #drafts-list rail straight onto a date — see the
  // Draggable/eventReceive setup below the calendar definition.
  droppable: true,

  datesSet: (info) => {
    try {
      localStorage.setItem(CALENDAR_VIEW_STORAGE_KEY, info.view.type);
    } catch {
      // storage unavailable (private browsing, blocked site data) — view just won't persist
    }
  },

  loading: (isLoading) => {
    document.getElementById('calendar-loading').style.display = isLoading ? 'flex' : 'none';
  },

  dateClick: (info) => {
    const now = new Date();

    if (info.allDay) {
      const clickedDateOnly = new Date(info.date.getFullYear(), info.date.getMonth(), info.date.getDate());
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (clickedDateOnly < todayOnly) {
        showToast("Can't schedule a post on a day that's already passed.");
        return;
      }
      const date = new Date(info.date);
      date.setHours(9, 0, 0, 0);
      openPostDialog(date);
      return;
    }

    if (info.date.getTime() < now.getTime()) {
      showToast("Can't schedule a post in the past.");
      return;
    }
    openPostDialog(info.date);
  },

  events: async (info, successCallback, failureCallback) => {
    if (activeCalendarStatuses.size === 0) {
      successCallback([]);
      return;
    }
    try {
      // 'posting' (mid-upload) isn't a filter chip of its own: it shows with Scheduled, so a
      // post doesn't vanish from the calendar while the scheduler is publishing it.
      const wanted = new Set(activeCalendarStatuses);
      if (wanted.has('scheduled')) wanted.add('posting');
      const statuses = Array.from(wanted).join(',');
      const posts = await apiJson(`/api/v1/posts${buildPostsQuery({ status: statuses })}`);
      const events = posts
        .filter((p) => p.scheduled_for)
        .map((p) => ({
          id: String(p.id),
          title: p.content.length > 40 ? `${p.content.slice(0, 40)}…` : p.content,
          start: p.scheduled_for,
          classNames: [`cal-status-${p.status}`],
          // Only a still-scheduled post can be dragged to a new time; once it's posted (or
          // failed/canceled) its calendar slot is history, not a plan.
          editable: p.status === 'scheduled',
          extendedProps: {
            status: p.status,
            content: p.content,
            platform: p.platform,
            postedAt: p.posted_at,
            accountName: p.account_display_name,
          },
        }));
      successCallback(events);
    } catch (err) {
      showToast(err.message);
      failureCallback(err);
    }
  },

  eventContent: (arg) => {
    const meta = PLATFORM_META[arg.event.extendedProps.platform] || { label: '?', color: '#666666' };
    const isFailed = arg.event.extendedProps.status === 'failed';
    const isPosted = arg.event.extendedProps.status === 'posted';
    const isPosting = arg.event.extendedProps.status === 'posting';
    const wrapper = document.createElement('div');
    wrapper.className = 'cal-event-content';
    wrapper.innerHTML = `
      <span class="cal-platform-badge" style="background:${meta.color}" title="${escapeHtml(arg.event.extendedProps.platform || '')}">${platformBadgeInner(arg.event.extendedProps.platform)}</span>
      ${arg.timeText ? `<span class="fc-event-time">${escapeHtml(arg.timeText)}</span>` : ''}
      <span class="cal-event-title">${escapeHtml(arg.event.title)}</span>
      ${isPosted ? '<span class="cal-posted-mark" title="Posted" aria-label="Posted">✓</span>' : ''}
      ${isPosting ? '<span class="spinner cal-posting-spinner" title="Publishing now" aria-label="Publishing now"></span>' : ''}
      ${isFailed ? '<button type="button" class="cal-retry-btn" title="Retry this post">↻</button>' : ''}
    `;
    if (isFailed) {
      wrapper.querySelector('.cal-retry-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await confirmDialog('Retry this failed post? It will be sent again on the next scheduling run.', {
          confirmText: 'Retry',
        });
        if (!ok) return;
        retryPost(arg.event.id);
      });
    }
    return { domNodes: [wrapper] };
  },

  eventDrop: async (info) => {
    try {
      await apiJson(`/api/v1/posts/${info.event.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: info.event.start.toISOString() }),
      });
    } catch (err) {
      info.revert();
      showToast(err.message);
    }
  },

  // A draft dropped from #drafts-list lands here — same past-date guards as dateClick, then
  // PATCHes the draft into a scheduled post. The dropped-in placeholder event is always
  // removed afterward: on success, refetchEvents() brings in the real, correctly-styled
  // scheduled event; on failure there's nothing valid to leave behind.
  eventReceive: async (info) => {
    const draftId = info.draggedEl.dataset.id;
    const now = new Date();
    let start = info.event.start;

    if (info.event.allDay) {
      const clickedDateOnly = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (clickedDateOnly < todayOnly) {
        showToast("Can't schedule a post on a day that's already passed.");
        info.event.remove();
        return;
      }
      start = new Date(start);
      start.setHours(9, 0, 0, 0);
    } else if (start.getTime() < now.getTime()) {
      showToast("Can't schedule a post in the past.");
      info.event.remove();
      return;
    }

    try {
      await apiJson(`/api/v1/posts/${draftId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduled_for: start.toISOString(), status: 'scheduled' }),
      });
      showToast('Draft scheduled.', 'success');
      loadDrafts();
      loadDashboardStats();
    } catch (err) {
      showToast(err.message);
    } finally {
      info.event.remove();
      calendar.refetchEvents();
    }
  },

  eventClick: async (info) => {
    const { status, content } = info.event.extendedProps;

    if (status === 'posting') {
      showToast('This post is being published right now.', 'warning');
      return;
    }

    if (status === 'scheduled') {
      try {
        const post = await apiJson(`/api/v1/posts/${info.event.id}`);
        openEditDialog(post);
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    if (status === 'posted') {
      const { postedAt, accountName } = info.event.extendedProps;
      const when = new Date(postedAt || info.event.start).toLocaleString();
      const ok = await confirmDialog(
        `Posted to ${accountName || 'this channel'} on ${when}.\n\n${content}\n\nPublished posts can't be edited. ` +
          'Removing it here only clears it from Postfalcon — it stays live on the platform.',
        { confirmText: 'Remove from Postfalcon', cancelText: 'Close' }
      );
      if (!ok) return;
      try {
        await apiJson(`/api/v1/posts/${info.event.id}`, { method: 'DELETE' });
        info.event.remove();
        loadDashboardStats();
      } catch (err) {
        showToast(err.message);
      }
      return;
    }

    const when = info.event.start.toLocaleString();
    const ok = await confirmDialog(`[${status}] ${content}\n${when}\n\nDelete this post?`, { confirmText: 'Delete' });
    if (!ok) return;
    try {
      await apiJson(`/api/v1/posts/${info.event.id}`, { method: 'DELETE' });
      info.event.remove();
      loadFailedBanner();
      loadDashboardStats();
    } catch (err) {
      showToast(err.message);
    }
  },
});

// Makes every .draft-card in the rail draggable onto the calendar (see droppable/eventReceive
// above). itemSelector is delegated, so this one instance also covers cards re-rendered later
// by loadDrafts()/applyDraftsFilter() — no need to reinitialize it after each render.
new FullCalendar.Draggable(document.getElementById('drafts-list'), {
  itemSelector: '.draft-card',
  eventData: (el) => {
    const content = el.dataset.content || '';
    return { title: content.length > 40 ? `${content.slice(0, 40)}…` : content, duration: '00:30' };
  },
});

calendar.render();
loadAccountOptions();
loadDrafts();
loadFailedBanner();
loadDashboardStats();

// --- Live publishing updates ----------------------------------------------------------------
// The scheduler publishes server-side, so without this the dashboard only reflected a post
// going out after a manual refresh. This polls the scheduled/publishing posts — every 15s
// while one is due within the next couple of minutes or is mid-upload, otherwise every
// minute, and not at all while the tab is hidden. When a post leaves that set (published or
// failed), it refreshes the calendar, stats and failed banner and says what happened.
const LIVE_FAST_MS = 15000;
const LIVE_SLOW_MS = 60000;
const LIVE_DUE_WINDOW_MS = 2 * 60 * 1000;
let liveActive = new Map(); // post id -> status ('scheduled' due soon, or 'posting')
let liveTimer = null;

function accountNameFor(post) {
  return accountsCache.find((a) => a.id === post.social_account_id)?.display_name || 'your channel';
}

async function checkPublishing() {
  clearTimeout(liveTimer);
  if (document.hidden) return;
  try {
    const pending = await apiJson('/api/v1/posts?status=scheduled,posting');
    const now = Date.now();
    const active = new Map(
      pending
        .filter((p) => p.status === 'posting' || new Date(p.scheduled_for).getTime() - now <= LIVE_DUE_WINDOW_MS)
        .map((p) => [p.id, p.status])
    );

    const finished = [...liveActive.keys()].filter((id) => !active.has(id));
    const startedPosting = [...active].some(([id, status]) => status === 'posting' && liveActive.get(id) !== 'posting');

    for (const id of finished) {
      try {
        const post = await apiJson(`/api/v1/posts/${id}`);
        if (post.status === 'posted') {
          showToast(`Published to ${accountNameFor(post)}.`, 'success');
        } else if (post.status === 'failed') {
          showToast(`Couldn't publish to ${accountNameFor(post)}: ${post.error_message || 'unknown error'}`, 'error');
        }
      } catch {
        // deleted meanwhile — nothing to report
      }
    }
    if (finished.length > 0 || startedPosting) {
      calendar.refetchEvents();
      loadDashboardStats();
      loadFailedBanner();
    }
    liveActive = active;
  } catch {
    // transient network error — try again next tick
  }
  liveTimer = setTimeout(checkPublishing, liveActive.size > 0 ? LIVE_FAST_MS : LIVE_SLOW_MS);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkPublishing();
});
// A post just scheduled for the next couple of minutes should switch to fast polling now,
// not after the next slow tick.
document.getElementById('post-dialog').addEventListener('close', () => setTimeout(checkPublishing, 1500));
checkPublishing();
