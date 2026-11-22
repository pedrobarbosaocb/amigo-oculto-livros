// Amigo Oculto de Livros.
// Backend: Supabase (RPCs ao_* sobre o schema privado "ao", ver supabase/migrations)
// quando config.js traz URL e chave; senão, modo local (localStorage, só neste navegador).
//
// Rotas (hash, para funcionar no GitHub Pages sem servidor):
//   #/                       criar grupo + meus grupos
//   #/admin/<grupo>[/<chave>] painel do organizador
//   #/g/<grupo>              convite: entrar no grupo
//   #/me/<membro>[/<chave>]  página pessoal: revela quem a pessoa tirou

// =========================================================================
// 1. UTILITÁRIOS
// =========================================================================
const $app = document.getElementById('app');
const $status = document.getElementById('status');
const $toast = document.getElementById('toast');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
}

async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Link copiado'); }
    catch { toast('Não deu para copiar: selecione o link e copie'); }
}

const ERRORS = {
    bad_name: 'Confira o nome (até 40 caracteres; o do grupo, até 80).',
    bad_details: 'Texto longo demais.',
    bad_wishes: 'A lista de desejos pode ter até 1000 caracteres.',
    bad_key: 'Chave inválida. Recarregue a página.',
    throttled: 'Muitas tentativas. Espere alguns minutos.',
    not_found: 'Grupo não encontrado. Confira o link.',
    forbidden: 'Este link não dá acesso. Confira se copiou o link inteiro.',
    already_drawn: 'O sorteio já foi feito.',
    full: 'O grupo chegou ao limite de 100 pessoas.',
    name_taken: 'Já tem alguém com esse nome no grupo. Use sobrenome ou apelido.',
    too_few: 'São precisas pelo menos 3 pessoas para sortear.',
    network: 'Sem conexão com o servidor. Tente de novo.'
};
const errMsg = e => ERRORS[e?.message] || ERRORS.network;

const fmtDate = iso => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function setStatus(ok, text) {
    $status.classList.toggle('ok', ok);
    $status.querySelector('span').textContent = text;
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

// não atropela quem está digitando: só redesenha se nenhum campo do formulário estiver em foco/alterado
const isEditing = () => !!$app.querySelector('form[data-dirty="1"]') || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);

function trackDirty(form) {
    form.addEventListener('input', () => { form.dataset.dirty = '1'; });
}

// botão de confirmação em dois toques (sem confirm() do navegador)
function confirmButton(btn, label, action) {
    let armed = false, timer;
    const original = btn.innerHTML;
    btn.addEventListener('click', async () => {
        if (!armed) {
            armed = true; btn.textContent = label;
            timer = setTimeout(() => { armed = false; btn.innerHTML = original; }, 4000);
            return;
        }
        clearTimeout(timer); btn.disabled = true;
        try { await action(); } catch (e) { toast(errMsg(e)); btn.disabled = false; armed = false; btn.innerHTML = original; }
    });
}

function bindCopies() {
    $app.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => copy(b.dataset.copy)));
}

const copyBox = (label, value, hint = '') => `
    <div class="field">
        <label>${label}</label>
        <div class="copybox"><input type="text" readonly value="${esc(value)}" onfocus="this.select()"><button type="button" class="ghost" data-copy="${esc(value)}">Copiar</button></div>
        ${hint ? `<p class="small muted" style="margin-top:6px">${hint}</p>` : ''}
    </div>`;

function groupHeader(g) {
    const meta = [
        g.eventDate && `📅 ${esc(g.eventDate)}`,
        g.budget && `💸 ${esc(g.budget)}`,
        `👥 ${plural(g.members.length, 'pessoa', 'pessoas')}`
    ].filter(Boolean).join('</span><span>');
    return `
        <p class="small muted" style="margin:0 0 4px">Amigo oculto de livros</p>
        <h1>${esc(g.name)}</h1>
        <div class="meta"><span>${meta}</span></div>
        ${g.details ? `<p class="muted" style="white-space:pre-wrap">${esc(g.details)}</p>` : ''}`;
}

const peopleList = (ms, extra = () => '') => ms.length
    ? `<ul class="people">${ms.map(m => `<li><span>${esc(m.name)}</span>${extra(m)}</li>`).join('')}</ul>`
    : '<p class="muted">Ninguém entrou ainda.</p>';

function viewError(msg) {
    $app.innerHTML = `
        <div class="card center">
            <h2>Ops</h2>
            <p class="muted">${esc(msg)}</p>
            <a class="btn" href="#/">Ir para o início</a>
        </div>`;
}

// =========================================================================
// 4. TELAS
// =========================================================================
function viewHome() {
    const myAdmin = Object.entries(admins());
    const myMember = Object.entries(members());
    const mine = myAdmin.length || myMember.length ? `
        <section class="card">
            <h2>Seus grupos neste aparelho</h2>
            <div class="list-groups">
                ${myAdmin.map(([gid, a]) => `<a href="#/admin/${esc(gid)}"><span>${esc(a.name || gid)}</span><span class="pill">organizador</span></a>`).join('')}
                ${myMember.map(([mid, m]) => `<a href="#/me/${esc(mid)}"><span>${esc(m.groupName || 'Grupo')} <span class="muted">· ${esc(m.name)}</span></span><span class="pill go">participante</span></a>`).join('')}
            </div>
        </section>` : '';

    $app.innerHTML = `
        <h1>Troque livros sem estragar a surpresa</h1>
        <p class="lead">Você cria o grupo, manda o link, cada pessoa se cadastra com os livros que gostaria de ganhar e você dispara o sorteio. Cada participante vê só quem tirou. Nem você fica sabendo.</p>
        ${mine}
        <section class="card">
            <h2>Criar um amigo oculto</h2>
            <form id="create">
                <div class="field">
                    <label for="g-name">Nome do grupo</label>
                    <input id="g-name" type="text" maxlength="80" required placeholder="Ex.: Clube do Livro, Natal 2026">
                </div>
                <div class="row">
                    <div class="field">
                        <label for="g-date">Data da troca <span class="opt">(opcional)</span></label>
                        <input id="g-date" type="text" maxlength="40" placeholder="Ex.: 20/12, 19h">
                    </div>
                    <div class="field">
                        <label for="g-budget">Valor <span class="opt">(opcional)</span></label>
                        <input id="g-budget" type="text" maxlength="40" placeholder="Ex.: até R$ 80">
                    </div>
                </div>
                <div class="field">
                    <label for="g-details">Regras e recados <span class="opt">(opcional)</span></label>
                    <textarea id="g-details" maxlength="600" placeholder="Ex.: Pode ser livro usado em bom estado. Embrulhe e escreva uma dedicatória!"></textarea>
                </div>
                <div class="actions"><button type="submit">Criar grupo</button></div>
                <p class="error" id="create-err"></p>
            </form>
        </section>
        <section class="card">
            <h2>Como funciona</h2>
            <ol class="steps">
                <li>Você cria o grupo e recebe dois links: o <b>convite</b> (para a turma) e o seu <b>link de organizador</b>.</li>
                <li>Cada pessoa abre o convite, coloca o nome e os livros ou gêneros que curte.</li>
                <li>Com todo mundo dentro, você toca em <b>Sortear</b>.</li>
                <li>Cada participante abre a própria página e descobre quem tirou, com a lista de desejos da pessoa.</li>
            </ol>
        </section>`;

    const form = document.getElementById('create');
    form.addEventListener('submit', async ev => {
        ev.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        const f = {
            name: document.getElementById('g-name').value,
            eventDate: document.getElementById('g-date').value,
            budget: document.getElementById('g-budget').value,
            details: document.getElementById('g-details').value
        };
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
    if (!key) return viewError('Este aparelho não tem a chave de organizador deste grupo. Abra o link de organizador que você guardou.');

    let g = await backend.admin(gid, key);
    saveAdmin(gid, { name: g.name });
    let last = '';
    let editingDetails = false;

    const render = () => {
        last = JSON.stringify(g);
        const drawn = g.status === 'drawn';
        const n = g.members.length;
        $app.innerHTML = `
            ${groupHeader(g)}
            <p><span class="pill">organizador</span> <span class="pill ${drawn ? 'go' : ''}">${drawn ? 'sorteado' : 'inscrições abertas'}</span></p>

            <section class="card">
                ${drawn ? `
                    <h2>Sorteio feito ✨</h2>
                    <p>Feito em ${esc(fmtDate(g.drawnAt))} com ${plural(n, 'pessoa', 'pessoas')}. Cada uma vê quem tirou na própria página; os pares não aparecem aqui.</p>
                    <p class="small muted">Se alguém não guardou o link pessoal, ele continua salvo no aparelho em que a pessoa se cadastrou.</p>
                    <div class="actions"><button type="button" class="ghost" id="undraw">Desfazer sorteio</button></div>
                    <p class="small muted" style="margin-top:10px">Desfazer reabre as inscrições e apaga os pares. Use só se precisar incluir ou tirar alguém; depois, sorteie de novo e avise o grupo.</p>
                ` : `
                    <h2>Convide a turma</h2>
                    ${copyBox('Link do convite', inviteLink(gid), 'Mande este link no grupo. Cada pessoa se cadastra pelo próprio celular.')}
                    <div class="actions">
                        <a class="btn ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`📚 Amigo oculto de livros: ${g.name}\nEntre aqui e conte que livros você curte: ${inviteLink(gid)}`)}">Mandar no WhatsApp</a>
                        <a class="btn ghost" href="#/g/${esc(gid)}">Participar também</a>
                    </div>
                `}
            </section>

            <section class="card">
                <div class="actions" style="justify-content:space-between;margin-bottom:8px">
                    <h2 style="margin:0">Participantes (${n})</h2>
                </div>
                ${peopleList(g.members, m => drawn ? '' : `<button type="button" class="link" data-remove="${esc(m.id)}">remover</button>`)}
                ${drawn ? '' : `
                    <div class="actions" style="margin-top:18px">
                        <button type="button" id="draw" ${n < 3 ? 'disabled' : ''}>🎲 Sortear agora</button>
                        <span class="small muted">${n < 3 ? `Faltam ${3 - n} para poder sortear.` : 'Depois do sorteio as inscrições fecham.'}</span>
                    </div>`}
            </section>

            <section class="card">
                <h3>Detalhes do grupo</h3>
                <div id="details-box">
                    ${editingDetails ? `
                        <form id="details">
                            <div class="field"><label for="d-name">Nome</label><input id="d-name" type="text" maxlength="80" value="${esc(g.name)}"></div>
                            <div class="row">
                                <div class="field"><label for="d-date">Data</label><input id="d-date" type="text" maxlength="40" value="${esc(g.eventDate)}"></div>
                                <div class="field"><label for="d-budget">Valor</label><input id="d-budget" type="text" maxlength="40" value="${esc(g.budget)}"></div>
                            </div>
                            <div class="field"><label for="d-details">Regras e recados</label><textarea id="d-details" maxlength="600">${esc(g.details)}</textarea></div>
                            <div class="actions"><button type="submit">Salvar</button><button type="button" class="ghost" id="d-cancel">Cancelar</button></div>
                            <p class="error" id="d-err"></p>
                        </form>` : `<button type="button" class="ghost" id="edit-details">Editar nome, data, valor e regras</button>`}
                </div>
            </section>

            <section class="card">
                <h3>Seu acesso de organizador</h3>
                ${copyBox('Link de organizador', adminLink(gid, admins()[gid].key), '<b>Não compartilhe.</b> Guarde este link para abrir o painel em outro aparelho.')}
            </section>`;
        bindCopies();

        $app.querySelectorAll('[data-remove]').forEach(b => {
            const name = g.members.find(m => m.id === b.dataset.remove)?.name || '';
            confirmButton(b, `remover ${name}?`, async () => {
                await backend.remove(gid, key, b.dataset.remove);
                toast(`${name} saiu do grupo`);
                await refresh(true);
            });
        });
        const drawBtn = document.getElementById('draw');
        if (drawBtn) confirmButton(drawBtn, `Confirmar sorteio com ${n} pessoas`, async () => {
            await backend.draw(gid, key);
            toast('Sorteio feito!');
            await refresh(true);
        });
        const undrawBtn = document.getElementById('undraw');
        if (undrawBtn) confirmButton(undrawBtn, 'Tem certeza? Toque de novo', async () => {
            await backend.undraw(gid, key);
            toast('Sorteio desfeito; inscrições reabertas');
            await refresh(true);
        });
        document.getElementById('edit-details')?.addEventListener('click', () => { editingDetails = true; render(); });
        document.getElementById('d-cancel')?.addEventListener('click', () => { editingDetails = false; render(); });
        const df = document.getElementById('details');
        if (df) {
            trackDirty(df);
            df.addEventListener('submit', async ev => {
                ev.preventDefault();
                const f = {
                    name: document.getElementById('d-name').value,
                    eventDate: document.getElementById('d-date').value,
                    budget: document.getElementById('d-budget').value,
                    details: document.getElementById('d-details').value
                };
                try {
                    await backend.updateGroup(gid, key, f);
                    editingDetails = false;
                    toast('Detalhes salvos');
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
        } catch (e) { toast(errMsg(e)); }
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
        $app.innerHTML = `
            ${groupHeader(g)}
            ${mine.length ? `
                <div class="notice">
                    Você já está neste grupo como ${mine.map(([mid, m]) => `<a href="#/me/${esc(mid)}"><b>${esc(m.name)}</b></a>`).join(', ')}.
                    ${open ? 'Se quiser cadastrar outra pessoa neste aparelho, use o formulário abaixo.' : ''}
                </div>` : ''}
            ${open ? `
                <section class="card">
                    <h2>Entrar no amigo oculto</h2>
                    <form id="join">
                        <div class="field">
                            <label for="j-name">Seu nome</label>
                            <input id="j-name" type="text" maxlength="40" required autocomplete="name" placeholder="Como a turma te conhece">
                        </div>
                        <div class="field">
                            <label for="j-wishes">Que livros você gostaria de ganhar? <span class="opt">(opcional, dá para editar depois)</span></label>
                            <textarea id="j-wishes" maxlength="1000" placeholder="Gêneros e autores que você curte, títulos que estão na sua lista, e os que você já tem."></textarea>
                        </div>
                        <div class="actions"><button type="submit">Entrar no grupo</button></div>
                        <p class="error" id="j-err"></p>
                    </form>
                </section>` : `
                <section class="card">
                    <h2>O sorteio já foi feito</h2>
                    <p class="muted">As inscrições estão fechadas. ${mine.length ? 'Abra a sua página para ver quem você tirou.' : 'Se você ficou de fora, fale com quem organizou.'}</p>
                    ${mine.length ? `<a class="btn" href="#/me/${esc(mine[0][0])}">Ver quem eu tirei</a>` : ''}
                </section>`}
            <section class="card">
                <h3>Quem já está no grupo (${g.members.length})</h3>
                ${peopleList(g.members)}
            </section>`;

        const form = document.getElementById('join');
        if (!form) return;
        trackDirty(form);
        form.addEventListener('submit', async ev => {
            ev.preventDefault();
            const btn = form.querySelector('button[type=submit]');
            const name = document.getElementById('j-name').value;
            const wishes = document.getElementById('j-wishes').value;
            const key = newKey();
            btn.disabled = true;
            try {
                const { id } = await backend.join(gid, name, wishes, key);
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
        } catch (e) { /* mantém a tela; tenta de novo no próximo ciclo */ }
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
    if (!key) return viewError('Este aparelho não tem a sua chave. Abra o seu link pessoal (o que apareceu quando você se cadastrou).');

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
        $app.innerHTML = `
            ${groupHeader(g)}
            <p><span class="pill go">você é ${esc(me.name)}</span></p>

            ${fresh ? `
                <section class="card">
                    <h2>Você entrou! 🎉</h2>
                    <p>Guarde o seu link pessoal: é por ele que você vai ver quem tirou, inclusive em outro aparelho.</p>
                    ${copyBox('Seu link pessoal', meLink(mid, key), '<b>Não mande para ninguém</b>: quem tiver este link vê o seu sorteio.')}
                </section>` : ''}

            <section class="card ${target ? 'center' : ''}">
                ${target ? `
                    <h2>Seu amigo oculto</h2>
                    <div class="book ${opened ? 'open' : ''}" id="book">
                        <div class="page">
                            <span class="small muted">Você tirou</span>
                            <span class="who">${esc(target.name)}</span>
                            <span class="small muted" style="margin-top:10px">Bom garimpo! 📖</span>
                        </div>
                        <button type="button" class="cover" id="cover" aria-label="Abrir e ver quem você tirou">
                            <span class="frame"></span>
                            <span class="t">Quem você tirou?</span>
                            <span class="small">Toque para abrir</span>
                        </button>
                    </div>
                    <div id="target-wishes" class="${opened ? '' : 'hidden'}" style="text-align:left">
                        <h3>O que ${esc(target.name)} gostaria de ganhar</h3>
                        ${target.wishes ? `<p class="wishes">${esc(target.wishes)}</p>` : '<p class="muted">Ainda não escreveu nada. Dá uma olhada mais perto da data: a lista pode mudar.</p>'}
                    </div>
                ` : `
                    <h2>Esperando o sorteio</h2>
                    <p class="muted">Quando quem organiza fizer o sorteio, o nome de quem você tirou aparece aqui. Esta página se atualiza sozinha.</p>
                `}
            </section>

            <section class="card">
                <h3>Sua lista de desejos</h3>
                ${editing ? `
                    <form id="me-form">
                        <div class="field">
                            <label for="m-name">Seu nome</label>
                            <input id="m-name" type="text" maxlength="40" value="${esc(me.name)}" ${open ? '' : 'disabled'}>
                            ${open ? '' : '<p class="small muted" style="margin-top:6px">O nome não muda depois do sorteio.</p>'}
                        </div>
                        <div class="field">
                            <label for="m-wishes">Livros que você gostaria de ganhar</label>
                            <textarea id="m-wishes" maxlength="1000">${esc(me.wishes)}</textarea>
                        </div>
                        <div class="actions"><button type="submit">Salvar</button><button type="button" class="ghost" id="m-cancel">Cancelar</button></div>
                        <p class="error" id="m-err"></p>
                    </form>
                ` : `
                    ${me.wishes ? `<p class="wishes">${esc(me.wishes)}</p>` : '<p class="muted">Você ainda não escreveu nada. Ajude quem te tirou!</p>'}
                    <div class="actions" style="margin-top:12px"><button type="button" class="ghost" id="m-edit">Editar</button></div>
                `}
                <p class="small muted" style="margin-top:10px">Quem tirou você vê esta lista${open ? ' depois do sorteio' : ''}.</p>
            </section>

            <section class="card">
                <h3>No grupo (${g.members.length})</h3>
                ${peopleList(g.members, m => m.id === me.id ? '<span class="pill">você</span>' : '')}
                ${open ? `<div class="actions" style="margin-top:14px"><a class="btn ghost" href="#/g/${esc(gid)}">Link do convite</a><button type="button" class="link" id="leave">sair do grupo</button></div>` : ''}
            </section>

            ${fresh ? '' : `
                <section class="card">
                    <h3>Seu link pessoal</h3>
                    ${copyBox('Para abrir em outro aparelho', meLink(mid, key), '<b>Não mande para ninguém</b>: quem tiver este link vê o seu sorteio.')}
                </section>`}`;
        bindCopies();

        document.getElementById('cover')?.addEventListener('click', () => {
            opened = true;
            document.getElementById('book').classList.add('open');
            document.getElementById('target-wishes').classList.remove('hidden');
        });
        document.getElementById('m-edit')?.addEventListener('click', () => { editing = true; render(); document.getElementById('m-wishes').focus(); });
        document.getElementById('m-cancel')?.addEventListener('click', () => { editing = false; render(); });
        const form = document.getElementById('me-form');
        if (form) {
            trackDirty(form);
            form.addEventListener('submit', async ev => {
                ev.preventDefault();
                const name = document.getElementById('m-name').value;
                const wishes = document.getElementById('m-wishes').value;
                try {
                    await backend.updateMe(mid, key, name, wishes);
                    editing = false;
                    toast('Lista salva');
                    await refresh(true);
                } catch (e) { document.getElementById('m-err').textContent = errMsg(e); }
            });
        }
        const leave = document.getElementById('leave');
        if (leave) confirmButton(leave, 'sair mesmo? toque de novo', async () => {
            await backend.leave(mid, key);
            forgetMember(mid);
            toast('Você saiu do grupo');
            location.hash = `#/g/${gid}`;
        });
    };

    async function refresh(force = false) {
        try {
            const next = await backend.me(mid, key);
            if (!force && (JSON.stringify(next) === last || isEditing())) { data = next; return; }
            data = next; saveMember(mid, { groupName: data.group.name, name: data.me.name }); render();
        } catch (e) { if (force) toast(errMsg(e)); }
    }

    render();
    currentView = { refresh };
    watch(gid, refresh);
}

// =========================================================================
// 5. INÍCIO
// =========================================================================
async function boot() {
    const cfg = window.AO_CONFIG || {};
    if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        try {
            backend = await createSupabaseBackend(cfg.supabaseUrl, cfg.supabaseAnonKey);
            setStatus(true, 'online');
        } catch (e) {
            console.error(e);
            $app.innerHTML = '';
            viewError('Não foi possível carregar a conexão com o servidor. Recarregue a página.');
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
