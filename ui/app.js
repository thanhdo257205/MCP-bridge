'use strict';
// All dynamic text is inserted with textContent. Model output is untrusted and must never reach innerHTML.
const STATUS = {queued: 'Đang chờ', running: 'Đang chạy', completed: 'Hoàn tất', failed: 'Thất bại', timeout: 'Quá hạn', canceled: 'Đã hủy', unsupported: 'Không hỗ trợ'};
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  tasks: 'M4 6h16M4 12h16M4 18h10',
  usage: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
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
/** What Antigravity has shown while the task runs: output, writes to its log file (when the soft deadline is on), and any extension of the deadline. */
function activityText(activity) {
  if (!activity) return 'Chưa có thông tin hoạt động.';
  const parts = [];
  if (activity.log_updated_at) parts.push(`Log của agy cập nhật ${ago(activity.log_updated_at)} (${bytes(activity.log_bytes ?? 0)})`);
  else if (activity.soft_deadline) parts.push('Log của agy: chưa có dữ liệu');
  parts.push(activity.last_output_at ? `Output cuối ${ago(activity.last_output_at)}` : 'chưa có output từ agy (bình thường ở chế độ print/json: agy chỉ in khi xong)');
  const soft = activity.soft_deadline;
  if (soft) parts.push(soft.extensions ? `đã gia hạn ${soft.extensions} lần vì còn hoạt động; kiểm tra tiếp ${soft.next_check_at ? clock(soft.next_check_at) : '—'}` : `chưa cần gia hạn; kiểm tra lúc ${soft.next_check_at ? clock(soft.next_check_at) : '—'}`);
  return parts.join(' · ');
}
/** Steps agy reported (step progress setting): newest first, each with the raw event (redacted) one click away. */
function stepsBody(activity) {
  const steps = activity?.steps;
  if (!steps) return [h('p', {class: 'muted', text: 'Chưa có bước nào. Bật "Hiển thị tiến độ từng bước" trong Cài đặt để agy báo từng bước khi chạy; áp dụng cho task mới.'})];
  const shown = steps.recent.slice().reverse();
  return [
    h('p', {class: 'muted', text: `Đã nhận ${steps.total} bước${steps.total > steps.recent.length ? ` (hiện ${steps.recent.length} bước gần nhất)` : ''}. Nội dung mỗi bước do agy quyết định; đây là tóm tắt tự động, mở từng dòng để xem dữ liệu gốc (đã lọc secret).`}),
    h('ol', {class: 'steps'}, shown.map(step => h('li', {},
      h('span', {class: 'muted mono', text: `#${step.n} · ${clock(step.at)} · `}), h('span', {text: step.summary}),
      step.raw ? h('details', {}, h('summary', {text: 'dữ liệu gốc'}), h('pre', {class: 'log', text: step.raw})) : null)))
  ];
}
let stepsShown = '';
function patchSteps() {
  const el = document.getElementById('steps-body');
  const steps = state.detail?.activity?.steps;
  const signature = steps ? `${state.selected}:${steps.total}` : `${state.selected}:none`;
  if (!el || stepsShown === signature) return;
  stepsShown = signature;
  el.replaceChildren(...stepsBody(state.detail.activity));
}
function patchActivity() {
  const el = document.getElementById('activity-line');
  const text = el && state.detail?.activity ? activityText(state.detail.activity) : null;
  if (el && text !== null && el.textContent !== text) el.textContent = text;
}
function agoElPrefix(prefix, iso) { return h('span', {}, prefix, agoEl(iso)); }
function elapsedEl(iso, prefix = '') { return h('span', {'data-elapsed': iso, 'data-prefix': prefix, text: prefix + duration(Date.now() - Date.parse(iso))}); }
function tick() {
  for (const bar of document.querySelectorAll('[data-bar-start]')) {
    const ratio = (Date.now() - Date.parse(bar.getAttribute('data-bar-start'))) / Number(bar.getAttribute('data-bar-total'));
    bar.firstChild.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
  }
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
    state.overview = await api(`overview?tz=${new Date().getTimezoneOffset()}`); state.connected = true;
    const tasks = state.overview.tasks;
    if (!state.selected || !tasks.some(task => task.task_id === state.selected)) state.selected = tasks[0]?.task_id ?? null;
    state.detail = state.selected ? await api(`tasks/${state.selected}`).catch(() => null) : null;
  } catch (error) { state.connected = false; }
  if (force || !regions) render(); else patch();
  followChanges();
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
let changesAt = 0;
// `silent` keeps the current list on screen while a running task's changes are refreshed in the background.
async function loadChanges(id, silent) {
  changesAt = Date.now();
  if (!silent) { state.changes = {task_id: id, loading: true}; patch(); }
  try { state.changes = {task_id: id, data: await api(`tasks/${id}/changes`)}; }
  catch (error) { if (!silent) state.changes = {task_id: id, error: error.message}; }
  patch();
}
// While the selected task runs and its changes panel is open, files appearing in the workspace are the most direct sign of progress.
function followChanges() {
  const task = state.detail?.task;
  if (!task || task.status !== 'running' || !state.open.has('changes') || Date.now() - changesAt < 6000) return;
  if (state.changes?.task_id !== task.task_id || state.changes.loading) return;
  void loadChanges(task.task_id, true);
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
async function loadModels() {
  state.modelsLoading = true;
  try { state.models = await api('models'); } catch (error) { state.models = {models: [], current: null, error: error.message}; }
  state.modelsLoading = false; patch();
}
async function setModel(model) {
  try { await api('model', {method: 'POST', body: {model}}); notify(model ? 'Đã đổi model cho các task mới' : 'Đã về model mặc định của Antigravity'); state.models = null; await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
const PERMISSION_LEVELS = [
  {id: 'default', title: 'Mặc định của Antigravity', text: 'Không truyền cờ nào. Quyền do file cài đặt của Antigravity quyết định; việc cần phê duyệt sẽ bị từ chối. An toàn nhất.'},
  {id: 'plan', title: 'Chỉ lập kế hoạch', text: 'Antigravity chỉ lập kế hoạch (--mode plan), không sửa gì.'},
  {id: 'accept-edits', title: 'Tự duyệt sửa file', text: 'Việc sửa file được duyệt tự động (--mode accept-edits). Lệnh vẫn cần quyền.'},
  {id: 'auto', title: 'Tự động', text: 'Chế độ tự động của Antigravity (--mode auto). Nó tự quyết định hành động.'},
  {id: 'full', title: 'Toàn quyền (nguy hiểm)', text: 'Duyệt mọi yêu cầu, gồm chạy lệnh và truy cập cả ngoài thư mục dự án (--dangerously-skip-permissions). Danh sách thư mục được phép KHÔNG ngăn được điều này.'}
];
async function setPermission(level) {
  const risky = level === 'auto' || level === 'full';
  if (risky && !confirm(level === 'full'
    ? 'TOÀN QUYỀN: Antigravity sẽ được tự động duyệt mọi thao tác, gồm chạy lệnh, xóa hoặc sửa file, kể cả ngoài thư mục dự án. Bridge không phải là sandbox. Chỉ bật khi bạn tin tưởng tác vụ và có bản sao lưu (git). Tiếp tục?'
    : 'Chế độ tự động: Antigravity tự quyết định hành động mà không hỏi bạn. Tiếp tục?')) { await refresh(); return; }
  try { await api('permission', {method: 'POST', body: {level, acknowledge_risk: risky}}); notify('Đã đổi quyền cho các task mới'); await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
const EFFORT_LEVELS = [
  {id: 'default', title: 'Mặc định của Antigravity', text: 'Không truyền --effort; Antigravity dùng mức đã cấu hình.'},
  {id: 'low', title: 'Thấp (nhanh nhất)', text: 'Suy luận ít nhất, phản hồi nhanh. Hợp việc nhỏ, rõ ràng.'},
  {id: 'medium', title: 'Vừa', text: 'Cân bằng giữa tốc độ và độ kỹ.'},
  {id: 'high', title: 'Cao', text: 'Suy luận kỹ hơn, chậm hơn.'},
  {id: 'xhigh', title: 'Rất cao', text: 'Rất kỹ, khá chậm.'},
  {id: 'max', title: 'Tối đa (chậm nhất)', text: 'Suy luận sâu nhất, chậm nhất.'}
];
async function setEffort(effort) {
  try { await api('effort', {method: 'POST', body: {effort}}); notify('Đã đổi mức suy luận cho các task mới'); await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
const WAIT_PRESETS = [
  {seconds: 55, title: '55 giây (mặc định)'}, {seconds: 300, title: '5 phút'}, {seconds: 600, title: '10 phút'},
  {seconds: 900, title: '15 phút'}, {seconds: 1800, title: '30 phút'}, {seconds: 3600, title: '60 phút'}
];
async function setWait(seconds) {
  try { await api('wait', {method: 'POST', body: {seconds}}); notify('Đã đổi thời gian chờ mỗi lần gọi. Nhớ đặt thời hạn tool của Codex/Claude cho khớp.'); await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
const SOFT_LIMITS = [{seconds: 1800, title: '30 phút'}, {seconds: 3600, title: '1 giờ'}, {seconds: 7200, title: '2 giờ (mặc định)'}, {seconds: 14400, title: '4 giờ'}, {seconds: 28800, title: '8 giờ'}];
async function setSoftTimeout(enabled, limit_seconds) {
  try {
    await api('soft-timeout', {method: 'POST', body: {enabled, limit_seconds}});
    notify(enabled ? 'Đã bật gia hạn khi Antigravity còn hoạt động (áp dụng cho task mới)' : 'Đã tắt gia hạn; task dừng đúng hạn như trước');
    await refresh();
  } catch (error) { notify(error.message); await refresh(); }
}
const BUDGET_TASK_PRESETS = [null, 50000, 100000, 200000, 500000, 1000000];
const BUDGET_DAY_PRESETS = [null, 200000, 500000, 1000000, 2000000, 5000000];
async function setBudget(body) {
  try { await api(`budget?tz=${new Date().getTimezoneOffset()}`, {method: 'POST', body}); notify('Đã lưu mức token'); await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
async function setProgress(enabled) {
  try { await api('progress', {method: 'POST', body: {enabled}}); notify(enabled ? 'Đã bật tiến độ từng bước (áp dụng cho task mới)' : 'Đã tắt tiến độ từng bước'); await refresh(); }
  catch (error) { notify(error.message); await refresh(); }
}
let usageAt = 0;
/** Usage numbers change only when a task ends, so they are fetched when the page opens and then at most every 15 seconds. */
async function loadUsage(force) {
  if (!force && Date.now() - usageAt < 15000) return;
  usageAt = Date.now();
  try { state.usage = await api(`usage?tz=${new Date().getTimezoneOffset()}`); } catch { /* keep the numbers already shown */ }
  patch();
}
const USAGE_LABELS = {input_tokens: 'Token vào', output_tokens: 'Token ra', total_tokens: 'Tổng token', cached_tokens: 'Token từ bộ nhớ đệm', cache_read_tokens: 'Token đọc từ bộ nhớ đệm', reasoning_tokens: 'Token suy luận', thinking_tokens: 'Token suy luận', prompt_tokens: 'Token vào', completion_tokens: 'Token ra'};
const usageName = key => USAGE_LABELS[key] ? `${USAGE_LABELS[key]} (${key})` : key;
const number = value => Number(value).toLocaleString('vi-VN', {maximumFractionDigits: 2});
const usageLine = usage => usage && Object.keys(usage).length ? Object.entries(usage).map(([key, value]) => `${key} ${number(value)}`).join(' · ') : null;
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
    stat('Token hôm nay', [number(o.budget?.today_tokens ?? 0), o.budget?.day_tokens ? h('span', {class: `pill ${o.budget.over_day ? 'bad' : 'ok'}`, text: o.budget.over_day ? 'Vượt mức' : 'Trong mức'}) : null],
      o.budget?.day_tokens ? `mức ngày ${number(o.budget.day_tokens)}${o.budget.over_day ? ' — đã vượt' : ''}` : 'chưa đặt mức ngày (Cài đặt)'),
    stat('Task', `${count('running')} đang chạy`, `${queued ? `${queued} đang chờ · ` : ''}${o.tasks.length} task gần đây`)
  ];
}

function filteredTasks(o) {
  const q = state.q.trim().toLowerCase();
  return o.tasks.filter(task => MATCH[state.filter](task) && (!q || [task.title, task.workspace, task.task_id].some(v => (v || '').toLowerCase().includes(q))));
}
const overTask = (o, task) => Boolean(o.budget?.task_tokens) && task.tokens !== null && task.tokens !== undefined && task.tokens > o.budget.task_tokens;
function taskItems(o) {
  if (!o.tasks.length) return [h('div', {class: 'card empty'}, h('strong', {text: 'Chưa có task nào'}), 'Khi Tech Lead giao việc cho một agent, task sẽ hiện ở đây.')];
  const tasks = filteredTasks(o);
  if (!tasks.length) return [h('div', {class: 'empty'}, h('strong', {text: 'Không có task phù hợp'}), 'Thử đổi bộ lọc hoặc từ khóa.')];
  return tasks.map(task => h('button', {
    class: 'task-item', role: 'listitem', 'data-task': task.task_id, 'aria-current': String(task.task_id === state.selected), onclick: () => select(task.task_id)
  }, h('div', {class: 'row'}, pill(task.status), agoEl(task.queued_at || task.started_at, 'meta')),
    h('div', {class: 'title', text: task.title || '(không có nội dung yêu cầu)'}),
    h('div', {class: 'meta mono', text: `${task.agent}${task.isolation === 'worktree' ? ' · worktree' : ''} · ${folder(task.worktree || task.workspace)} · ${task.task_id.slice(0, 8)}`}),
    h('div', {class: 'meta'}, task.status === 'running' ? elapsedEl(task.started_at, 'Đang chạy ') : task.status === 'queued' ? 'Đang xếp hàng…' : `Mất ${duration(task.duration_ms)}`,
      task.tokens !== null && task.tokens !== undefined ? h('span', {class: overTask(o, task) ? 'over-budget' : '', text: ` · ${number(task.tokens)} token${overTask(o, task) ? ' (vượt mức)' : ''}`}) : null)));
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

/**
 * What the bridge did with the processes the agent left behind. Absent while the task runs and while the release
 * query is still open, so a missing line is not a failure to clean up.
 */
function cleanupBody(task) {
  const c = task.cleanup;
  if (!c) return null;
  if (!c.checked) return h('div', {class: 'callout warn', text: `Không kiểm tra được cây tiến trình agent: ${c.reason || 'lỗi không xác định'}`});
  const parts = [c.reaped.length ? `đã giải phóng ${c.reaped.length} cây tiến trình (${c.reaped.join(', ')})` : 'không còn cây tiến trình nào cần dọn'];
  if (c.skipped.length) parts.push(`${c.skipped.length} nhánh vẫn chạy: ${c.skipped.map(s => `${s.pid} — ${s.guard}`).join('; ')}`);
  if (typeof c.tracked === 'number') parts.push(`đã ghi danh ${c.tracked} tiến trình trong lúc agent chạy`);
  if (c.group_signalled === true) parts.push('đã gửi tín hiệu tới cả nhóm tiến trình');
  return h('div', {class: c.skipped.length ? 'callout warn' : 'callout', text: `Tiến trình agent để lại: ${parts.join(' · ')}`});
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
  const activity = state.detail?.activity;
  const progress = running ? h('div', {class: 'progress', 'aria-label': 'Tiến độ'},
    h('div', {class: 'bar', 'data-bar-start': task.started_at, 'data-bar-total': String((request?.timeout_seconds ?? 300) * 1000), role: 'presentation'}, h('span', {})),
    h('div', {class: 'muted'}, elapsedEl(task.started_at, 'Đã chạy '), ` / giới hạn ${request?.timeout_seconds ?? '—'}s`),
    h('div', {class: 'muted', id: 'activity-line'}, activityText(activity))) : null;
  const facts = h('dl', {class: 'kv'},
    ...[['Agent', agentName], ['Cách ly', task.isolation === 'worktree' ? 'worktree (song song)' : 'tuần tự'],
      ['Nhánh', task.branch || '—'], ['Quyền tự duyệt', task.autonomy || 'auto'],
      ['Gửi lúc', clock(task.queued_at || task.started_at)], ['Bắt đầu chạy', queued ? 'Chưa chạy' : clock(task.started_at)], ['Kết thúc', clock(task.ended_at)],
      ['Thời gian chạy', running ? elapsedEl(task.started_at) : queued ? '—' : duration(task.duration_ms)],
      ['Giới hạn', request ? `${request.timeout_seconds}s` : '—'], ['Model', request && 'model' in request ? request.model || 'mặc định' : '—'], ['Quyền', request && request.permission ? (PERMISSION_LEVELS.find(l => l.id === request.permission)?.title || request.permission) : '—'], ['Effort', request && request.effort ? request.effort : '—'], ['Tổng token', state.detail?.stats?.usage && 'total_tokens' in state.detail.stats.usage ? number(state.detail.stats.usage.total_tokens) : '—'], ['Usage (agy báo)', usageLine(state.detail?.stats?.usage) ?? '—'], ['Exit code', task.exit_code ?? '—'], ['PID', task.pid ?? '—'],
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
      cleanupBody(task),
      task.error ? h('div', {class: 'callout bad', text: task.error}) : null,
      task.status === 'completed' ? h('div', {class: 'callout warn', text: 'CLI báo hoàn tất nhưng chưa được xác minh. Tech Lead cần xem diff thực tế và chạy test.'}) : null
    ];
  }
  const replied = h('div', {class: 'msg in'}, h('div', {class: 'msg-head'}, agentName, h('span', {class: 'arrow', text: '→'}), asker), answer);

  const logs = h('div', {},
    h('div', {class: 'tabs', id: 'log-tabs', role: 'group', 'aria-label': 'Loại log'}, logTabs(task)),
    h('div', {id: 'log-note'}, task[`${state.logTab}_truncated`] ? h('div', {class: 'callout warn', text: 'Log đã bị cắt vì vượt giới hạn.'}) : null),
    h('pre', {class: 'log', id: 'log-pre', text: logText(task)}));

  return h('article', {class: 'card detail'}, head, progress, facts, h('div', {class: 'convo'}, asked, replied),
    changesPanel(task),
    details('steps', `Các bước ${agentName} báo cáo`, h('div', {id: 'steps-body'}, stepsBody(state.detail?.activity))),
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
function modelCard(o) {
  const loaded = state.models;
  const known = (loaded?.models || []).some(m => m.id === o.model);
  const select = h('select', {class: 'select', 'aria-label': 'Model cho task mới', disabled: !loaded || Boolean(loaded.error), onchange: event => setModel(event.target.value || null)},
    h('option', {value: '', text: 'Mặc định của Antigravity'}),
    ...(loaded?.models || []).map(m => h('option', {value: m.id, text: `${m.label} (${m.id})`})),
    o.model && !known ? h('option', {value: o.model, text: `${o.model} (không còn trong danh sách)`}) : null);
  select.value = o.model || '';
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Model'}),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: o.model || 'Mặc định của Antigravity'}),
      h('span', {class: 'muted', text: o.model ? 'Bridge truyền --model này cho mọi task mới.' : 'Bridge không truyền --model; Antigravity tự dùng model đã cấu hình.'})), select),
    loaded?.error ? h('div', {class: 'callout warn', text: `Không lấy được danh sách model: ${loaded.error}`}) : null,
    h('p', {text: 'Áp dụng cho task mới, không cần khởi động lại. Task đang chạy hoặc đang chờ giữ model đã chốt lúc nhận. Danh sách lấy từ `agy models`; model được ghi lại trong từng task.'}));
}
function progressCard(o) {
  const enabled = Boolean(o.progress?.enabled);
  const toggle = h('input', {type: 'checkbox', checked: enabled, 'aria-label': 'Hiển thị tiến độ từng bước', onchange: event => setProgress(event.target.checked)});
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Hiển thị tiến độ từng bước (stream-json)'}),
    h('label', {class: 'perm-row' + (enabled ? ' on' : '')}, toggle,
      h('span', {}, h('strong', {text: enabled ? 'Đang bật' : 'Đang tắt'}),
        h('span', {class: 'muted', text: 'Bridge chạy agy với --output-format stream-json: ngoài kết quả cuối, agy báo các sự kiện init và step_update khi đang làm việc (đã thấy bằng probe-stream trên agy 1.4.x). Các bước hiện trong chi tiết task, và là bằng chứng "còn sống" thật cho phần gia hạn. Áp dụng cho task mới, không cần khởi động lại.'}))),
    h('div', {class: 'callout warn', text: 'Chưa kiểm chứng: nội dung chi tiết bên trong step_update (nên hiển thị là tóm tắt tự động kèm dữ liệu gốc), và việc kết quả cuối ở chế độ này có cùng dạng với chế độ JSON. Nếu task báo lỗi "CLI output is not a valid stream-json final result" hoặc "stream result fields", hãy tắt tùy chọn này để quay về chế độ JSON đã kiểm chứng và gửi tôi thông báo lỗi.'}));
}
function budgetCard(o) {
  const budget = o.budget || {task_tokens: null, day_tokens: null, today_tokens: 0};
  const chooser = (key, presets, label) => {
    const options = presets.includes(budget[key]) ? presets : [...presets, budget[key]];
    const select = h('select', {class: 'select', 'aria-label': label, onchange: event => setBudget({[key]: event.target.value === '' ? null : Number(event.target.value)})},
      ...options.map(value => h('option', {value: value === null ? '' : String(value), text: value === null ? 'Không giới hạn' : `${number(value)} token`})));
    select.value = budget[key] === null ? '' : String(budget[key]);
    return select;
  };
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Mức token (đèn cảnh báo)'}),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: 'Mỗi task'}), h('span', {class: 'muted', text: 'Task nào dùng nhiều hơn mức này sẽ được đánh dấu "vượt mức" trong danh sách.'})), chooser('task_tokens', BUDGET_TASK_PRESETS, 'Mức token mỗi task')),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: 'Mỗi ngày'}), h('span', {class: 'muted', text: `Hôm nay đã dùng ${number(budget.today_tokens)} token qua bridge${budget.over_day ? ' — đã vượt mức.' : '.'}`})), chooser('day_tokens', BUDGET_DAY_PRESETS, 'Mức token mỗi ngày')),
    h('div', {class: 'callout warn', text: 'Đây chỉ là đèn báo, không phải hạn mức thật và không dừng task: agy không cho bridge đọc hạn mức, và số token của một task chỉ biết khi task kết thúc. Số liệu là tổng token (total_tokens) agy báo cho các task chạy qua bridge, tính theo ngày giờ máy của bạn.'}));
}
function softTimeoutCard(o) {
  const soft = o.soft_timeout || {enabled: false, limit_seconds: 7200};
  const known = SOFT_LIMITS.some(l => l.seconds === soft.limit_seconds);
  const toggle = h('input', {type: 'checkbox', checked: soft.enabled, 'aria-label': 'Gia hạn khi Antigravity còn hoạt động', onchange: event => setSoftTimeout(event.target.checked, soft.limit_seconds)});
  const select = h('select', {class: 'select', 'aria-label': 'Giới hạn tuyệt đối', onchange: event => setSoftTimeout(soft.enabled, Number(event.target.value))},
    ...SOFT_LIMITS.map(l => h('option', {value: String(l.seconds), text: l.title})),
    known ? null : h('option', {value: String(soft.limit_seconds), text: `${soft.limit_seconds} giây`}));
  select.value = String(soft.limit_seconds);
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Gia hạn khi Antigravity còn hoạt động'}),
    h('label', {class: 'perm-row' + (soft.enabled ? ' on' : '')}, toggle,
      h('span', {}, h('strong', {text: soft.enabled ? 'Đang bật' : 'Đang tắt (task dừng đúng hạn)'}),
        h('span', {class: 'muted', text: 'Đến hạn của task, bridge không dừng ngay mà kiểm tra xem agy còn hoạt động không (có byte mới ở output, hoặc file log của agy vừa được ghi). Nếu còn thì gia hạn rồi kiểm tra lại sau 1 phút, rồi 5 phút, rồi mỗi 10 phút; nếu không thấy hoạt động trong khoảng đó thì dừng task. Khi bật, bridge yêu cầu agy ghi log vào .bridge-state/agy-logs.'}))),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: 'Giới hạn tuyệt đối'}), h('span', {class: 'muted', text: 'Dù còn hoạt động, task vẫn dừng khi tổng thời gian chạy tới mức này.'})), select),
    h('div', {class: 'callout warn', text: 'Chưa kiểm chứng: tôi chưa biết agy có ghi log trong lúc suy luận ở chế độ --print. Bật rồi giao một task và xem dòng "Log của agy cập nhật…" trong chi tiết task: nếu số KB tăng khi agy đang chạy thì tín hiệu này dùng được. Nếu log không tăng, task sẽ dừng đúng hạn như khi tắt tính năng (không tệ hơn).'}));
}
function waitCard(o) {
  const wait = o.wait || {seconds: 55, client_tool_timeout_seconds: 115};
  const known = WAIT_PRESETS.some(p => p.seconds === wait.seconds);
  const select = h('select', {class: 'select', 'aria-label': 'Thời gian chờ tối đa mỗi lần gọi', onchange: event => setWait(Number(event.target.value))},
    ...WAIT_PRESETS.map(p => h('option', {value: String(p.seconds), text: p.title})),
    known ? null : h('option', {value: String(wait.seconds), text: `${wait.seconds} giây (từ file cấu hình)`}));
  select.value = String(wait.seconds);
  const minutes = Math.round(wait.client_tool_timeout_seconds / 60);
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Thời gian chờ mỗi lần Codex / Claude gọi (tiết kiệm token)'}),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: `${wait.seconds} giây`}),
      h('span', {class: 'muted', text: 'Khi giao task, Codex gọi chờ và bị giữ lại trong một lệnh duy nhất cho đến khi Antigravity xong hoặc hết thời gian này. Trong lúc bị giữ, Codex không tốn token. Càng dài càng ít lần hỏi lại.'})), select),
    h('div', {class: 'callout warn'}, `Phải đặt thời hạn tool của client LỚN HƠN mức này, nếu không client sẽ cắt lần chờ và báo timeout. Với mức hiện tại: Codex, trong ~/.codex/config.toml mục [mcp_servers.antigravity] đặt `, h('code', {text: `tool_timeout_sec = ${wait.client_tool_timeout_seconds}`}), ` (khoảng ${minutes} phút), rồi mở lại Codex. Claude Code: biến môi trường MCP_TOOL_TIMEOUT (mili giây) lớn hơn ${wait.seconds * 1000}, theo tài liệu của Claude Code (chưa kiểm chứng ở đây). Lệnh \`agy-mcp-bridge setup codex\` in sẵn dòng này theo mức đang chọn.`),
    h('p', {text: 'Có hiệu lực ngay cho lần chờ sau, không cần khởi động lại bridge. Nếu bạn chưa chắc về thời hạn tool của client, giữ mức 55 giây.'}));
}
function effortCard(o) {
  const current = EFFORT_LEVELS.find(level => level.id === (o.effort || 'default')) || EFFORT_LEVELS[0];
  const select = h('select', {class: 'select', 'aria-label': 'Mức suy luận cho task mới', onchange: event => setEffort(event.target.value)},
    EFFORT_LEVELS.map(level => h('option', {value: level.id, text: level.title})));
  select.value = current.id;
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Mức suy luận (effort)'}),
    h('div', {class: 'switch-row'}, h('div', {}, h('strong', {text: current.title}), h('span', {class: 'muted', text: current.text})), select),
    h('p', {text: 'Truyền --effort cho Antigravity. Mức thấp giúp task nhanh hơn nhưng suy luận ít hơn. Áp dụng cho task mới, không cần khởi động lại; mỗi task ghi lại mức đã dùng. Chưa kiểm chứng với agy thật ở chế độ --print.'}));
}
function permissionCard(o) {
  const p = o.permission || {level: 'default', controllable: true};
  return h('section', {class: 'card panel wide'}, h('h2', {text: 'Quyền của Antigravity'}),
    h('p', {text: 'Mức quyền Antigravity có khi làm task. Chỉ bạn đổi được ở đây; Codex / Claude không đổi được. Áp dụng cho task mới, không cần khởi động lại. Hạ mức xuống thì áp dụng cả cho task đang chờ; nâng mức lên thì không.'}),
    h('div', {class: 'perm-list', role: 'radiogroup', 'aria-label': 'Quyền của Antigravity'}, PERMISSION_LEVELS.map(level =>
      h('label', {class: `perm-row${level.id === 'full' ? ' danger' : ''}${p.level === level.id ? ' on' : ''}`},
        h('input', {type: 'radio', name: 'perm', value: level.id, checked: p.level === level.id, disabled: !p.controllable, onchange: () => setPermission(level.id)}),
        h('span', {}, h('strong', {text: level.title}), h('span', {class: 'muted', text: level.text}))))),
    p.controllable ? null : h('div', {class: 'callout warn', text: `Đang bị khóa bởi biến môi trường BRIDGE_AGY_PERMISSIONS${p.reason && p.reason !== 'BRIDGE_AGY_PERMISSIONS' ? ` (${p.reason})` : ''}. Đổi biến rồi khởi động lại server để mở.`}),
    h('div', {class: 'callout warn', text: 'Danh sách "Workspace được phép" chỉ kiểm tra đường dẫn của task, không phải sandbox. Với mức Tự động hoặc Toàn quyền, Antigravity có thể tác động ra ngoài thư mục đó.'}));
}
function usageView(u) {
  const head = h('div', {class: 'page-head'}, h('div', {}, h('h1', {text: 'Sử dụng'}), h('p', {text: 'Số liệu bridge ghi lại từ các task đã chạy qua nó.'})),
    h('button', {class: 'btn small', onclick: () => loadUsage(true), text: 'Làm mới'}));
  if (!u) return [head, h('div', {class: 'card empty', text: 'Đang tải…'})];
  const t = u.totals;
  const status = Object.entries(t.by_status).map(([key, count]) => `${STATUS[key] || key} ${count}`).join(' · ');
  const cards = h('section', {class: 'stats', 'aria-label': 'Tổng quan sử dụng'},
    stat('Task đã chạy', number(t.tasks), t.tasks ? `${number(t.completed)} hoàn tất · ${status}` : 'chưa có task nào'),
    stat('Thời gian chạy', duration(t.duration_ms), 'tổng, do bridge đo'),
    stat('Thời gian agy báo', t.agy_duration_seconds ? duration(t.agy_duration_seconds * 1000) : '—', 'tổng duration_seconds của agy'),
    stat('Số lượt / bước', `${number(t.turns)} / ${number(t.steps)}`, 'num_turns / bước báo cáo'));
  const callout = h('div', {class: 'callout warn', text: `Đây là mức dùng qua bridge${u.since ? ` kể từ ${clock(u.since)}` : ''} (nhật ký lưu qua các lần khởi động lại), không phải hạn mức. Hạn mức còn lại không có nguồn từ agy nên bridge không hiển thị; xem trên tài khoản Antigravity của bạn.`});
  const sums = Object.entries(t.usage);
  const usageCard = h('section', {class: 'card panel wide'}, h('h2', {text: 'Usage do agy báo'}),
    sums.length ? [h('dl', {class: 'rows'}, sums.map(([key, value]) => row(usageName(key), number(value)))),
        h('p', {class: 'muted', text: `Cộng dồn từ ${number(t.with_usage)} task có trường usage trong kết quả của agy. Tên trường do agy quyết định; bridge cộng mọi giá trị số.`})]
      : h('p', {class: 'muted', text: 'Chưa có task nào mà kết quả của agy kèm số liệu usage. Với task chạy ở chế độ JSON hoặc stream, nếu agy trả trường usage thì tổng sẽ hiện ở đây.'}));
  const peak = Math.max(1, ...u.by_day.map(d => d.tasks));
  const bars = h('div', {class: 'bars'}, u.by_day.map(d => {
    const fill = h('div', {class: 'bar-fill'}); fill.style.width = `${(d.tasks / peak * 100).toFixed(1)}%`;
    return h('div', {class: 'bar-row'}, h('span', {class: 'muted mono', text: `${d.day.slice(8)}/${d.day.slice(5, 7)}`}), h('div', {class: 'bar-track'}, fill),
      h('span', {class: 'mono', text: d.tasks ? `${d.tasks} · ${duration(d.duration_ms)}` : '0'}));
  }));
  const dayCard = h('section', {class: 'card panel wide'}, h('h2', {text: '14 ngày gần nhất'}), bars);
  const groupTable = (title, groups, firstColumn) => h('section', {class: 'card panel wide'}, h('h2', {text: title}),
    groups.length ? h('table', {class: 'usage-table'}, h('thead', {}, h('tr', {}, ...[firstColumn, 'Task', 'Hoàn tất', 'Thời gian', 'Usage'].map(c => h('th', {text: c})))),
      h('tbody', {}, groups.map(g => h('tr', {}, h('td', {class: 'mono', text: g.key}), h('td', {text: number(g.tasks)}), h('td', {text: number(g.completed)}), h('td', {text: duration(g.duration_ms)}), h('td', {class: 'muted', text: usageLine(g.usage) ?? '—'})))))
      : h('p', {class: 'muted', text: 'Chưa có dữ liệu.'}));
  const recent = h('section', {class: 'card panel wide'}, h('h2', {text: 'Task gần nhất'}),
    u.recent.length ? h('ul', {class: 'path-list'}, u.recent.map(r => h('li', {}, `${clock(r.at)} · ${STATUS[r.status] || r.status} · ${r.model || 'model mặc định'} · effort ${r.effort || 'mặc định'} · ${duration(r.duration_ms)}`,
      usageLine(r.usage) ? h('span', {class: 'tag', text: usageLine(r.usage)}) : null))) : h('p', {class: 'muted', text: 'Chưa có task nào.'}));
  return [head, callout, cards, usageCard, dayCard, groupTable('Theo model', u.by_model, 'Model'), groupTable('Theo mức suy luận', u.by_effort, 'Effort'), recent];
}
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
      modelCard(o),
      effortCard(o),
      waitCard(o),
      progressCard(o),
      budgetCard(o),
      softTimeoutCard(o),
      permissionCard(o),
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
  const nav = (view, label) => h('button', {'aria-current': state.view === view ? 'page' : null, onclick: () => { state.view = view; render(); }}, icon(view === 'tasks' ? 'tasks' : view === 'usage' ? 'usage' : 'settings'), label);
  const live = h('div', {class: 'live', role: 'status'});
  const side = h('aside', {class: 'side'}, h('div', {class: 'brand'}, h('img', {src: '/ui/favicon.svg', alt: ''}), h('span', {text: 'Antigravity Bridge'})),
    h('nav', {class: 'nav', 'aria-label': 'Điều hướng'}, nav('tasks', 'Task'), nav('usage', 'Sử dụng'), nav('settings', 'Cài đặt')),
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
  } else if (state.view === 'usage') {
    regions.usage = h('div', {});
    main.append(regions.usage);
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
  setRegion('banner', JSON.stringify([state.connected, o.warnings, o.update, o.permission?.level]), () => [
    !state.connected ? h('div', {class: 'banner', role: 'alert', text: 'Mất kết nối tới bridge. Dữ liệu bên dưới có thể đã cũ.'}) : null,
    ...(o.warnings || []).map(text => h('div', {class: 'banner warn', role: 'alert', text})),
    o.permission && (o.permission.level === 'full' || o.permission.level === 'auto') ? h('div', {class: 'banner warn', role: 'alert', text: o.permission.level === 'full' ? 'Antigravity đang ở mức TOÀN QUYỀN: mọi thao tác được tự duyệt, kể cả ngoài thư mục dự án. Đổi lại ở Cài đặt.' : 'Antigravity đang ở chế độ Tự động: nó tự quyết định hành động. Đổi lại ở Cài đặt.'}) : null,
    o.update ? h('div', {class: 'banner info', role: 'status'}, `Có bản mới ${o.update.package} ${o.update.latest} (đang chạy ${o.update.current}). Dừng server (Ctrl+C) rồi chạy `, h('code', {text: o.update.command})) : null].filter(Boolean));
  if (regions.view === 'tasks') {
    setRegion('stats', JSON.stringify([o.tasks.map(t => [t.task_id, t.status]), o.agents, o.budget, o.cli, o.delegation, o.server.accepting_tasks]), () => statsView(o));
    setRegion('list', JSON.stringify([state.q, state.filter, state.selected, o.budget?.task_tokens, o.tasks.map(t => stable(t))]), () => taskItems(o));
    regions.count.textContent = taskCount(o);
    const d = state.detail;
    const detailKey = JSON.stringify([state.selected, state.logTab, state.changes, d && {...d, activity: null, task: {...stable(d.task), stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false}}]);
    const rebuilt = signatures.detail !== detailKey;
    setRegion('detail', detailKey, () => detailView());
    if (!rebuilt) patchLogs();
    patchActivity();
    patchSteps();
  } else if (regions.view === 'usage') {
    loadUsage();
    setRegion('usage', JSON.stringify(state.usage), () => usageView(state.usage));
  } else {
    if (!state.models && !state.modelsLoading) loadModels();
    setRegion('settings', JSON.stringify([state.models, o.model, o.permission, o.effort, o.wait, o.budget && [o.budget.task_tokens, o.budget.day_tokens], o.soft_timeout, o.progress, o.cli, o.agents, o.default_agent, o.default_autonomy, o.concurrency, o.delegation, o.limits, o.allowed_workspaces, o.session_workspaces, o.server.mcp_endpoint]), () => settingsView(o));
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
