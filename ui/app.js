'use strict';
// All dynamic text is inserted with textContent. Model output is untrusted and must never reach innerHTML.
const STORE = 'antigravity-bridge-ui-session';
const STATUS = {running: 'Đang chạy', completed: 'Hoàn tất', failed: 'Thất bại', timeout: 'Quá hạn', canceled: 'Đã hủy', unsupported: 'Không hỗ trợ'};
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  tasks: 'M4 6h16M4 12h16M4 18h10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'
};

const state = {
  session: read(), overview: null, selected: null, detail: null, view: 'tasks', logTab: 'stdout',
  open: new Set(), connected: true, loginError: '', busy: false, toast: ''
};
let timer = null;
let lastSignature = '';

function read() { try { return localStorage.getItem(STORE); } catch { return null; } }
function write(value) { try { value ? localStorage.setItem(STORE, value) : localStorage.removeItem(STORE); } catch { /* storage unavailable */ } }

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  return el;
}
function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', ICONS[name]); svg.append(path);
  return svg;
}
function pill(status) { return h('span', {class: `pill ${status}`, text: STATUS[status] || status}); }

function ago(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return 'vừa xong';
  if (seconds < 60) return `${seconds} giây trước`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return `${Math.floor(seconds / 86400)} ngày trước`;
}
function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}p ${s % 60}s`;
}
function bytes(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`; }
function clock(iso) { return iso ? new Date(iso).toLocaleString('vi-VN') : '—'; }
function folder(path) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

async function api(path, options = {}) {
  const response = await fetch(`/ui/api/${path}`, {
    method: options.method || 'GET', cache: 'no-store',
    headers: {...(state.session ? {'X-Bridge-Session': state.session} : {}), ...(options.body ? {'Content-Type': 'application/json'} : {})},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== 'login') { signedOut(); throw new Error('Phiên đã hết hạn'); }
  if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
  return data;
}
function signedOut() { state.session = null; write(null); state.overview = null; state.detail = null; stop(); render(); }
function notify(message) {
  state.toast = message; render();
  setTimeout(() => { if (state.toast === message) { state.toast = ''; render(); } }, 2600);
}

async function login(token) {
  state.busy = true; state.loginError = ''; render();
  try {
    const {session} = await api('login', {method: 'POST', body: {token}});
    state.session = session; write(session); state.busy = false;
    await refresh(); start();
  } catch (error) { state.busy = false; state.loginError = error.message; render(); }
}

async function refresh() {
  try {
    state.overview = await api('overview'); state.connected = true;
    const tasks = state.overview.tasks;
    if (!state.selected || !tasks.some(task => task.task_id === state.selected)) state.selected = tasks[0]?.task_id ?? null;
    if (state.selected) state.detail = await api(`tasks/${state.selected}`).catch(() => null); else state.detail = null;
  } catch (error) { if (state.session) state.connected = false; }
  // Skip identical frames so text selection and scroll position survive polling.
  const view = state.overview && {...state.overview, server: {...state.overview.server, uptime_seconds: 0}};
  const signature = JSON.stringify([view, state.detail, state.connected]);
  if (signature !== lastSignature) { lastSignature = signature; render(); }
}
function start() { stop(); schedule(); }
function stop() { if (timer) clearTimeout(timer); timer = null; }
function schedule() {
  if (!state.session) return;
  const running = state.overview?.tasks.some(task => task.status === 'running');
  timer = setTimeout(async () => { if (!document.hidden) await refresh(); schedule(); }, running ? 1500 : 4000);
}

async function select(id) {
  state.selected = id; state.detail = null; render();
  state.detail = await api(`tasks/${id}`).catch(() => null); render();
  // One-column layout: bring the conversation into view after choosing from the list.
  if (window.matchMedia('(max-width: 1100px)').matches) document.querySelector('.detail')?.scrollIntoView({behavior: 'smooth', block: 'start'});
}
async function cancel(id) {
  if (!confirm('Hủy task này? Các thay đổi file dở dang sẽ được giữ lại, không tự hoàn tác.')) return;
  try { state.detail = await api(`tasks/${id}/cancel`, {method: 'POST'}); notify('Đã hủy task'); await refresh(); } catch (error) { notify(error.message); }
}
async function setDelegation(enabled) {
  try { await api('delegation', {method: 'POST', body: {enabled}}); notify(enabled ? 'Đã bật giao việc cho Antigravity' : 'Đã tắt giao việc cho Antigravity'); await refresh(); }
  catch (error) { notify(error.message); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify('Đã sao chép'); } catch { notify('Không thể sao chép tự động'); }
}

/* ---------- Views ---------- */
function loginView() {
  const input = h('input', {id: 'token', type: 'password', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'Dán token của bridge'});
  const form = h('form', {class: 'login-card', onsubmit: event => { event.preventDefault(); login(input.value.trim()); }},
    h('div', {class: 'brand'}, h('img', {src: '/ui/favicon.svg', alt: ''}), 'Antigravity Bridge'),
    h('h1', {text: 'Đăng nhập'}),
    h('p', {text: 'Giao diện theo dõi phần giao tiếp giữa Codex / Claude Code và Antigravity. Chạy trên máy này.'}),
    h('div', {class: 'field'}, h('label', {for: 'token', text: 'Bridge token'}), input),
    h('div', {class: 'form-error', role: 'alert', text: state.loginError}),
    h('button', {class: 'btn primary', type: 'submit', disabled: state.busy, text: state.busy ? 'Đang kiểm tra…' : 'Vào giao diện'}),
    h('div', {class: 'hint'}, 'Token nằm trong file trên máy chạy bridge:',
      h('code', {text: 'Get-Content .bridge-state/http-token'}), h('code', {text: 'cat .bridge-state/http-token'})));
  return h('div', {class: 'login'}, form);
}

function stat(label, value, sub) {
  return h('div', {class: 'card stat'}, h('div', {class: 'label', text: label}), h('div', {class: 'value'}, value), sub ? h('div', {class: 'sub', text: sub}) : null);
}
function switchControl(enabled, controllable, label) {
  return h('button', {class: 'switch', role: 'switch', 'aria-checked': String(enabled), 'aria-label': label, disabled: !controllable, onclick: () => setDelegation(!enabled)});
}

function statsView(o) {
  const running = o.tasks.filter(task => task.status === 'running').length;
  const ready = o.cli.bridge_status === 'ready';
  const accepting = o.server.accepting_tasks;
  return h('section', {class: 'stats', 'aria-label': 'Tổng quan'},
    stat('Bridge', h('span', {class: `pill ${ready && accepting ? 'ok' : 'bad'}`, text: !accepting ? 'Đang tắt' : ready ? 'Sẵn sàng' : 'CLI chưa hỗ trợ'}), `Hoạt động ${duration(o.server.uptime_seconds * 1000)}`),
    stat('Antigravity CLI', o.cli.version && o.cli.version !== 'unavailable' ? `agy ${o.cli.version}` : 'Không tìm thấy', o.cli.execution_method || 'Chưa thể giao task'),
    stat('Giao việc', [switchControl(o.delegation.enabled, o.delegation.controllable, 'Cho phép giao việc cho Antigravity'),
      h('span', {class: `pill ${o.delegation.enabled ? 'ok' : 'warn'}`, text: o.delegation.enabled ? 'Đang bật' : 'Đã tắt'})], o.delegation.reason || 'Codex / Claude được phép giao task'),
    stat('Task', `${running} đang chạy`, `${o.tasks.length} task gần đây`));
}

function taskList(o) {
  if (!o.tasks.length) return h('div', {class: 'card empty'}, h('strong', {text: 'Chưa có task nào'}), 'Khi Codex hoặc Claude giao việc cho Antigravity, task sẽ hiện ở đây.');
  return h('div', {class: 'task-list', role: 'list'}, o.tasks.map(task => h('button', {
    class: 'task-item', role: 'listitem', 'aria-current': String(task.task_id === state.selected), onclick: () => select(task.task_id)
  }, h('div', {class: 'row'}, pill(task.status), h('span', {class: 'meta', title: clock(task.started_at), text: ago(task.started_at)})),
    h('div', {class: 'title', text: task.title || '(không có nội dung yêu cầu)'}),
    h('div', {class: 'meta mono', text: `${folder(task.workspace)} · ${task.task_id.slice(0, 8)}`}),
    h('div', {class: 'meta', text: task.status === 'running' ? 'Đang xử lý…' : `Mất ${duration(task.duration_ms)}`}))));
}

function details(key, title, ...body) {
  const el = h('details', {open: state.open.has(key)}, h('summary', {text: title}), h('div', {class: 'body'}, body));
  el.addEventListener('toggle', () => { el.open ? state.open.add(key) : state.open.delete(key); });
  return el;
}

function detailView() {
  const d = state.detail;
  if (!d) return h('div', {class: 'card empty'}, state.selected ? 'Đang tải…' : 'Chọn một task để xem nội dung trao đổi.');
  const {task, request, prompt} = d;
  const running = task.status === 'running';
  const head = h('div', {class: 'detail-head'},
    h('div', {}, h('h2', {}, 'Task ', h('span', {class: 'mono', text: task.task_id.slice(0, 8)}), pill(task.status)),
      h('div', {class: 'muted mono', text: task.workspace})),
    running ? h('button', {class: 'btn danger small', onclick: () => cancel(task.task_id), text: 'Hủy task'}) : null);
  const facts = h('dl', {class: 'kv'},
    ...[['Bắt đầu', clock(task.started_at)], ['Kết thúc', clock(task.ended_at)], ['Thời gian', duration(task.duration_ms)],
      ['Giới hạn', request ? `${request.timeout_seconds}s` : '—'], ['Exit code', task.exit_code ?? '—'], ['PID', task.pid ?? '—'],
      ['CLI status', task.cli_status ?? '—']].map(([k, v]) => h('div', {}, h('dt', {text: k}), h('dd', {text: String(v)}))));

  const asked = h('div', {class: 'msg out'},
    h('div', {class: 'msg-head'}, 'Tech Lead (Codex / Claude)', h('span', {class: 'arrow', text: '→'}), 'Antigravity'),
    request ? [h('p', {class: 'text', text: request.task}),
      h('div', {}, h('div', {class: 'msg-head', text: 'Tiêu chí nghiệm thu'}), h('ul', {class: 'crit'}, request.acceptance_criteria.map(c => h('li', {text: c})))),
      request.context ? details('context', 'Ngữ cảnh kèm theo', h('p', {class: 'text', text: request.context})) : null]
      : h('p', {class: 'muted', text: 'Nội dung yêu cầu không còn (task được ghi trước khi giao diện lưu yêu cầu).'}));

  let answer;
  if (running) {
    answer = h('div', {class: 'typing'}, h('span', {class: 'spinner'}), `Antigravity đang xử lý… đã chạy ${duration(Date.now() - Date.parse(task.started_at))}`);
  } else {
    answer = [
      task.final_response ? h('p', {class: 'text', text: task.final_response}) : h('p', {class: 'muted', text: 'Antigravity không trả về phản hồi cuối.'}),
      task.denied_actions.length ? h('div', {}, h('div', {class: 'msg-head', text: 'Thao tác bị từ chối quyền'}),
        h('div', {class: 'chips'}, task.denied_actions.map(a => h('span', {class: 'chip', text: a.display_name || a.action})))) : null,
      task.error ? h('div', {class: 'callout bad', text: task.error}) : null,
      task.status === 'completed' ? h('div', {class: 'callout warn', text: 'CLI báo hoàn tất nhưng chưa được xác minh. Tech Lead cần xem diff thực tế và chạy test.'}) : null
    ];
  }
  const replied = h('div', {class: 'msg in'}, h('div', {class: 'msg-head'}, 'Antigravity', h('span', {class: 'arrow', text: '→'}), 'Tech Lead (Codex / Claude)'), answer);

  const logs = h('div', {},
    h('div', {class: 'tabs', role: 'group', 'aria-label': 'Loại log'}, ['stdout', 'stderr'].map(tab => h('button', {
      'aria-pressed': String(state.logTab === tab), onclick: () => { state.logTab = tab; render(); }, text: `${tab} (${bytes(task[`${tab}_bytes`])})`
    }))),
    task[`${state.logTab}_truncated`] ? h('div', {class: 'callout warn', text: 'Log đã bị cắt vì vượt giới hạn.'}) : null,
    h('pre', {class: 'log', text: task[state.logTab] || '(trống)'}));

  return h('article', {class: 'card detail'}, head, facts, h('div', {class: 'convo'}, asked, replied),
    details('logs', 'Log của tiến trình agy', logs),
    prompt ? details('prompt', 'Prompt đầy đủ gửi tới agy (đã lọc secret)', h('pre', {class: 'log', text: prompt})) : null);
}

function tasksView(o) {
  return [h('div', {class: 'page-head'}, h('div', {}, h('h1', {text: 'Task'}), h('p', {text: 'Nội dung trao đổi giữa Tech Lead và Antigravity.'}))),
    statsView(o), h('div', {class: 'tasks'}, taskList(o), detailView())];
}

function row(label, value) { return h('div', {}, h('dt', {text: label}), h('dd', {text: String(value)})); }
function settingsView(o) {
  const delegation = o.delegation;
  return [h('div', {class: 'page-head'}, h('div', {}, h('h1', {text: 'Cài đặt'}), h('p', {text: 'Trạng thái và giới hạn của bridge. Phần lớn chỉ đọc; chỉnh bằng file cấu hình rồi khởi động lại.'}))),
    h('div', {class: 'settings'},
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Giao việc cho Antigravity'}),
        h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: delegation.enabled ? 'Đang bật' : 'Đã tắt'}),
          h('span', {class: 'muted', text: delegation.enabled ? 'Codex / Claude có thể giao task mới.' : `Task mới bị từ chối. ${delegation.reason || ''}`})),
          switchControl(delegation.enabled, delegation.controllable, 'Cho phép giao việc cho Antigravity')),
        delegation.controllable ? h('p', {text: 'Tắt để buộc Codex / Claude tự làm. Task đang chạy không bị dừng. Có hiệu lực ngay, không cần khởi động lại.'})
          : h('div', {class: 'callout warn', text: 'Đang bị khóa bởi biến môi trường BRIDGE_DELEGATION. Đổi biến rồi khởi động lại server để mở.'})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Kết nối'}),
        h('div', {class: 'copy-row'}, h('code', {text: o.server.mcp_endpoint}), h('button', {class: 'btn small', onclick: () => copy(o.server.mcp_endpoint), text: 'Sao chép'})),
        h('dl', {class: 'rows'}, row('Giao thức', 'MCP Streamable HTTP'), row('Xác thực', 'Bearer token dùng chung'), row('Phiên bản bridge', o.server.version),
          row('Khởi động', clock(o.server.started_at))),
        h('p', {text: 'Chỉ lắng nghe 127.0.0.1. Token không hiển thị ở đây.'})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Antigravity CLI'}),
        h('dl', {class: 'rows'}, row('Trạng thái', o.cli.bridge_status), row('Phiên bản', o.cli.version), row('Đường dẫn', o.cli.executable || '—'),
          row('Cách chạy', o.cli.execution_method || '—')),
        h('p', {text: o.cli.authentication})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Workspace được phép'}),
        o.allowed_workspaces.length ? h('ul', {class: 'path-list'}, o.allowed_workspaces.map(p => h('li', {text: p})))
          : h('div', {class: 'callout warn', text: 'Chưa có workspace nào. Thêm đường dẫn tuyệt đối vào config/workspaces.json rồi khởi động lại.'})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Giới hạn'}),
        h('dl', {class: 'rows'}, row('Timeout tối đa', `${o.limits.max_timeout_seconds ?? '—'}s`), row('Output mỗi luồng', bytes(o.limits.max_output_bytes_per_stream ?? 0)),
          row('Task lưu giữ', o.limits.max_retained_tasks ?? '—'), row('Task song song', o.limits.concurrent_tasks ?? '—'))),
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Lưu ý khi dùng'}), h('ul', {class: 'list'}, o.limitations.map(item => h('li', {text: item})))),
      h('section', {class: 'card panel wide'}, h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: 'Phiên đăng nhập'}), h('span', {class: 'muted', text: 'Hết hạn sau 8 giờ hoặc khi server khởi động lại.'})),
        h('button', {class: 'btn', onclick: async () => { await api('logout', {method: 'POST'}).catch(() => {}); signedOut(); }, text: 'Đăng xuất'}))))];
}

function shell() {
  const o = state.overview;
  const nav = (view, label) => h('button', {'aria-current': state.view === view ? 'page' : null, onclick: () => { state.view = view; render(); }}, icon(view === 'tasks' ? 'tasks' : 'settings'), label);
  const side = h('aside', {class: 'side'}, h('div', {class: 'brand'}, h('img', {src: '/ui/favicon.svg', alt: ''}), h('span', {text: 'Antigravity Bridge'})),
    h('nav', {class: 'nav', 'aria-label': 'Điều hướng'}, nav('tasks', 'Task'), nav('settings', 'Cài đặt')),
    h('div', {class: 'side-foot'}, h('div', {class: 'live', role: 'status'}, h('span', {class: `dot${state.connected ? '' : ' off'}`}), h('span', {text: state.connected ? 'Đang cập nhật trực tiếp' : 'Mất kết nối tới bridge'}))));
  const body = !o ? h('div', {class: 'card empty'}, state.connected ? 'Đang tải…' : 'Không kết nối được tới bridge. Kiểm tra server còn chạy.')
    : state.view === 'tasks' ? tasksView(o) : settingsView(o);
  return h('div', {class: 'shell'}, side, h('main', {class: 'main'}, !state.connected && o ? h('div', {class: 'banner', role: 'alert', text: 'Mất kết nối tới bridge. Dữ liệu bên dưới có thể đã cũ.'}) : null, body));
}

function render() {
  const root = document.getElementById('root');
  const scrolls = [...root.querySelectorAll('.task-list, pre.log')].map(el => el.scrollTop);
  const page = window.scrollY;
  const tokenValue = root.querySelector('#token')?.value;
  root.replaceChildren(state.session ? shell() : loginView());
  const token = root.querySelector('#token');
  if (token) { if (tokenValue) token.value = tokenValue; token.focus(); }
  [...root.querySelectorAll('.task-list, pre.log')].forEach((el, i) => { if (scrolls[i] != null) el.scrollTop = scrolls[i]; });
  window.scrollTo(0, page);
  if (state.toast) root.append(h('div', {class: 'toast', role: 'status', text: state.toast}));
}

render();
if (state.session) refresh().then(start);
