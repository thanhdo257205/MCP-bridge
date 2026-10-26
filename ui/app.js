'use strict';
// All dynamic text is inserted with textContent. Model output is untrusted and must never reach innerHTML.
const STATUS = {queued: 'Đang chờ', running: 'Đang chạy', completed: 'Hoàn tất', failed: 'Thất bại', timeout: 'Quá hạn', canceled: 'Đã hủy', unsupported: 'Không hỗ trợ'};
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  tasks: 'M4 6h16M4 12h16M4 18h10',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9'
};

const FILTERS = [['all', 'Tất cả'], ['active', 'Đang chạy / chờ'], ['completed', 'Hoàn tất'], ['problem', 'Lỗi'], ['canceled', 'Đã hủy']];
const MATCH = {
  all: () => true, active: t => t.status === 'running' || t.status === 'queued', completed: t => t.status === 'completed',
  problem: t => t.status === 'failed' || t.status === 'timeout' || t.status === 'unsupported', canceled: t => t.status === 'canceled'
};
const state = {
  overview: null, selected: null, detail: null, view: 'tasks', logTab: 'stdout',
  open: new Set(), changes: null, connected: true, toast: '', q: '', filter: 'all'
};
let timer = null;
let regions = null; // live containers of the mounted shell; patched in place so selection and scroll survive polling
const signatures = {};

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
function agoEl(iso, className) { return h('span', {class: className, 'data-ago': iso, title: clock(iso), text: ago(iso)}); }
function elapsedEl(iso, prefix = '') { return h('span', {'data-elapsed': iso, 'data-prefix': prefix, text: prefix + duration(Date.now() - Date.parse(iso))}); }
function tick() {
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(el.getAttribute('data-ago'));
  for (const el of document.querySelectorAll('[data-elapsed]')) el.textContent = (el.getAttribute('data-prefix') || '') + duration(Date.now() - Date.parse(el.getAttribute('data-elapsed')));
}
setInterval(tick, 1000);
function bytes(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`; }
function clock(iso) { return iso ? new Date(iso).toLocaleString('vi-VN') : '—'; }
function folder(path) { return path.split(/[\\/]/).filter(Boolean).pop() || path; }

async function api(path, options = {}) {
  const response = await fetch(`/ui/api/${path}`, {
    method: options.method || 'GET', cache: 'no-store',
    headers: options.body ? {'Content-Type': 'application/json'} : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Lỗi ${response.status}`);
  return data;
}
let toastTimer = null;
function notify(message) {
  document.querySelector('.toast')?.remove();
  const el = h('div', {class: 'toast', role: 'status', text: message});
  document.body.append(el);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.remove(), 2600);
}

async function refresh(force) {
  try {
    state.overview = await api('overview'); state.connected = true;
    const tasks = state.overview.tasks;
    if (!state.selected || !tasks.some(task => task.task_id === state.selected)) state.selected = tasks[0]?.task_id ?? null;
    state.detail = state.selected ? await api(`tasks/${state.selected}`).catch(() => null) : null;
  } catch (error) { state.connected = false; }
  if (force || !regions) render(); else patch();
}
function start() { stop(); schedule(); }
function stop() { if (timer) clearTimeout(timer); timer = null; }
function schedule() {
  const busy = state.overview?.tasks.some(task => task.status === 'running' || task.status === 'queued');
  timer = setTimeout(async () => { if (!document.hidden) await refresh(); schedule(); }, busy ? 1500 : 4000);
}

async function select(id) {
  state.selected = id; state.detail = null; patch();
  state.detail = await api(`tasks/${id}`).catch(() => null); patch();
  // One-column layout: bring the conversation into view after choosing from the list.
  if (window.matchMedia('(max-width: 1100px)').matches) document.querySelector('.detail')?.scrollIntoView({behavior: 'smooth', block: 'start'});
}
async function loadChanges(id) {
  state.changes = {task_id: id, loading: true}; patch();
  try { state.changes = {task_id: id, data: await api(`tasks/${id}/changes`)}; }
  catch (error) { state.changes = {task_id: id, error: error.message}; }
  patch();
}
async function cancel(id) {
  if (!confirm('Hủy task này? Các thay đổi file dở dang sẽ được giữ lại, không tự hoàn tác.')) return;
  try { await api(`tasks/${id}/cancel`, {method: 'POST'}); notify('Đã hủy task'); await refresh(); } catch (error) { notify(error.message); }
}
async function setDelegation(enabled) {
  try { await api('delegation', {method: 'POST', body: {enabled}}); notify(enabled ? 'Đã bật giao việc' : 'Đã tắt giao việc'); await refresh(); }
  catch (error) { notify(error.message); }
}
async function shutdownBridge() {
  if (!confirm('Tắt hoàn toàn bridge?\n\nServer sẽ dừng, task đang chạy hoặc đang chờ bị hủy và các tiến trình agent do bridge khởi tạo sẽ bị dọn. Không thể hoàn tác; mở lại bằng agy-mcp-bridge (hoặc npm start trong bản clone).')) return;
  try {
    await api('shutdown', {method: 'POST', body: {confirm: true}});
    stop();
    document.title = 'Bridge đang tắt';
    document.getElementById('root').replaceChildren(h('main', {class: 'main'},
      h('div', {class: 'card empty'}, h('strong', {text: 'Đã gửi lệnh tắt bridge'}),
        'Server đang dừng, task đang chạy bị hủy và tiến trình con đang được dọn. Bạn có thể đóng tab này; mở lại bằng agy-mcp-bridge (hoặc npm start trong bản clone).')));
  } catch (error) { notify(error.message); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify('Đã sao chép'); } catch { notify('Không thể sao chép tự động'); }
}

/* ---------- Views ---------- */
function stat(label, value, sub) {
  return h('div', {class: 'card stat'}, h('div', {class: 'label', text: label}), h('div', {class: 'value'}, value), sub ? h('div', {class: 'sub'}, sub) : null);
}
function switchControl(enabled, controllable, label) {
  return h('button', {class: 'switch', role: 'switch', 'aria-checked': String(enabled), 'aria-label': label, disabled: !controllable, onclick: () => setDelegation(!enabled)});
}

function statsView(o) {
  const count = status => o.tasks.filter(task => task.status === status).length;
  const agents = o.agents || [];
  const enabledAgents = agents.filter(agent => agent.enabled);
  const readyAgents = enabledAgents.filter(agent => agent.available);
  const ready = readyAgents.length > 0;
  const accepting = o.server.accepting_tasks;
  const queued = count('queued');
  return [
    stat('Bridge', h('span', {class: `pill ${ready && accepting ? 'ok' : 'bad'}`, text: !accepting ? 'Đang tắt' : ready ? 'Sẵn sàng' : 'Chưa có agent'}), h('span', {'data-elapsed': o.server.started_at, 'data-prefix': 'Hoạt động ', text: `Hoạt động ${duration(Date.now() - Date.parse(o.server.started_at))}`})),
    stat('Agent', `${readyAgents.length}/${enabledAgents.length} sẵn sàng`, enabledAgents.length
      ? enabledAgents.map(agent => `${agent.label}${agent.available ? '' : ' (không có)'}`).join(' · ')
      : 'Chưa cấu hình agent nào'),
    stat('Giao việc', [switchControl(o.delegation.enabled, o.delegation.controllable, 'Cho phép giao việc cho agent'),
      h('span', {class: `pill ${o.delegation.enabled ? 'ok' : 'warn'}`, text: o.delegation.enabled ? 'Đang bật' : 'Đã tắt'})], o.delegation.reason || 'Tech Lead được phép giao task'),
    stat('Task', `${count('running')} đang chạy`, `${queued ? `${queued} đang chờ · ` : ''}${o.tasks.length} task gần đây`)
  ];
}

function filteredTasks(o) {
  const q = state.q.trim().toLowerCase();
  return o.tasks.filter(task => MATCH[state.filter](task) && (!q || [task.title, task.workspace, task.task_id].some(v => (v || '').toLowerCase().includes(q))));
}
function taskItems(o) {
  if (!o.tasks.length) return [h('div', {class: 'card empty'}, h('strong', {text: 'Chưa có task nào'}), 'Khi Tech Lead giao việc cho một agent, task sẽ hiện ở đây.')];
  const tasks = filteredTasks(o);
  if (!tasks.length) return [h('div', {class: 'empty'}, h('strong', {text: 'Không có task phù hợp'}), 'Thử đổi bộ lọc hoặc từ khóa.')];
  return tasks.map(task => h('button', {
    class: 'task-item', role: 'listitem', 'data-task': task.task_id, 'aria-current': String(task.task_id === state.selected), onclick: () => select(task.task_id)
  }, h('div', {class: 'row'}, pill(task.status), agoEl(task.queued_at || task.started_at, 'meta')),
    h('div', {class: 'title', text: task.title || '(không có nội dung yêu cầu)'}),
    h('div', {class: 'meta mono', text: `${task.agent}${task.isolation === 'worktree' ? ' · worktree' : ''} · ${folder(task.worktree || task.workspace)} · ${task.task_id.slice(0, 8)}`}),
    h('div', {class: 'meta'}, task.status === 'running' ? elapsedEl(task.started_at, 'Đang chạy ') : task.status === 'queued' ? 'Đang xếp hàng…' : `Mất ${duration(task.duration_ms)}`)));
}
function taskCount(o) { return `${filteredTasks(o).length}/${o.tasks.length} task`; }

function details(key, title, ...body) {
  const el = h('details', {open: state.open.has(key)}, h('summary', {text: title}), h('div', {class: 'body'}, body));
  el.addEventListener('toggle', () => { el.open ? state.open.add(key) : state.open.delete(key); });
  return el;
}

const CHANGE_LABEL = {modified: 'Sửa', deleted: 'Xóa', added: 'Thêm', 'type-changed': 'Đổi kiểu'};
function changesBody(task) {
  const c = state.changes && state.changes.task_id === task.task_id ? state.changes : null;
  const refresh = h('button', {class: 'btn small', onclick: () => loadChanges(task.task_id), disabled: Boolean(c && c.loading), text: c && c.data ? 'Làm mới' : 'Xem thay đổi'});
  if (!c) return [h('p', {class: 'muted', text: 'Đọc trạng thái git của workspace, chỉ đọc: chỉ hiện tên file và số dòng, không hiện nội dung file.'}), refresh];
  if (c.loading) return [h('div', {class: 'typing'}, h('span', {class: 'spinner'}), 'Đang đọc thay đổi…')];
  if (c.error) return [h('div', {class: 'callout bad', text: c.error}), refresh];
  const d = c.data;
  if (!d.available) return [h('div', {class: 'callout warn', text: d.reason || 'Không đọc được thay đổi.'}), refresh];
  const rows = [
    ...d.changes.map(item => h('li', {class: 'change-row'}, h('span', {class: `change-kind ${item.status}`, text: CHANGE_LABEL[item.status] || item.status}),
      h('span', {class: 'change-path mono', text: item.path}),
      h('span', {class: 'change-count mono', text: item.added === null ? 'nhị phân' : `+${item.added} −${item.deleted}`}))),
    ...d.untracked.map(item => h('li', {class: 'change-row'}, h('span', {class: 'change-kind untracked', text: 'Mới'}),
      h('span', {class: 'change-path mono', text: item.path}), h('span', {class: 'change-count mono', text: item.bytes === null ? '' : bytes(item.bytes)})))
  ];
  return [
    h('div', {class: 'change-head'}, h('strong', {text: rows.length ? `${d.changes.length} file đã sửa hoặc xóa · ${d.untracked.length} file mới chưa theo dõi` : 'Không có thay đổi nào so với HEAD.'}), refresh),
    h('p', {class: 'muted', text: `So với commit ${d.head ? d.head.slice(0, 8) : '(repo chưa có commit)'}; gồm cả thay đổi đã có từ trước khi task chạy. Chỉ hiện tên file và số dòng, không có nội dung.`}),
    rows.length ? h('ul', {class: 'change-list'}, rows) : null,
    d.truncated ? h('div', {class: 'callout warn', text: 'Chỉ hiện 500 mục đầu tiên của mỗi nhóm.'}) : null
  ];
}
function changesPanel(task) {
  const el = details('changes', 'Thay đổi trong workspace', ...changesBody(task));
  el.addEventListener('toggle', () => { if (el.open && (!state.changes || state.changes.task_id !== task.task_id)) loadChanges(task.task_id); });
  return el;
}

function logTabs(task) {
  return ['stdout', 'stderr'].map(tab => h('button', {
    'aria-pressed': String(state.logTab === tab), onclick: () => { state.logTab = tab; signatures.detail = null; patch(); }, text: `${tab} (${bytes(task[`${tab}_bytes`])})`
  }));
}
function logText(task) { return task[state.logTab] || '(trống)'; }
function scopeBody(task) {
  const scope = task.scope;
  if (!scope) return null;
  if (!scope.checked) return h('div', {class: 'callout warn', text: `Không kiểm tra được phạm vi owns: ${scope.reason || 'lỗi không xác định'}`});
  if (scope.out_of_scope.length) {
    return h('div', {class: 'callout bad', text: `Có ${scope.out_of_scope.length} file ngoài owns (${scope.out_of_scope.join(', ')}). Không tự động merge; Tech Lead phải review.`});
  }
  return h('div', {class: 'callout', text: `${scope.changed} file thay đổi, tất cả nằm trong owns.`});
}

function detailView() {
  const d = state.detail;
  if (!d) return h('div', {class: 'card empty'}, state.selected ? 'Đang tải…' : 'Chọn một task để xem nội dung trao đổi.');
  const {task, request, prompt} = d;
  const running = task.status === 'running';
  const queued = task.status === 'queued';
  const agentName = task.agent || 'agent';
  const head = h('div', {class: 'detail-head'},
    h('div', {}, h('h2', {}, 'Task ', h('span', {class: 'mono', text: task.task_id.slice(0, 8)}), pill(task.status)),
      h('div', {class: 'muted mono', text: task.workspace}),
      task.worktree ? h('div', {class: 'muted mono', text: `worktree: ${task.worktree}`}) : null),
    running || queued ? h('button', {class: 'btn danger small', onclick: () => cancel(task.task_id), text: 'Hủy task'}) : null);
  const facts = h('dl', {class: 'kv'},
    ...[['Agent', agentName], ['Cách ly', task.isolation === 'worktree' ? 'worktree (song song)' : 'tuần tự'],
      ['Nhánh', task.branch || '—'], ['Quyền tự duyệt', task.autonomy || 'auto'],
      ['Gửi lúc', clock(task.queued_at || task.started_at)], ['Bắt đầu chạy', queued ? 'Chưa chạy' : clock(task.started_at)], ['Kết thúc', clock(task.ended_at)],
      ['Thời gian chạy', running ? elapsedEl(task.started_at) : queued ? '—' : duration(task.duration_ms)],
      ['Giới hạn', request ? `${request.timeout_seconds}s` : '—'], ['Exit code', task.exit_code ?? '—'], ['PID', task.pid ?? '—'],
      ['CLI status', task.cli_status ?? '—']].map(([k, v]) => h('div', {}, h('dt', {text: k}), h('dd', {}, typeof v === 'string' || typeof v === 'number' ? String(v) : v))));

  const asker = request?.client ? `Tech Lead · ${request.client}` : 'Tech Lead';
  const asked = h('div', {class: 'msg out'},
    h('div', {class: 'msg-head'}, asker, h('span', {class: 'arrow', text: '→'}), agentName),
    request ? [h('p', {class: 'text', text: request.task}),
      h('div', {}, h('div', {class: 'msg-head', text: 'Tiêu chí nghiệm thu'}), h('ul', {class: 'crit'}, request.acceptance_criteria.map(c => h('li', {text: c})))),
      request.context ? details('context', 'Ngữ cảnh kèm theo', h('p', {class: 'text', text: request.context})) : null]
      : h('p', {class: 'muted', text: 'Nội dung yêu cầu không còn (task được ghi trước khi giao diện lưu yêu cầu).'}));

  let answer;
  if (queued) {
    answer = h('div', {class: 'typing'}, h('span', {class: 'spinner'}), task.isolation === 'worktree'
      ? 'Đang xếp hàng, chờ một slot worktree trống.'
      : 'Đang xếp hàng, chờ task trước kết thúc. Task thường chạy tuần tự.');
  } else if (running) {
    answer = h('div', {class: 'typing'}, h('span', {class: 'spinner'}), elapsedEl(task.started_at, `${agentName} đang xử lý… đã chạy `));
  } else {
    answer = [
      task.final_response ? h('p', {class: 'text', text: task.final_response}) : h('p', {class: 'muted', text: `${agentName} không trả về phản hồi cuối.`}),
      task.denied_actions.length ? h('div', {}, h('div', {class: 'msg-head', text: 'Thao tác bị từ chối quyền'}),
        h('div', {class: 'chips'}, task.denied_actions.map(a => h('span', {class: 'chip', text: a.display_name || a.action})))) : null,
      scopeBody(task),
      task.error ? h('div', {class: 'callout bad', text: task.error}) : null,
      task.status === 'completed' ? h('div', {class: 'callout warn', text: 'CLI báo hoàn tất nhưng chưa được xác minh. Tech Lead cần xem diff thực tế và chạy test.'}) : null
    ];
  }
  const replied = h('div', {class: 'msg in'}, h('div', {class: 'msg-head'}, agentName, h('span', {class: 'arrow', text: '→'}), asker), answer);

  const logs = h('div', {},
    h('div', {class: 'tabs', id: 'log-tabs', role: 'group', 'aria-label': 'Loại log'}, logTabs(task)),
    h('div', {id: 'log-note'}, task[`${state.logTab}_truncated`] ? h('div', {class: 'callout warn', text: 'Log đã bị cắt vì vượt giới hạn.'}) : null),
    h('pre', {class: 'log', id: 'log-pre', text: logText(task)}));

  return h('article', {class: 'card detail'}, head, facts, h('div', {class: 'convo'}, asked, replied),
    changesPanel(task),
    details('logs', `Log của tiến trình ${agentName}`, logs),
    prompt ? details('prompt', 'Prompt đầy đủ gửi tới agy (đã lọc secret)', h('pre', {class: 'log', text: prompt})) : null);
}

/** Output changes while a task runs; update the log in place (unless the user is selecting text in it) instead of rebuilding the conversation. */
function patchLogs() {
  const task = state.detail?.task;
  const pre = document.getElementById('log-pre');
  if (!task || !pre) return;
  const tabs = document.getElementById('log-tabs');
  if (tabs) tabs.replaceChildren(...logTabs(task));
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && pre.contains(selection.anchorNode)) return;
  const text = logText(task);
  if (pre.textContent !== text) { const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = text; if (pinned) pre.scrollTop = pre.scrollHeight; }
  document.getElementById('log-note')?.replaceChildren(...(task[`${state.logTab}_truncated`] ? [h('div', {class: 'callout warn', text: 'Log đã bị cắt vì vượt giới hạn.'})] : []));
}

function row(label, value) { return h('div', {}, h('dt', {text: label}), h('dd', {text: String(value)})); }
function settingsView(o) {
  const delegation = o.delegation;
  return [h('div', {class: 'page-head'}, h('div', {}, h('h1', {text: 'Cài đặt'}), h('p', {text: 'Trạng thái và giới hạn của bridge. Phần lớn chỉ đọc; chỉnh bằng file cấu hình rồi khởi động lại.'}))),
    h('div', {class: 'settings'},
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Giao việc cho agent'}),
        h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: delegation.enabled ? 'Đang bật' : 'Đã tắt'}),
          h('span', {class: 'muted', text: delegation.enabled ? 'Codex / Claude có thể giao task mới.' : `Task mới bị từ chối. ${delegation.reason || ''}`})),
          switchControl(delegation.enabled, delegation.controllable, 'Cho phép giao việc cho Antigravity')),
        delegation.controllable ? h('p', {text: 'Tắt để buộc Codex / Claude tự làm. Task đang chạy hoặc đang chờ không bị dừng, nhưng task đang chờ sẽ bị hủy khi đến lượt. Có hiệu lực ngay, không cần khởi động lại.'})
          : h('div', {class: 'callout warn', text: 'Đang bị khóa bởi biến môi trường BRIDGE_DELEGATION. Đổi biến rồi khởi động lại server để mở.'})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Kết nối'}),
        h('div', {class: 'copy-row'}, h('code', {text: o.server.mcp_endpoint}), h('button', {class: 'btn small', onclick: () => copy(o.server.mcp_endpoint), text: 'Sao chép'})),
        h('dl', {class: 'rows'}, row('Giao thức', 'MCP Streamable HTTP'), row('Xác thực', 'Không — chỉ 127.0.0.1'), row('Phiên bản bridge', o.server.version),
          row('Khởi động', clock(o.server.started_at))),
        h('p', {class: 'callout warn', text: 'Không có xác thực: bất kỳ tiến trình nào chạy trên máy này với cùng user đều có thể điều khiển bridge. Không mở cổng ra ngoài.'})),
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Agent CLI'}),
        h('div', {class: 'agent-list'}, (o.agents || []).length ? (o.agents || []).map(agent => h('div', {class: 'switch-row'},
          h('div', {}, h('strong', {text: `${agent.label} · ${agent.id}`}),
            h('span', {class: 'muted', text: [agent.enabled ? 'đang bật' : 'đã tắt', agent.version || 'không rõ phiên bản', (agent.capabilities || []).join(', ')].filter(Boolean).join(' · ')})),
          h('span', {class: `pill ${agent.enabled && agent.available ? 'ok' : agent.enabled ? 'bad' : 'warn'}`, text: !agent.enabled ? 'Tắt' : agent.available ? 'Sẵn sàng' : 'Không có'}))) : h('p', {class: 'muted', text: 'Chưa có agent nào được cấu hình.'})),
        h('p', {class: 'muted', text: `Agent mặc định: ${o.default_agent || 'không có'}. Thứ tự ưu tiên đặt trong config/workspaces.json.`}),
        (o.agents || []).some(agent => (agent.warnings || []).length) ? h('div', {class: 'callout warn', text: (o.agents || []).flatMap(agent => agent.warnings || []).join(' · ')}) : null),
      h('section', {class: 'card panel'}, h('h2', {text: 'Antigravity CLI'}),
        h('dl', {class: 'rows'}, row('Trạng thái', o.cli.bridge_status), row('Phiên bản', o.cli.version), row('Đường dẫn', o.cli.executable || '—'),
          row('Cách chạy', o.cli.execution_method || '—')),
        h('p', {text: o.cli.authentication})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Workspace được phép'}),
        o.allowed_workspaces.length ? h('ul', {class: 'path-list'}, o.allowed_workspaces.map(p => h('li', {}, p, (o.session_workspaces || []).includes(p) ? h('span', {class: 'tag', text: 'chỉ lần chạy này'}) : null)))
          : h('div', {class: 'callout warn', text: 'Chưa có workspace nào. Thêm đường dẫn tuyệt đối vào config/workspaces.json rồi khởi động lại.'})),
      h('section', {class: 'card panel'}, h('h2', {text: 'Giới hạn'}),
        h('dl', {class: 'rows'}, row('Timeout tối đa', `${o.limits.max_timeout_seconds ?? '—'}s`), row('Output mỗi luồng', bytes(o.limits.max_output_bytes_per_stream ?? 0)),
          row('Task lưu giữ', o.limits.max_retained_tasks ?? '—'), row('Task thường chạy cùng lúc', o.limits.concurrent_normal_tasks ?? 1),
          row('Worktree chạy song song', o.limits.max_parallel_worktrees ?? o.concurrency?.max_parallel_worktrees ?? '—'),
          row('Quyền tự duyệt mặc định', o.default_autonomy ?? 'auto'),
          row('Hàng đợi tối đa', o.limits.max_queued_tasks ?? '—'))),
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Lưu ý khi dùng'}), h('ul', {class: 'list'}, o.limitations.map(item => h('li', {text: item})))),
      h('section', {class: 'card panel wide'}, h('h2', {text: 'Dừng bridge'}),
        h('p', {text: 'Đóng tab không dừng server. Nút này tắt HTTP server, hủy task đang chạy hoặc đang chờ và dọn các tiến trình agent do bridge khởi tạo. Không thể hoàn tác.'}),
        h('button', {class: 'btn danger', onclick: shutdownBridge, text: 'Tắt bridge'})))];
}

/* ---------- Shell: built once per view change, then patched region by region ---------- */
function mount() {
  const nav = (view, label) => h('button', {'aria-current': state.view === view ? 'page' : null, onclick: () => { state.view = view; render(); }}, icon(view === 'tasks' ? 'tasks' : 'settings'), label);
  const live = h('div', {class: 'live', role: 'status'});
  const side = h('aside', {class: 'side'}, h('div', {class: 'brand'}, h('img', {src: '/ui/favicon.svg', alt: ''}), h('span', {text: 'Antigravity Bridge'})),
    h('nav', {class: 'nav', 'aria-label': 'Điều hướng'}, nav('tasks', 'Task'), nav('settings', 'Cài đặt')),
    h('div', {class: 'side-foot'}, live));
  const banner = h('div', {'aria-live': 'polite'});
  const main = h('main', {class: 'main'}, banner);
  regions = {live, banner, main, view: state.view};
  if (state.view === 'tasks') {
    regions.stats = h('section', {class: 'stats', 'aria-label': 'Tổng quan'});
    regions.list = h('div', {class: 'task-list', role: 'list'});
    regions.detail = h('div', {class: 'detail-slot'});
    regions.count = h('span', {class: 'muted', 'aria-live': 'polite'});
    const search = h('input', {type: 'search', class: 'search', placeholder: 'Tìm theo nội dung, thư mục, id…', 'aria-label': 'Tìm task', value: state.q,
      oninput: event => { state.q = event.target.value; patch(); }});
    const chips = h('div', {class: 'filters', role: 'group', 'aria-label': 'Lọc theo trạng thái'}, FILTERS.map(([key, label]) => h('button', {
      class: 'chip-btn', 'data-filter': key, 'aria-pressed': String(state.filter === key), onclick: () => { state.filter = key; for (const b of chips.children) b.setAttribute('aria-pressed', String(b.dataset.filter === key)); patch(); }, text: label})));
    main.append(h('div', {class: 'page-head'}, h('div', {}, h('h1', {text: 'Task'}), h('p', {text: 'Nội dung trao đổi giữa Tech Lead và các agent.'}))),
      regions.stats, h('div', {class: 'tasks'}, h('div', {class: 'list-col'}, h('div', {class: 'list-tools'}, search, chips, regions.count), regions.list), regions.detail));
  } else {
    regions.settings = h('div', {});
    main.append(regions.settings);
  }
  for (const key of Object.keys(signatures)) delete signatures[key];
  return h('div', {class: 'shell'}, side, main);
}

function setRegion(name, key, build) {
  const el = regions[name];
  if (!el || signatures[name] === key) return;
  signatures[name] = key;
  const nodes = build();
  el.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes]));
}
// Volatile fields (live durations, log text) are left out so they never force a rebuild; tickers and patchLogs() keep them fresh.
const stable = task => task.status === 'running' || task.status === 'queued' ? {...task, duration_ms: 0} : task;
function patch() {
  const o = state.overview;
  if (!regions || !o) return;
  setRegion('live', String(state.connected), () => [h('span', {class: `dot${state.connected ? '' : ' off'}`}), h('span', {text: state.connected ? 'Đang cập nhật trực tiếp' : 'Mất kết nối tới bridge'})]);
  setRegion('banner', JSON.stringify([state.connected, o.warnings, o.update]), () => [
    !state.connected ? h('div', {class: 'banner', role: 'alert', text: 'Mất kết nối tới bridge. Dữ liệu bên dưới có thể đã cũ.'}) : null,
    ...(o.warnings || []).map(text => h('div', {class: 'banner warn', role: 'alert', text})),
    o.update ? h('div', {class: 'banner info', role: 'status'}, `Có bản mới ${o.update.package} ${o.update.latest} (đang chạy ${o.update.current}). Dừng server (Ctrl+C) rồi chạy `, h('code', {text: o.update.command})) : null].filter(Boolean));
  if (regions.view === 'tasks') {
    setRegion('stats', JSON.stringify([o.tasks.map(t => [t.task_id, t.status]), o.agents, o.cli, o.delegation, o.server.accepting_tasks]), () => statsView(o));
    setRegion('list', JSON.stringify([state.q, state.filter, state.selected, o.tasks.map(t => stable(t))]), () => taskItems(o));
    regions.count.textContent = taskCount(o);
    const d = state.detail;
    const detailKey = JSON.stringify([state.selected, state.logTab, state.changes, d && {...d, task: {...stable(d.task), stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false}}]);
    const rebuilt = signatures.detail !== detailKey;
    setRegion('detail', detailKey, () => detailView());
    if (!rebuilt) patchLogs();
  } else {
    setRegion('settings', JSON.stringify([o.cli, o.agents, o.default_agent, o.default_autonomy, o.concurrency, o.delegation, o.limits, o.allowed_workspaces, o.session_workspaces, o.server.mcp_endpoint]), () => settingsView(o));
  }
  tick();
}

function render() {
  const root = document.getElementById('root');
  const page = window.scrollY;
  root.replaceChildren(mount());
  if (!state.overview) {
    regions.main.append(h('div', {class: 'card empty'}, state.connected ? 'Đang tải…' : 'Không kết nối được tới bridge. Kiểm tra server còn chạy.'));
  } else patch();
  window.scrollTo(0, page);
}

render();
refresh(true).then(start);
