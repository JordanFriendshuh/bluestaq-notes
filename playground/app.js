// Team Notes playground: a small client for trying the API by hand. Plain browser JavaScript.
// All user text reaches the page through textContent, never innerHTML.

const $ = (id) => document.getElementById(id);

const state = {
  token: sessionStorage.getItem('token'),
  me: null,
  scope: 'all',
  query: '',
  note: null, // the open note as last read from the server
  dirty: false, // title or body edited since the last load or save
  saving: false, // a save is in flight; its own live echo must not look like someone else's edit
  teams: [],
  openTeamId: null,
  socket: null,
};

// ---------- HTTP ----------

class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = error?.code;
    this.error = error;
  }
}

/** Calls the API as the signed-in user; throws ApiError with the server's code on failure. */
async function api(method, path, body, headers = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(state.token && { Authorization: `Bearer ${state.token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) signOut('Your session ended. Sign in again.');
  if (!res.ok) throw new ApiError(res.status, data.error);
  return data;
}

const ifMatch = (version) => ({ 'If-Match': `"${version}"` });

// ---------- Small helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else node[key] = value;
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

let toastTimer;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 3500);
}

/** Runs an action and shows its error as a toast instead of throwing. */
async function attempt(action) {
  try {
    return await action();
  } catch (err) {
    toast(err.message);
    return undefined;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function throttle(fn, ms) {
  let last = 0;
  let timer;
  return (...args) => {
    const wait = last + ms - Date.now();
    clearTimeout(timer);
    if (wait <= 0) {
      last = Date.now();
      fn(...args);
    } else {
      timer = setTimeout(() => {
        last = Date.now();
        fn(...args);
      }, wait);
    }
  };
}

const colors = ['#4f46e5', '#0891b2', '#c026d3', '#ea580c', '#16a34a', '#db2777', '#2563eb'];
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

const ago = (iso) => {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

// ---------- Sign in ----------

let authMode = 'login';

function showAuth(message) {
  $('app').hidden = true;
  $('auth').hidden = false;
  $('auth-error').hidden = !message;
  $('auth-error').textContent = message ?? '';
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('name-field').hidden = authMode !== 'register';
    $('auth-form').querySelector('button[type=submit]').textContent =
      authMode === 'register' ? 'Create account' : 'Sign in';
  });
}

$('auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = { email: form.get('email'), password: form.get('password') };
  if (authMode === 'register')
    body.displayName = form.get('displayName') || body.email.split('@')[0];
  try {
    const { token } = await api('POST', `/auth/${authMode}`, body);
    state.token = token;
    sessionStorage.setItem('token', token);
    await start();
  } catch (err) {
    const detail = err.error?.details?.map((d) => `${d.path}: ${d.message}`).join(', ');
    showAuth(detail || err.message);
  }
});

function signOut(message) {
  state.token = null;
  sessionStorage.removeItem('token');
  state.socket?.close();
  state.socket = null;
  closeNote();
  showAuth(message);
}

$('sign-out').addEventListener('click', () => signOut());

async function start() {
  const { user } = await api('GET', '/me');
  state.me = user;
  $('me').textContent = `${user.displayName} · ${user.email}`;
  $('auth').hidden = true;
  $('app').hidden = false;
  connectSocket();
  await Promise.all([loadNotes(), loadTeams()]);
}

// ---------- Note list and search ----------

async function loadNotes() {
  const params = new URLSearchParams({ scope: state.scope, limit: '100' });
  if (state.query.trim()) params.set('q', state.query.trim());
  const data = await attempt(() => api('GET', `/notes?${params}`));
  if (data) renderNoteList(data.notes);
}

function snippetNode(note) {
  const box = el('div', { class: 'note-sub' });
  if (note.snippet?.length) {
    for (const part of note.snippet) {
      box.append(part.highlight ? el('mark', { text: part.text }) : part.text);
    }
  } else {
    box.textContent = note.body || `${note.items.length} checklist items`;
  }
  return box;
}

function renderNoteList(notes) {
  const list = $('note-list');
  list.replaceChildren(
    ...notes.map((note) =>
      el(
        'li',
        {
          class: note.id === state.note?.id ? 'active' : '',
          onclick: () => openNote(note.id),
        },
        el(
          'div',
          { class: 'note-title' },
          el('span', { text: note.title }),
          el('span', { class: 'badge', text: note.role }),
        ),
        snippetNode(note),
      ),
    ),
  );
  if (!notes.length) {
    list.append(el('li', { class: 'muted', text: state.query ? 'No matches.' : 'No notes yet.' }));
  }
}

const refreshList = debounce(loadNotes, 400);

$('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  refreshList();
});

for (const seg of document.querySelectorAll('.seg')) {
  seg.addEventListener('click', () => {
    state.scope = seg.dataset.scope;
    document.querySelectorAll('.seg').forEach((s) => s.classList.toggle('active', s === seg));
    loadNotes();
  });
}

$('new-note').addEventListener('click', () =>
  attempt(async () => {
    const { note } = await api('POST', '/notes', { title: 'Untitled note', body: '' });
    await loadNotes();
    await openNote(note.id);
    $('title').select();
  }),
);

// ---------- Editor ----------

const canEdit = () => state.note && state.note.role !== 'viewer';

async function openNote(id) {
  const data = await attempt(() => api('GET', `/notes/${id}`));
  if (!data) return;
  if (state.note && state.note.id !== id) send({ type: 'leave', noteId: state.note.id });
  state.note = data.note;
  state.dirty = false;
  send({ type: 'join', noteId: id });
  hideBanner();
  renderEditor();
  document.querySelectorAll('#note-list li').forEach((li) => li.classList.remove('active'));
  loadNotes();
}

function closeNote() {
  if (state.note) send({ type: 'leave', noteId: state.note.id });
  state.note = null;
  $('editor').hidden = true;
  $('empty').hidden = false;
  $('share-panel').hidden = true;
}

function renderEditor() {
  const note = state.note;
  $('empty').hidden = true;
  $('editor').hidden = false;
  $('title').value = note.title;
  $('body').value = note.body;
  $('title').readOnly = $('body').readOnly = !canEdit();
  $('role').textContent = note.role;
  $('share-button').hidden = $('delete-note').hidden = note.role !== 'owner';
  $('add-item').hidden = !canEdit();
  renderMeta();
  renderItems();
  renderPresence([]);
}

function renderMeta() {
  $('version').textContent = `v${state.note.version} · updated ${ago(state.note.updatedAt)}`;
  $('save').disabled = !state.dirty || !canEdit();
  $('save-state').textContent = state.dirty
    ? 'Unsaved changes'
    : canEdit()
      ? 'All changes saved'
      : 'Read only';
}

function markDirty() {
  state.dirty = true;
  renderMeta();
}

$('title').addEventListener('input', markDirty);
$('body').addEventListener('input', markDirty);

async function save(version = state.note.version) {
  const body = { title: $('title').value, body: $('body').value };
  state.saving = true;
  try {
    const { note } = await api('PATCH', `/notes/${state.note.id}`, body, ifMatch(version));
    state.note = { ...note, items: state.note.items };
    state.dirty = false;
    hideBanner();
    renderMeta();
    refreshList();
  } catch (err) {
    if (err.code === 'version_conflict') return showConflict(err.error.current);
    const detail = err.error?.details?.map((d) => `${d.path}: ${d.message}`).join(', ');
    toast(detail || err.message);
  } finally {
    state.saving = false;
  }
}

$('save').addEventListener('click', () => save());
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 's' && state.note) {
    event.preventDefault();
    if (state.dirty) save();
  }
});

/** Someone saved first: offer to keep their version or overwrite it with ours. */
function showConflict(current) {
  showBanner(`Someone else saved v${current.version} while you were editing.`, [
    ['Use theirs', () => applyRemote(current)],
    ['Keep mine', () => save(current.version)],
  ]);
}

function applyRemote(remote) {
  state.note = { ...state.note, ...remote, items: state.note.items };
  state.dirty = false;
  $('title').value = state.note.title;
  $('body').value = state.note.body;
  hideBanner();
  renderMeta();
}

function showBanner(text, actions = []) {
  $('banner').hidden = false;
  $('banner-text').textContent = text;
  $('banner-actions').replaceChildren(
    ...actions.map(([label, onclick]) => el('button', { text: label, onclick })),
  );
}

function hideBanner() {
  $('banner').hidden = true;
}

$('delete-note').addEventListener('click', () =>
  attempt(async () => {
    if (!confirm(`Delete “${state.note.title}”?`)) return;
    await api('DELETE', `/notes/${state.note.id}`);
    closeNote();
    loadNotes();
  }),
);

// ---------- Checklist ----------

function renderItems() {
  const items = state.note.items;
  const editable = canEdit();
  $('items').replaceChildren(
    ...items.map((item, index) => {
      const text = el('input', {
        class: 'text',
        value: item.text,
        readOnly: !editable,
        maxLength: 500,
      });
      text.addEventListener('keydown', (e) => e.key === 'Enter' && text.blur());
      text.addEventListener('blur', () => {
        if (text.value !== item.text && text.value.trim()) updateItem(item, { text: text.value });
      });
      return el(
        'li',
        { class: `item${item.done ? ' done' : ''}` },
        el('input', {
          type: 'checkbox',
          checked: item.done,
          disabled: !editable,
          onchange: (e) => updateItem(item, { done: e.target.checked }),
        }),
        text,
        editable
          ? el(
              'span',
              { class: 'tools' },
              el('button', {
                class: 'ghost',
                title: 'Move up',
                text: '↑',
                disabled: index === 0,
                onclick: () => updateItem(item, { after: index > 1 ? items[index - 2].id : null }),
              }),
              el('button', {
                class: 'ghost',
                title: 'Move down',
                text: '↓',
                disabled: index === items.length - 1,
                onclick: () => updateItem(item, { after: items[index + 1].id }),
              }),
              el('button', {
                class: 'ghost danger',
                title: 'Delete',
                text: '✕',
                onclick: () => deleteItem(item),
              }),
            )
          : null,
      );
    }),
  );
}

async function updateItem(item, change) {
  const path = `/notes/${state.note.id}/items/${item.id}`;
  try {
    const { item: updated } = await api('PATCH', path, change, ifMatch(item.version));
    placeItem(updated, change.after);
  } catch (err) {
    if (err.code !== 'version_conflict') return toast(err.message);
    placeItem(err.error.current);
    toast('That item changed in the meantime; showing the latest. Try again.');
  }
}

async function deleteItem(item) {
  await attempt(() => api('DELETE', `/notes/${state.note.id}/items/${item.id}`));
  removeItem(item.id);
}

$('add-item').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('new-item');
  const text = input.value.trim();
  if (!text) return;
  attempt(async () => {
    const { item } = await api('POST', `/notes/${state.note.id}/items`, { text });
    input.value = '';
    if (!state.note.items.some((i) => i.id === item.id))
      placeItem(item, state.note.items.at(-1)?.id ?? null);
  });
});

/** Puts an item in the open note's list: replaced in place, or moved after `after` (null = top). */
function placeItem(item, after) {
  const items = state.note.items.filter((i) => i.id !== item.id);
  const existing = state.note.items.findIndex((i) => i.id === item.id);
  let index;
  if (after === undefined && existing >= 0) index = existing;
  else if (after === null) index = 0;
  else index = after === undefined ? items.length : items.findIndex((i) => i.id === after) + 1;
  items.splice(index, 0, item);
  state.note.items = items;
  renderItems();
}

function removeItem(id) {
  state.note.items = state.note.items.filter((i) => i.id !== id);
  renderItems();
}

// ---------- Live: WebSocket presence and changes ----------

let reconnectTimer;

function connectSocket() {
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
  );
  state.socket = socket;
  socket.addEventListener('open', () =>
    socket.send(JSON.stringify({ type: 'auth', token: state.token })),
  );
  socket.addEventListener('message', (event) => onLiveMessage(JSON.parse(event.data)));
  socket.addEventListener('close', (event) => {
    $('live').textContent = 'offline';
    $('live').classList.remove('on');
    if (state.socket !== socket || !state.token) return;
    if (event.code === 4401) return signOut('Your session ended. Sign in again.');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 2000);
  });
}

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(message));
}

function onLiveMessage(message) {
  const open = state.note && message.noteId === state.note.id;
  switch (message.type) {
    case 'ready':
      $('live').textContent = 'live';
      $('live').classList.add('on');
      if (state.note) send({ type: 'join', noteId: state.note.id });
      break;
    case 'presence':
      if (open) renderPresence(message.users);
      break;
    case 'note.updated':
      if (!open || state.saving || message.note.version <= state.note.version) break;
      if (state.dirty) {
        showBanner(
          `${nameOf(message.by)} saved v${message.note.version}. Saving yours will ask what to keep.`,
          [['Load theirs', () => applyRemote(message.note)]],
        );
      } else {
        applyRemote(message.note);
      }
      refreshList();
      break;
    case 'item.added':
    case 'item.updated':
      if (open) placeItem(message.item, message.after);
      break;
    case 'item.deleted':
      if (open) removeItem(message.itemId);
      break;
    case 'note.deleted':
      if (open) {
        closeNote();
        toast(`${nameOf(message.by)} deleted that note.`);
      }
      refreshList();
      break;
    case 'access.revoked':
      if (open) {
        closeNote();
        toast('Your access to that note was removed.');
      }
      refreshList();
      break;
    case 'error':
      if (message.code !== 'not_found') toast(`Live: ${message.message}`);
      break;
  }
}

let presentUsers = [];
const nameOf = (userId) =>
  userId === state.me?.id
    ? 'You'
    : (presentUsers.find((u) => u.userId === userId)?.displayName ?? 'Someone');

function renderPresence(users) {
  presentUsers = users;
  $('presence').replaceChildren(
    ...users.map((user) => {
      const you = user.userId === state.me.id;
      const where = user.cursor ? ` · ${user.cursor.field} @ ${user.cursor.head}` : '';
      return el(
        'span',
        {
          class: `person${user.mode === 'editing' ? ' editing' : ''}`,
          title: `${user.displayName}${you ? ' (you)' : ''} is ${user.mode}${where}`,
        },
        el('span', {
          class: 'avatar',
          text: user.displayName.slice(0, 1).toUpperCase(),
          style: `background:${colorFor(user.userId)}`,
        }),
        `${you ? 'You' : user.displayName}${user.mode === 'editing' ? ' ✎' : ''}${where}`,
      );
    }),
  );
}

// Tell the room when we're editing and where the cursor is; throttled under the server's rate limit.
for (const [id, field] of [
  ['title', 'title'],
  ['body', 'body'],
]) {
  const input = $(id);
  input.addEventListener(
    'focus',
    () => canEdit() && send({ type: 'activity', noteId: state.note.id, mode: 'editing' }),
  );
  input.addEventListener(
    'blur',
    () => state.note && send({ type: 'activity', noteId: state.note.id, mode: 'viewing' }),
  );
  const report = throttle(() => {
    if (!state.note || document.activeElement !== input) return;
    send({
      type: 'cursor',
      noteId: state.note.id,
      field,
      anchor: input.selectionStart,
      head: input.selectionEnd,
    });
  }, 150);
  for (const type of ['keyup', 'click', 'select']) input.addEventListener(type, report);
}

// ---------- Sharing ----------

$('share-button').addEventListener('click', async () => {
  $('teams-panel').hidden = true;
  $('share-panel').hidden = false;
  renderShareTargets();
  await loadShares();
});

function renderShareTargets() {
  $('share-target').replaceChildren(
    el('option', { value: 'email', text: 'A person, by email' }),
    ...state.teams.map((team) => el('option', { value: team.id, text: `Team: ${team.name}` })),
  );
  $('share-email').hidden = false;
}

$('share-target').addEventListener(
  'change',
  (e) => ($('share-email').hidden = e.target.value !== 'email'),
);

async function loadShares() {
  const data = await attempt(() => api('GET', `/notes/${state.note.id}/shares`));
  if (!data) return;
  $('shares').replaceChildren(
    ...data.shares.map((share) =>
      el(
        'li',
        {},
        el('span', {
          text: share.user
            ? `${share.user.displayName} (${share.user.email})`
            : `Team ${share.team.name}`,
        }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'badge', text: share.role }),
        el('button', {
          class: 'ghost danger',
          text: 'Remove',
          onclick: () =>
            attempt(async () => {
              await api('DELETE', `/notes/${state.note.id}/shares/${share.id}`);
              await loadShares();
            }),
        }),
      ),
    ),
  );
  if (!data.shares.length)
    $('shares').append(el('li', { class: 'muted', text: 'Only you can see this note.' }));
}

$('share-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const target = $('share-target').value;
  const body = { role: $('share-role').value };
  if (target === 'email') body.userEmail = $('share-email').value;
  else body.teamId = target;
  attempt(async () => {
    await api('PUT', `/notes/${state.note.id}/shares`, body);
    $('share-email').value = '';
    await loadShares();
  });
});

// ---------- Teams ----------

async function loadTeams() {
  const data = await attempt(() => api('GET', '/teams'));
  if (!data) return;
  state.teams = data.teams;
  $('teams').replaceChildren(
    ...data.teams.map((team) =>
      el(
        'li',
        {
          class: `clickable${team.id === state.openTeamId ? ' active' : ''}`,
          onclick: () => openTeam(team.id),
        },
        el('span', { text: team.name }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'badge', text: team.role }),
      ),
    ),
  );
  if (!data.teams.length) $('teams').append(el('li', { class: 'muted', text: 'No teams yet.' }));
}

$('teams-button').addEventListener('click', () => {
  $('share-panel').hidden = true;
  $('teams-panel').hidden = false;
  loadTeams();
});

$('team-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    const { team } = await api('POST', '/teams', { name: $('team-name').value });
    $('team-name').value = '';
    await loadTeams();
    await openTeam(team.id);
  });
});

async function openTeam(id) {
  const data = await attempt(() => api('GET', `/teams/${id}`));
  if (!data) return;
  const { team } = data;
  const owner = team.role === 'owner';
  state.openTeamId = id;
  $('team-detail').hidden = false;
  $('team-title').textContent = team.name;
  $('delete-team').hidden = !owner;
  $('member-form').hidden = !owner;
  $('members').replaceChildren(
    ...team.members.map((member) => {
      const you = member.userId === state.me.id;
      const canRemove = owner || you;
      return el(
        'li',
        {},
        el('span', { text: `${member.displayName}${you ? ' (you)' : ''}` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'badge', text: member.role }),
        canRemove
          ? el('button', {
              class: 'ghost danger',
              text: you ? 'Leave' : 'Remove',
              onclick: () =>
                attempt(async () => {
                  await api('DELETE', `/teams/${id}/members/${member.userId}`);
                  if (you) $('team-detail').hidden = true;
                  else await openTeam(id);
                  await loadTeams();
                }),
            })
          : null,
      );
    }),
  );
  loadTeams();
}

$('member-form').addEventListener('submit', (event) => {
  event.preventDefault();
  attempt(async () => {
    await api('POST', `/teams/${state.openTeamId}/members`, {
      email: $('member-email').value,
      role: $('member-role').value,
    });
    $('member-email').value = '';
    await openTeam(state.openTeamId);
  });
});

$('delete-team').addEventListener('click', () =>
  attempt(async () => {
    if (!confirm('Delete this team? Notes shared with it stop being shared.')) return;
    await api('DELETE', `/teams/${state.openTeamId}`);
    state.openTeamId = null;
    $('team-detail').hidden = true;
    await loadTeams();
  }),
);

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => ($(button.dataset.close).hidden = true));
}

// ---------- Boot ----------

if (state.token) start().catch(() => signOut());
else showAuth();
