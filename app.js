// Amigo Oculto de Livros.
// Backend: Supabase (RPCs ao_* sobre o schema privado "ao", ver supabase/migrations)
// quando config.js traz URL e chave; senão, modo local (localStorage, só neste navegador).
//
// Rotas (hash, funciona em qualquer hospedagem estática):
//   #/                        criar grupo + meus grupos
//   #/admin/<grupo>[/<chave>] painel do organizador
//   #/g/<grupo>               convite: entrar no grupo
//   #/me/<membro>[/<chave>]   página pessoal: revela quem a pessoa tirou

// =========================================================================
// 1. UTILITÁRIOS
// =========================================================================
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $toast = document.getElementById('toast');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ic = name => `<i data-lucide="${name}"></i>`;
const drawIcons = () => window.lucide?.createIcons();

function newKey(len = 32) {
    const alphabet = '0123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

const store = {
    get(k, fallback) {
        try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* aba anônima ou storage cheio */ }
    }
};

const ADMIN_KEYS = 'ao_admin_v1';   // { [grupo]: { key, name } }
const MEMBER_KEYS = 'ao_member_v1'; // { [membro]: { key, gid, groupName, name } }

const admins = () => store.get(ADMIN_KEYS, {});
const members = () => store.get(MEMBER_KEYS, {});
function saveAdmin(gid, patch) { const a = admins(); a[gid] = { ...a[gid], ...patch }; store.set(ADMIN_KEYS, a); }
function saveMember(mid, patch) { const m = members(); m[mid] = { ...m[mid], ...patch }; store.set(MEMBER_KEYS, m); }
function forgetMember(mid) { const m = members(); delete m[mid]; store.set(MEMBER_KEYS, m); }

const base = () => location.href.split('#')[0];
const inviteLink = gid => `${base()}#/g/${gid}`;
const adminLink = (gid, key) => `${base()}#/admin/${gid}/${key}`;
const meLink = (mid, key) => `${base()}#/me/${mid}/${key}`;

let toastTimer;
function toast(msg, icon = 'check') {
    $toast.innerHTML = `${ic(icon)}<span>${esc(msg)}</span>`;
    drawIcons();
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
}

async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copiado', 'copy'); }
    catch { toast('Selecione e copie', 'circle-alert'); }
}

const ERRORS = {
    bad_name: 'Nome até 40 caracteres (grupo: 80).',
    bad_details: 'Texto longo demais.',
    bad_wishes: 'Até 1000 caracteres.',
    bad_key: 'Recarregue a página.',
    throttled: 'Muitas tentativas. Espere um pouco.',
    not_found: 'Grupo não encontrado.',
    forbidden: 'Link sem acesso. Copiou inteiro?',
    already_drawn: 'O sorteio já foi feito.',
    full: 'Limite de 100 pessoas.',
    name_taken: 'Esse nome já está no grupo.',
    too_few: 'Mínimo de 3 pessoas.',
    network: 'Sem conexão. Tente de novo.'
};
const errMsg = e => ERRORS[e?.message] || ERRORS.network;

const fmtDate = iso => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';

function setStatus(ok, text) {
    $status.classList.toggle('ok', ok);
    $status.title = text;
    $status.setAttribute('aria-label', text);
}

// =========================================================================
// 2. BACKENDS (Supabase ou local) — mesma interface, erros como Error(código)
// =========================================================================
async function createSupabaseBackend(url, anonKey) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

    async function rpc(fn, args) {
        const { data, error } = await sb.rpc(fn, args);
        if (error) { console.error(fn, error); throw new Error('network'); }
        if (data && data.error) throw new Error(data.error);
        return data;
    }

    return {
        label: 'online',
        createGroup: (f, key) => rpc('ao_create_group', { p_name: f.name, p_details: f.details, p_budget: f.budget, p_event_date: f.eventDate, p_admin_key: key }),
        group: gid => rpc('ao_group', { p_group: gid }),
        admin: (gid, key) => rpc('ao_admin', { p_group: gid, p_admin_key: key }),
        updateGroup: (gid, key, f) => rpc('ao_update_group', { p_group: gid, p_admin_key: key, p_name: f.name, p_details: f.details, p_budget: f.budget, p_event_date: f.eventDate }),
        join: (gid, name, wishes, key) => rpc('ao_join', { p_group: gid, p_name: name, p_wishes: wishes, p_key: key }),
        me: (mid, key) => rpc('ao_me', { p_member: mid, p_key: key }),
        updateMe: (mid, key, name, wishes) => rpc('ao_update_me', { p_member: mid, p_key: key, p_name: name, p_wishes: wishes }),
        leave: (mid, key) => rpc('ao_leave', { p_member: mid, p_key: key }),
        remove: (gid, key, mid) => rpc('ao_remove', { p_group: gid, p_admin_key: key, p_member: mid }),
        draw: (gid, key) => rpc('ao_draw', { p_group: gid, p_admin_key: key }),
        undraw: (gid, key) => rpc('ao_undraw', { p_group: gid, p_admin_key: key }),
        subscribe(gid, onChange) {
            const ch = sb.channel(`ao-${gid}`)
                .on('broadcast', { event: 'change' }, () => onChange())
                .subscribe();
            return () => sb.removeChannel(ch);
        }
    };
}

// Modo local: as mesmas regras do banco, guardadas só neste navegador (para testar sem Supabase).
function createLocalBackend() {
    const DB = 'ao_local_db_v1';
    const load = () => store.get(DB, { groups: {}, members: {} });
    const fail = code => { throw new Error(code); };
    const id = () => newKey(10).toLowerCase();
    const groupJson = (db, gid) => {
        const g = db.groups[gid];
        if (!g) return null;
        const ms = Object.values(db.members).filter(m => m.gid === gid).sort((a, b) => a.createdAt - b.createdAt);
        return { id: g.id, name: g.name, details: g.details, budget: g.budget, eventDate: g.eventDate, status: g.status, drawnAt: g.drawnAt, members: ms.map(m => ({ id: m.id, name: m.name })) };
    };
    const adminGroup = (db, gid, key) => {
        const g = db.groups[gid];
        if (!g || g.adminKey !== key) fail('forbidden');
        return g;
    };
    const ownMember = (db, mid, key) => {
        const m = db.members[mid];
        if (!m || m.key !== key) fail('forbidden');
        return m;
    };
    const clean = (f) => ({ name: (f.name || '').trim(), details: (f.details || '').trim(), budget: (f.budget || '').trim(), eventDate: (f.eventDate || '').trim() });
    const checkGroup = f => {
        if (!f.name || f.name.length > 80) fail('bad_name');
        if (f.details.length > 600 || f.budget.length > 40 || f.eventDate.length > 40) fail('bad_details');
    };
    const checkMember = (name, wishes) => {
        if (!name || name.length > 40) fail('bad_name');
        if (wishes.length > 1000) fail('bad_wishes');
    };
    const listeners = new Set();
    const commit = db => { store.set(DB, db); listeners.forEach(fn => fn()); };
    window.addEventListener('storage', e => { if (e.key === DB) listeners.forEach(fn => fn()); });

    return {
        label: 'modo local',
        async createGroup(f, key) {
            const db = load(); const c = clean(f); checkGroup(c);
            const gid = id();
            db.groups[gid] = { id: gid, ...c, adminKey: key, status: 'open', drawnAt: null };
            commit(db); return { id: gid };
        },
        async group(gid) { const j = groupJson(load(), gid); if (!j) fail('not_found'); return j; },
        async admin(gid, key) { const db = load(); adminGroup(db, gid, key); return groupJson(db, gid); },
        async updateGroup(gid, key, f) {
            const db = load(); const g = adminGroup(db, gid, key); const c = clean(f); checkGroup(c);
            Object.assign(g, c); commit(db); return { ok: true };
        },
        async join(gid, name, wishes, key) {
            const db = load(); const g = db.groups[gid];
            name = (name || '').trim(); wishes = (wishes || '').trim(); checkMember(name, wishes);
            if (!g) fail('not_found');
            if (g.status !== 'open') fail('already_drawn');
            const ms = Object.values(db.members).filter(m => m.gid === gid);
            if (ms.length >= 100) fail('full');
            if (ms.some(m => m.name.toLowerCase() === name.toLowerCase())) fail('name_taken');
            const mid = id();
            db.members[mid] = { id: mid, gid, name, wishes, key, target: null, createdAt: Date.now() };
            commit(db); return { id: mid };
        },
        async me(mid, key) {
            const db = load(); const m = ownMember(db, mid, key);
            const t = m.target && db.members[m.target];
            return { group: groupJson(db, m.gid), me: { id: m.id, name: m.name, wishes: m.wishes }, target: t ? { name: t.name, wishes: t.wishes } : null };
        },
        async updateMe(mid, key, name, wishes) {
            const db = load(); const m = ownMember(db, mid, key);
            name = (name || '').trim(); wishes = (wishes || '').trim(); checkMember(name, wishes);
            if (name !== m.name) {
                if (db.groups[m.gid].status !== 'open') fail('already_drawn');
                if (Object.values(db.members).some(o => o.gid === m.gid && o.id !== m.id && o.name.toLowerCase() === name.toLowerCase())) fail('name_taken');
            }
            Object.assign(m, { name, wishes }); commit(db); return { ok: true };
        },
        async leave(mid, key) {
            const db = load(); const m = ownMember(db, mid, key);
            if (db.groups[m.gid].status !== 'open') fail('already_drawn');
            delete db.members[mid]; commit(db); return { ok: true };
        },
        async remove(gid, key, mid) {
            const db = load(); const g = adminGroup(db, gid, key);
            if (g.status !== 'open') fail('already_drawn');
            if (db.members[mid]?.gid !== gid) fail('not_found');
            delete db.members[mid]; commit(db); return { ok: true };
        },
        async draw(gid, key) {
            const db = load(); const g = adminGroup(db, gid, key);
            if (g.status !== 'open') fail('already_drawn');
            const ids = Object.values(db.members).filter(m => m.gid === gid).map(m => m.id);
            if (ids.length < 3) fail('too_few');
            for (let i = ids.length - 1; i > 0; i--) {
                const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
                [ids[i], ids[j]] = [ids[j], ids[i]];
            }
            ids.forEach((mid, i) => { db.members[mid].target = ids[(i + 1) % ids.length]; });
            g.status = 'drawn'; g.drawnAt = new Date().toISOString();
            commit(db); return { ok: true, count: ids.length };
        },
        async undraw(gid, key) {
            const db = load(); const g = adminGroup(db, gid, key);
            Object.values(db.members).forEach(m => { if (m.gid === gid) m.target = null; });
            g.status = 'open'; g.drawnAt = null; commit(db); return { ok: true };
        },
        subscribe(_gid, onChange) { listeners.add(onChange); return () => listeners.delete(onChange); }
    };
}


// =========================================================================
// 3. ROTEAMENTO E ATUALIZAÇÃO AO VIVO
// =========================================================================
let backend;
let unsubscribe = null;
let pollTimer = null;
let currentView = null; // { refresh: async () => void }

function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    return { name: parts[0] || 'home', a: parts[1], b: parts[2] };
}

function watch(gid, refresh) {
    unsubscribe = backend.subscribe(gid, () => refresh());
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 20000);
}

async function route() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    clearInterval(pollTimer);
    currentView = null;
    const r = parseRoute();
    window.scrollTo(0, 0);
    try {
        if (r.name === 'admin' && r.a) return await viewAdmin(r.a, r.b);
        if (r.name === 'g' && r.a) return await viewInvite(r.a);
        if (r.name === 'me' && r.a) return await viewMe(r.a, r.b);
        return viewHome();
    } catch (e) {
        viewError(errMsg(e));
    }
}

function paint(html) {
    $app.innerHTML = html;
    drawIcons();
    $app.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copy(b.dataset.copy)));
    $app.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
        document.getElementById(b.dataset.toggle)?.classList.toggle('hidden');
    }));
}

// não atropela quem está digitando
const isEditing = () => !!$app.querySelector('form[data-dirty="1"]') || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
const trackDirty = form => form.addEventListener('input', () => { form.dataset.dirty = '1'; });

// confirmação em dois toques (sem confirm() do navegador)
function confirmButton(btn, armedHtml, action) {
    let armed = false, timer;
    const original = btn.innerHTML;
    const reset = () => { armed = false; btn.classList.remove('armed'); btn.innerHTML = original; };
    btn.addEventListener('click', async () => {
        if (!armed) {
            armed = true; btn.classList.add('armed'); btn.innerHTML = armedHtml; drawIcons();
            timer = setTimeout(reset, 4000);
            return;
        }
        clearTimeout(timer); btn.disabled = true;
        try { await action(); } catch (e) { toast(errMsg(e), 'circle-alert'); btn.disabled = false; reset(); }
    });
}

// ---- pedaços de tela

const PASTELS = ['c-lilac', 'c-mint', 'c-peach', 'c-sky', 'c-butter', 'c-rose'];
const tint = i => PASTELS[i % PASTELS.length];
const initial = name => esc((name.trim()[0] || '?').toUpperCase());

const copyRow = (value, iconName = 'link', extra = '') => `
    <div class="row">
        <label class="in" style="flex:1">${ic(iconName)}<input type="text" readonly value="${esc(value)}" onfocus="this.select()" aria-label="Link"></label>
        <button type="button" class="icon-btn" data-copy="${esc(value)}" title="Copiar" aria-label="Copiar">${ic('copy')}</button>
        ${extra}
    </div>`;

function chips(g, extra = '') {
    const c = [
        g.eventDate && `<span class="chip c-sky" title="Data">${ic('calendar')}${esc(g.eventDate)}</span>`,
        g.budget && `<span class="chip c-butter" title="Valor">${ic('wallet')}${esc(g.budget)}</span>`,
        `<span class="chip c-peach" title="Participantes">${ic('users')}${g.members.length}</span>`,
        g.status === 'drawn'
            ? `<span class="chip c-lilac" title="Sorteado em ${esc(fmtDate(g.drawnAt))}">${ic('sparkles')}sorteado</span>`
            : `<span class="chip c-mint" title="Inscrições abertas">${ic('lock-open')}aberto</span>`
    ].filter(Boolean).join('');
    return `<div class="chips">${extra}${c}</div>`;
}

const hero = (g, extra = '') => `
    <div class="hero">
        <h1>${esc(g.name)}</h1>
        ${chips(g, extra)}
        ${g.details ? `<p class="muted small" style="white-space:pre-wrap;max-width:44ch">${esc(g.details)}</p>` : ''}
    </div>`;

function people(ms, { meId = null, removable = false } = {}) {
    if (!ms.length) return `<p class="muted center small">${ic('user-plus')}</p>`;
    return `<ul class="people">${ms.map((m, i) => `
        <li class="${m.id === meId ? 'me' : ''}">
            <span class="av ${tint(i)}">${initial(m.name)}</span><span class="nm">${esc(m.name)}</span>
            ${removable ? `<button type="button" data-remove="${esc(m.id)}" title="Remover ${esc(m.name)}" aria-label="Remover ${esc(m.name)}">${ic('x')}</button>` : ''}
        </li>`).join('')}</ul>`;
}

const sectionTitle = (icon, text, right = '') =>
    `<div class="spread" style="margin-bottom:12px"><h2 class="row">${ic(icon)}${text}</h2>${right}</div>`;

const groupFields = (g = {}) => `
    <label class="in">${ic('book-heart')}<input name="name" type="text" maxlength="80" required placeholder="Nome do grupo" aria-label="Nome do grupo" value="${esc(g.name || '')}"></label>
    <div class="grid2">
        <label class="in">${ic('calendar')}<input name="eventDate" type="text" maxlength="40" placeholder="Data" aria-label="Data da troca" value="${esc(g.eventDate || '')}"></label>
        <label class="in">${ic('wallet')}<input name="budget" type="text" maxlength="40" placeholder="Valor" aria-label="Valor" value="${esc(g.budget || '')}"></label>
    </div>
    <label class="in top">${ic('scroll-text')}<textarea name="details" maxlength="600" placeholder="Regras (opcional)" aria-label="Regras e recados">${esc(g.details || '')}</textarea></label>`;

const readGroupForm = form => Object.fromEntries(['name', 'eventDate', 'budget', 'details'].map(k => [k, form.elements[k].value]));

function viewError(msg) {
    paint(`
        <div class="card center stack" style="justify-items:center">
            <span class="chip c-rose">${ic('circle-alert')}</span>
            <p>${esc(msg)}</p>
            <a class="btn" href="#/" aria-label="Início">${ic('house')}</a>
        </div>`);
}

// =========================================================================
// 4. TELAS
// =========================================================================
function viewHome() {
    const myAdmin = Object.entries(admins());
    const myMember = Object.entries(members());
    const mine = myAdmin.length || myMember.length ? `
        <section class="card">
            ${sectionTitle('bookmark', 'Seus grupos')}
            <div class="list-groups">
                ${myAdmin.map(([gid, a]) => `<a href="#/admin/${esc(gid)}"><span class="ic c-lilac" title="Organizador">${ic('crown')}</span><span>${esc(a.name || gid)}</span></a>`).join('')}
                ${myMember.map(([mid, m]) => `<a href="#/me/${esc(mid)}"><span class="ic c-mint" title="Participante">${ic('book-open')}</span><span>${esc(m.groupName || 'Grupo')}<br><span class="sub">${esc(m.name)}</span></span></a>`).join('')}
            </div>
        </section>` : '';

    paint(`
        <div class="stack">
            <div class="hero">
                <h1>Amigo oculto de livros</h1>
                <p class="muted">Só você vê quem tirou.</p>
            </div>
            <div class="steps" aria-label="Como funciona">
                <div><span class="ic c-sky">${ic('link')}</span>Convite</div>
                <div><span class="ic c-peach">${ic('user-plus')}</span>Cadastro</div>
                <div><span class="ic c-butter">${ic('dices')}</span>Sorteio</div>
                <div><span class="ic c-rose">${ic('gift')}</span>Surpresa</div>
            </div>
            ${mine}
            <form id="create" class="card stack">
                ${groupFields()}
                <button type="submit" class="wide">${ic('plus')}Criar grupo</button>
                <p class="error" id="create-err"></p>
            </form>
        </div>`);

    const form = document.getElementById('create');
    form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        const f = readGroupForm(form);
        const key = newKey();
        btn.disabled = true;
        try {
            const { id } = await backend.createGroup(f, key);
            saveAdmin(id, { key, name: f.name.trim() });
            location.hash = `#/admin/${id}`;
        } catch (e) {
            document.getElementById('create-err').textContent = errMsg(e);
            btn.disabled = false;
        }
    });
}

async function viewAdmin(gid, keyFromUrl) {
    if (keyFromUrl) {
        saveAdmin(gid, { key: keyFromUrl });
        history.replaceState(null, '', `#/admin/${gid}`);
    }
    const key = admins()[gid]?.key;
    if (!key) return viewError('Abra o seu link de organizador neste aparelho.');

    let g = await backend.admin(gid, key);
    saveAdmin(gid, { name: g.name });
    let last = '';
    let editing = false;

    const render = () => {
        last = JSON.stringify(g);
        const drawn = g.status === 'drawn';
        const n = g.members.length;
        const wa = `https://wa.me/?text=${encodeURIComponent(`📚 ${g.name}\n${inviteLink(gid)}`)}`;
        paint(`
            <div class="stack">
                ${hero(g, `<span class="chip c-lilac" title="Você organiza">${ic('crown')}</span>`)}

                ${drawn ? `
                    <section class="card center stack" style="justify-items:center">
                        <span class="chip c-lilac" style="padding:12px">${ic('sparkles')}</span>
                        <p><b>Sorteado!</b> <span class="muted small">${esc(fmtDate(g.drawnAt))}</span></p>
                        <p class="muted small">${ic('eye-off')} Nem você vê os pares.</p>
                        <button type="button" class="icon-btn plain" id="undraw" title="Desfazer sorteio (reabre inscrições)" aria-label="Desfazer sorteio">${ic('rotate-ccw')}</button>
                    </section>
                ` : `
                    <section class="card">
                        ${sectionTitle('send', 'Convite')}
                        ${copyRow(inviteLink(gid), 'link', `
                            <a class="btn icon-btn c-mint" href="${wa}" target="_blank" rel="noopener" title="Mandar no WhatsApp" aria-label="Mandar no WhatsApp">${ic('message-circle')}</a>`)}
                    </section>
                `}

                <section class="card">
                    ${sectionTitle('users', `${n}`, drawn ? '' : `<a class="btn icon-btn sm c-sky" href="#/g/${esc(gid)}" title="Participar também" aria-label="Participar também">${ic('user-plus')}</a>`)}
                    ${people(g.members, { removable: !drawn })}
                    ${drawn ? '' : `
                        <button type="button" id="draw" class="wide" style="margin-top:16px" ${n < 3 ? 'disabled' : ''} title="${n < 3 ? 'Mínimo de 3 pessoas' : 'Sortear'}">
                            ${ic('dices')}Sortear${n < 3 ? ` <span class="small">(${n}/3)</span>` : ''}
                        </button>`}
                </section>

                ${editing ? `
                    <form id="details" class="card stack">
                        ${groupFields(g)}
                        <div class="row end">
                            <button type="button" class="icon-btn plain" id="d-cancel" title="Cancelar" aria-label="Cancelar">${ic('x')}</button>
                            <button type="submit" class="icon-btn" title="Salvar" aria-label="Salvar">${ic('check')}</button>
                        </div>
                        <p class="error" id="d-err"></p>
                    </form>` : ''}

                <div id="admin-key" class="card hidden">
                    ${copyRow(adminLink(gid, key), 'key-round')}
                    <p class="muted small" style="margin-top:8px">${ic('shield-alert')} Seu acesso de organizador. Não compartilhe.</p>
                </div>

                <div class="row center">
                    <button type="button" class="icon-btn plain" id="edit" title="Editar grupo" aria-label="Editar grupo">${ic('pencil')}</button>
                    <button type="button" class="icon-btn plain" data-toggle="admin-key" title="Link de organizador" aria-label="Link de organizador">${ic('key-round')}</button>
                </div>
            </div>`);

        $app.querySelectorAll('[data-remove]').forEach(b => {
            const name = g.members.find(m => m.id === b.dataset.remove)?.name || '';
            confirmButton(b, ic('check'), async () => {
                await backend.remove(gid, key, b.dataset.remove);
                toast(name, 'user-minus');
                await refresh(true);
            });
        });
        const drawBtn = document.getElementById('draw');
        if (drawBtn) confirmButton(drawBtn, `${ic('check')}Confirmar (${n})`, async () => {
            await backend.draw(gid, key);
            toast('Sorteado!', 'sparkles');
            await refresh(true);
        });
        const undrawBtn = document.getElementById('undraw');
        if (undrawBtn) confirmButton(undrawBtn, ic('check'), async () => {
            await backend.undraw(gid, key);
            toast('Inscrições reabertas', 'lock-open');
            await refresh(true);
        });
        document.getElementById('edit').addEventListener('click', () => { editing = !editing; render(); });
        document.getElementById('d-cancel')?.addEventListener('click', () => { editing = false; render(); });
        const df = document.getElementById('details');
        if (df) {
            trackDirty(df);
            df.addEventListener('submit', async ev => {
                ev.preventDefault();
                try {
                    await backend.updateGroup(gid, key, readGroupForm(df));
                    editing = false;
                    toast('Salvo');
                    await refresh(true);
                } catch (e) { document.getElementById('d-err').textContent = errMsg(e); }
            });
        }
    };

    async function refresh(force = false) {
        try {
            const next = await backend.admin(gid, key);
            if (!force && (JSON.stringify(next) === last || isEditing())) { g = next; return; }
            g = next; saveAdmin(gid, { name: g.name }); render();
        } catch (e) { toast(errMsg(e), 'circle-alert'); }
    }

    render();
    currentView = { refresh };
    watch(gid, refresh);
}

async function viewInvite(gid) {
    let g = await backend.group(gid);
    const mine = Object.entries(members()).filter(([, m]) => m.gid === gid);
    let last = '';

    const render = () => {
        last = JSON.stringify(g);
        const open = g.status === 'open';
        paint(`
            <div class="stack">
                ${hero(g)}
                ${mine.length ? `<div class="chips">${mine.map(([mid, m]) => `<a class="chip c-lilac" href="#/me/${esc(mid)}" style="text-decoration:none">${ic('user')}${esc(m.name)}${ic('arrow-right')}</a>`).join('')}</div>` : ''}
                ${open ? `
                    <form id="join" class="card stack">
                        <label class="in">${ic('user')}<input name="name" type="text" maxlength="40" required autocomplete="name" placeholder="Seu nome" aria-label="Seu nome"></label>
                        <label class="in top">${ic('heart')}<textarea name="wishes" maxlength="1000" placeholder="Livros, gêneros e autores que você curte" aria-label="Lista de desejos"></textarea></label>
                        <button type="submit" class="wide">${ic('log-in')}Entrar</button>
                        <p class="error" id="j-err"></p>
                    </form>` : `
                    <section class="card center stack" style="justify-items:center">
                        <span class="chip c-lilac" style="padding:12px">${ic('lock')}</span>
                        <p>Sorteio já feito.</p>
                        ${mine.length ? `<a class="btn" href="#/me/${esc(mine[0][0])}">${ic('gift')}Ver quem eu tirei</a>` : ''}
                    </section>`}
                <section class="card">
                    ${sectionTitle('users', `${g.members.length}`)}
                    ${people(g.members)}
                </section>
            </div>`);

        const form = document.getElementById('join');
        if (!form) return;
        trackDirty(form);
        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            const name = form.elements.name.value;
            const key = newKey();
            btn.disabled = true;
            try {
                const { id } = await backend.join(gid, name, form.elements.wishes.value, key);
                saveMember(id, { key, gid, groupName: g.name, name: name.trim(), fresh: true });
                location.hash = `#/me/${id}`;
            } catch (e) {
                document.getElementById('j-err').textContent = errMsg(e);
                btn.disabled = false;
            }
        });
    };

    async function refresh() {
        try {
            const next = await backend.group(gid);
            if (JSON.stringify(next) === last || isEditing()) { g = next; return; }
            g = next; render();
        } catch { /* tenta de novo no próximo ciclo */ }
    }

    render();
    currentView = { refresh };
    watch(gid, refresh);
}

async function viewMe(mid, keyFromUrl) {
    if (keyFromUrl) {
        saveMember(mid, { key: keyFromUrl });
        history.replaceState(null, '', `#/me/${mid}`);
    }
    const key = members()[mid]?.key;
    if (!key) return viewError('Abra o seu link pessoal neste aparelho.');

    let data;
    try { data = await backend.me(mid, key); }
    catch (e) {
        if (e.message === 'forbidden') forgetMember(mid);
        throw e;
    }
    const gid = data.group.id;
    saveMember(mid, { gid, groupName: data.group.name, name: data.me.name });
    const fresh = members()[mid]?.fresh;
    if (fresh) saveMember(mid, { fresh: false });
    let opened = false;
    let editing = false;
    let last = '';

    const render = () => {
        last = JSON.stringify(data);
        const { group: g, me, target } = data;
        const open = g.status === 'open';
        paint(`
            <div class="stack">
                ${hero(g)}

                ${fresh ? `
                    <section class="card stack" style="background:var(--butter);color:var(--butter-ink)">
                        <p class="row"><b class="row">${ic('key-round')}Guarde seu link</b></p>
                        ${copyRow(meLink(mid, key), 'link')}
                        <p class="small">${ic('eye-off')} Não mande para ninguém: ele mostra o seu sorteio.</p>
                    </section>` : ''}

                ${target ? `
                    <section class="card center">
                        <div class="book ${opened ? 'open' : ''}" id="book">
                            <div class="page">
                                <span class="muted small">Você tirou</span>
                                <span class="who">${esc(target.name)}</span>
                                ${ic('heart')}
                            </div>
                            <button type="button" class="cover" id="cover" aria-label="Abrir e ver quem você tirou">
                                ${ic('gift')}
                                <span class="tap">${ic('pointer')}toque</span>
                            </button>
                        </div>
                        <div id="target-wishes" class="${opened ? '' : 'hidden'}" style="text-align:left;margin-top:16px">
                            ${target.wishes ? `<p class="wishes">${esc(target.wishes)}</p>` : `<p class="muted small center">${ic('hourglass')} Lista vazia por enquanto.</p>`}
                        </div>
                    </section>
                ` : `
                    <section class="card center stack waiting" style="justify-items:center">
                        ${ic('hourglass')}
                        <p class="muted">Aguardando o sorteio</p>
                    </section>
                `}

                <section class="card">
                    ${sectionTitle('heart', 'Meus desejos', editing ? '' : `<button type="button" class="icon-btn sm plain" id="m-edit" title="Editar" aria-label="Editar">${ic('pencil')}</button>`)}
                    ${editing ? `
                        <form id="me-form" class="stack">
                            <label class="in">${ic('user')}<input name="name" type="text" maxlength="40" value="${esc(me.name)}" aria-label="Seu nome" ${open ? '' : 'disabled title="O nome não muda depois do sorteio"'}></label>
                            <label class="in top">${ic('heart')}<textarea name="wishes" maxlength="1000" aria-label="Lista de desejos" placeholder="Livros, gêneros e autores que você curte">${esc(me.wishes)}</textarea></label>
                            <div class="row end">
                                <button type="button" class="icon-btn plain" id="m-cancel" title="Cancelar" aria-label="Cancelar">${ic('x')}</button>
                                <button type="submit" class="icon-btn" title="Salvar" aria-label="Salvar">${ic('check')}</button>
                            </div>
                            <p class="error" id="m-err"></p>
                        </form>
                    ` : me.wishes ? `<p class="wishes">${esc(me.wishes)}</p>` : `<p class="muted small">${ic('pencil')} Conte o que você gostaria de ganhar.</p>`}
                </section>

                <section class="card">
                    ${sectionTitle('users', `${g.members.length}`)}
                    ${people(g.members, { meId: me.id })}
                </section>

                <div id="my-key" class="card hidden">
                    ${copyRow(meLink(mid, key), 'key-round')}
                    <p class="muted small" style="margin-top:8px">${ic('eye-off')} Seu link pessoal. Não compartilhe.</p>
                </div>

                <div class="row center">
                    <button type="button" class="icon-btn plain" data-toggle="my-key" title="Meu link pessoal" aria-label="Meu link pessoal">${ic('key-round')}</button>
                    ${open ? `
                        <button type="button" class="icon-btn plain" data-copy="${esc(inviteLink(gid))}" title="Copiar convite" aria-label="Copiar convite">${ic('share-2')}</button>
                        <button type="button" class="icon-btn plain" id="leave" title="Sair do grupo" aria-label="Sair do grupo">${ic('log-out')}</button>` : ''}
                </div>
            </div>`);

        document.getElementById('cover')?.addEventListener('click', () => {
            opened = true;
            document.getElementById('book').classList.add('open');
            document.getElementById('target-wishes').classList.remove('hidden');
        });
        document.getElementById('m-edit')?.addEventListener('click', () => { editing = true; render(); document.querySelector('#me-form textarea').focus(); });
        document.getElementById('m-cancel')?.addEventListener('click', () => { editing = false; render(); });
        const form = document.getElementById('me-form');
        if (form) {
            trackDirty(form);
            form.addEventListener('submit', async ev => {
                ev.preventDefault();
                try {
                    await backend.updateMe(mid, key, form.elements.name.value, form.elements.wishes.value);
                    editing = false;
                    toast('Salvo');
                    await refresh(true);
                } catch (e) { document.getElementById('m-err').textContent = errMsg(e); }
            });
        }
        const leave = document.getElementById('leave');
        if (leave) confirmButton(leave, ic('check'), async () => {
            await backend.leave(mid, key);
            forgetMember(mid);
            toast('Você saiu', 'log-out');
            location.hash = `#/g/${gid}`;
        });
    };

    async function refresh(force = false) {
        try {
            const next = await backend.me(mid, key);
            if (!force && (JSON.stringify(next) === last || isEditing())) { data = next; return; }
            data = next; saveMember(mid, { groupName: data.group.name, name: data.me.name }); render();
        } catch (e) { if (force) toast(errMsg(e), 'circle-alert'); }
    }

    render();
    currentView = { refresh };
    watch(gid, refresh);
}

// =========================================================================
// 5. INÍCIO
// =========================================================================
async function boot() {
    drawIcons();
    const cfg = window.AO_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        try {
            backend = await createSupabaseBackend(cfg.supabaseUrl, cfg.supabaseAnonKey);
            setStatus(true, 'online');
        } catch (e) {
            console.error(e);
            viewError('Sem conexão com o servidor. Recarregue a página.');
            setStatus(false, 'offline');
            return;
        }
    } else {
        backend = createLocalBackend();
        setStatus(false, 'modo local (só neste navegador)');
    }
    window.addEventListener('hashchange', route);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) currentView?.refresh(); });
    route();
}

boot();
