// ==UserScript==
// @name         e-Disciplinas: Download COMPLETO do Curso
// @namespace    https://edisciplinas.usp.br/
// @version      1.0
// @description  Baixa todos os arquivos de TODAS as seções do curso
// @match        https://edisciplinas.usp.br/course/view.php*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      edisciplinas.usp.br
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DELAY_MS   = 300;
  const BATCH_SIZE = 3;

  // ════════════════════════════════════════════════
  //  UTILITÁRIOS
  // ════════════════════════════════════════════════

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function sanitize(str) {
    return str.replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  function fileNameFromUrl(url, fallback) {
    try {
      const raw = decodeURIComponent(url.split('/').pop().split('?')[0]);
      return sanitize(raw) || sanitize(fallback);
    } catch {
      return sanitize(fallback);
    }
  }

  // ════════════════════════════════════════════════
  //  RESOLUÇÃO DE LINKS
  // ════════════════════════════════════════════════

  function resolveViaHead(url) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'HEAD', url,
        onload:  r => resolve(r.finalUrl || null),
        onerror: () => resolve(null),
      });
    });
  }

  function resolveViaGet(url) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        responseType: 'document',
        onload: r => {
          if (r.finalUrl?.includes('pluginfile.php')) return resolve(r.finalUrl);
          const doc = r.response;
          const meta = doc?.querySelector('meta[http-equiv="refresh"]');
          if (meta) {
            const m = meta.content.match(/url=(.+)/i);
            if (m) return resolve(decodeURIComponent(m[1].trim()));
          }
          const a = doc?.querySelector('a[href*="pluginfile.php"], a[href*="forcedownload=1"]');
          if (a) return resolve(a.href);
          const embed = doc?.querySelector('object[data], iframe[src]');
          if (embed) {
            const src = embed.getAttribute('data') || embed.getAttribute('src');
            if (src?.includes('pluginfile')) return resolve(src);
          }
          resolve(null);
        },
        onerror: () => resolve(null),
      });
    });
  }

  async function resolveResource(resourceUrl) {
    const fromHead = await resolveViaHead(resourceUrl);
    if (fromHead?.includes('pluginfile.php')) return fromHead;
    return resolveViaGet(resourceUrl);
  }

  function resolveFolder(folderUrl) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url: folderUrl,
        responseType: 'document',
        onload: r => {
          const links = [...(r.response?.querySelectorAll('a[href*="pluginfile.php"]') ?? [])];
          resolve(links.map(a => ({
            name: a.textContent.trim() || a.href.split('/').pop(),
            url:  a.href,
          })));
        },
        onerror: () => resolve([]),
      });
    });
  }

  // ════════════════════════════════════════════════
  //  COLETA
  // ════════════════════════════════════════════════

  function getAllSections() {
    const nodes = document.querySelectorAll('.section-item').length
      ? document.querySelectorAll('.section-item')
      : document.querySelectorAll('li.section.main');

    const seen = new Set();
    return [...nodes].map(sec => {
      const titleEl = sec.querySelector('.sectionname a, .sectionname');
      const name = titleEl?.textContent.trim() ?? '';
      return { el: sec, name };
    }).filter(s => {
      if (!s.name || seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }

  function collectItems(section) {
    const items = [];
    for (const li of section.el.querySelectorAll('li[data-for="cmitem"]')) {
      const isResource = li.classList.contains('modtype_resource');
      const isFolder   = li.classList.contains('modtype_folder');
      if (!isResource && !isFolder) continue;
      const anchor  = li.querySelector('a.aalink');
      const labelEl = li.querySelector('.instancename');
      const label   = labelEl
        ? labelEl.childNodes[0].textContent.trim()
        : (anchor?.textContent.trim() ?? 'arquivo');
      if (anchor?.href) items.push({ type: isFolder ? 'folder' : 'resource', label, href: anchor.href });
    }
    return items;
  }

  // ════════════════════════════════════════════════
  //  DOWNLOAD EM BATCH
  // ════════════════════════════════════════════════

  function downloadFile(url, path) {
    return new Promise(resolve => {
      GM_download({
        url, name: path, saveAs: false,
        headers: { Referer: location.href },
        onload:  () => resolve(true),
        onerror: () => resolve(false),
      });
    });
  }

  async function runBatch(tasks, onProgress) {
    let ok = 0, fail = 0;
    for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
      const chunk = tasks.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async task => {
        task.row.set('downloading');
        const success = await downloadFile(task.url, task.path);
        if (success) { task.row.set('done');  ok++;   }
        else          { task.row.set('error'); fail++; }
        onProgress(ok + fail, tasks.length);
      }));
      if (i + BATCH_SIZE < tasks.length) await sleep(DELAY_MS);
    }
    return { ok, fail };
  }

  // ════════════════════════════════════════════════
  //  UI — MODAL DE CONFIRMAÇÃO
  // ════════════════════════════════════════════════

  const CSS = `
    #gm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998;display:flex;align-items:center;justify-content:center}
    #gm-modal{background:#fff;border-radius:12px;padding:24px;width:460px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.35);font-family:sans-serif;z-index:999999}
    #gm-modal h2{margin:0 0 6px;font-size:17px;color:#e05c00}
    #gm-modal p{margin:0 0 10px;font-size:13px;color:#555}
    #gm-section-list{list-style:none;padding:0;margin:0 0 14px;max-height:220px;overflow-y:auto;border:1px solid #eee;border-radius:7px}
    #gm-section-list li{padding:7px 12px;font-size:13px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:8px}
    #gm-section-list li:last-child{border-bottom:none}
    #gm-section-list li input{cursor:pointer}
    #gm-modal-footer{display:flex;gap:8px}
    .gm-btn{flex:1;padding:9px;border:none;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600}
    .gm-btn-danger{background:#e05c00;color:#fff}
    .gm-btn-danger:hover{background:#c44f00}
    .gm-btn-secondary{background:#f0f0f0;color:#555}
    #gm-toggle-all{font-size:12px;color:#009cde;cursor:pointer;margin-bottom:6px;display:inline-block}
  `;

  function showConfirmModal(sections) {
    return new Promise(resolve => {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      const overlay = document.createElement('div');
      overlay.id = 'gm-overlay';

      const listItems = sections.map((s, i) => `
        <li>
          <input type="checkbox" id="gm-sec-${i}" data-index="${i}" checked>
          <label for="gm-sec-${i}" style="cursor:pointer">${s.name}</label>
        </li>`).join('');

      overlay.innerHTML = `
        <div id="gm-modal">
          <h2>⬇ Download Completo do Curso</h2>
          <p>Selecione as seções que deseja baixar.<br>
             Os arquivos serão salvos em <b>NomeDoCurso/NomeDaSecao/</b></p>
          <span id="gm-toggle-all">☑ Marcar / desmarcar todas</span>
          <ul id="gm-section-list">${listItems}</ul>
          <div id="gm-modal-footer">
            <button class="gm-btn gm-btn-secondary" id="gm-cancel">Cancelar</button>
            <button class="gm-btn gm-btn-danger" id="gm-confirm">⬇ Baixar Selecionadas</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      // Toggle all
      let allChecked = true;
      overlay.querySelector('#gm-toggle-all').addEventListener('click', () => {
        allChecked = !allChecked;
        overlay.querySelectorAll('#gm-section-list input').forEach(cb => cb.checked = allChecked);
      });

      overlay.querySelector('#gm-confirm').addEventListener('click', () => {
        const chosen = [...overlay.querySelectorAll('#gm-section-list input:checked')]
          .map(cb => sections[+cb.dataset.index]);
        overlay.remove(); style.remove();
        resolve(chosen);
      });

      overlay.querySelector('#gm-cancel').addEventListener('click', () => {
        overlay.remove(); style.remove();
        resolve([]);
      });
    });
  }

  // ════════════════════════════════════════════════
  //  UI — PAINEL DE PROGRESSO
  // ════════════════════════════════════════════════

  function buildPanel(courseTitle) {
    document.getElementById('gm-dl-panel')?.remove();
    const el = document.createElement('div');
    el.id = 'gm-dl-panel';
    Object.assign(el.style, {
      position:'fixed', bottom:'20px', right:'20px',
      width:'420px', maxHeight:'85vh', overflowY:'auto',
      background:'#fff', border:'2px solid #e05c00',
      borderRadius:'10px', boxShadow:'0 4px 20px rgba(0,0,0,.3)',
      zIndex:'999999', fontFamily:'sans-serif', fontSize:'13px', padding:'14px',
    });
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="color:#e05c00;font-size:15px">⬇ ${courseTitle}</b>
        <button id="gm-close" style="background:none;border:none;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div id="gm-status" style="color:#555;margin-bottom:6px">Iniciando…</div>
      <div style="height:6px;background:#eee;border-radius:3px;margin-bottom:10px">
        <div id="gm-fill" style="height:100%;width:0%;background:#e05c00;border-radius:3px;transition:width .3s"></div>
      </div>
      <ul id="gm-list" style="list-style:none;padding:0;margin:0"></ul>`;
    document.body.appendChild(el);
    el.querySelector('#gm-close').onclick = () => el.remove();
    return el;
  }

  function addRow(list, label, state = 'pending') {
    const icons = { pending:'⏳', resolving:'🔍', downloading:'⬇', done:'✅', error:'❌', folder:'📂', section:'📁' };
    const li = document.createElement('li');
    li.style.cssText = 'padding:4px 0;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:flex-start';
    li.innerHTML = `<span class="ic">${icons[state] ?? state}</span><span style="word-break:break-word">${label}</span>`;
    list.appendChild(li);
    return { el: li, set(s) { li.querySelector('.ic').textContent = icons[s] ?? s; } };
  }

  function addSectionHeader(list, name) {
    const li = document.createElement('li');
    li.style.cssText = 'padding:8px 0 4px;font-weight:600;font-size:13px;color:#e05c00;border-bottom:2px solid #fde8d8';
    li.textContent = `📁 ${name}`;
    list.appendChild(li);
  }

  // ════════════════════════════════════════════════
  //  ORQUESTRADOR PRINCIPAL
  // ════════════════════════════════════════════════

  async function runAllDownloads(sections) {
    // Pega o título do curso para usar como pasta raiz
    const courseTitle = sanitize(
      document.querySelector('.page-header-headings h1, h1')?.textContent.trim()
      ?? 'Curso'
    );

    const panel  = buildPanel(courseTitle);
    const status = panel.querySelector('#gm-status');
    const list   = panel.querySelector('#gm-list');
    const fill   = panel.querySelector('#gm-fill');

    // ── Fase 1: resolve TODOS os links de todas as seções ────────
    status.textContent = 'Fase 1/2 — Resolvendo todos os links…';
    const allTasks = [];   // { url, path, row }

    for (const section of sections) {
      addSectionHeader(list, section.name);
      const sectionFolder = `${courseTitle}/${sanitize(section.name)}`;
      const items = collectItems(section);

      for (const item of items) {
        if (item.type === 'resource') {
          const row = addRow(list, item.label, 'resolving');
          const url = await resolveResource(item.href);
          if (url) {
            allTasks.push({ url, path: `${sectionFolder}/${fileNameFromUrl(url, item.label)}`, row });
          } else {
            row.set('error');
          }

        } else if (item.type === 'folder') {
          const row   = addRow(list, item.label, 'resolving');
          const files = await resolveFolder(item.href);
          if (files.length) {
            row.set('folder');
            row.el.querySelector('span:last-child').textContent = `${item.label} (${files.length} arquivos)`;
            for (const f of files) {
              const subRow = addRow(list, `  ↳ ${f.name}`, 'pending');
              allTasks.push({
                url:  f.url,
                path: `${sectionFolder}/${sanitize(item.label)}/${fileNameFromUrl(f.url, f.name)}`,
                row:  subRow,
              });
            }
          } else {
            row.set('error');
          }
        }
      }
    }

    // ── Fase 2: batch download de tudo ───────────────────────────
    status.textContent = `Fase 2/2 — Baixando ${allTasks.length} arquivo(s) em batch…`;

    const { ok, fail } = await runBatch(allTasks, (done, total) => {
      const pct = Math.round((done / total) * 100);
      fill.style.width = pct + '%';
      status.textContent = `Fase 2/2 — ${done}/${total} arquivos (${pct}%)`;
    });

    fill.style.width = '100%';
    status.textContent = `✅ Concluído — ${ok} baixados, ${fail} com erro.`;
  }

  // ════════════════════════════════════════════════
  //  BOTÃO DE ENTRADA
  // ════════════════════════════════════════════════

  function createLauncher() {
    document.getElementById('gm-launcher-all')?.remove();
    const btn = document.createElement('button');
    btn.id = 'gm-launcher-all';
    btn.textContent = '⬇ Baixar Curso Completo';
    Object.assign(btn.style, {
      position:'fixed', bottom:'24px', left:'170px',  // ao lado do botão do outro script
      background:'#e05c00', color:'#fff', border:'none',
      borderRadius:'8px', padding:'12px 18px', cursor:'pointer',
      zIndex:'2147483647', fontFamily:'sans-serif',
      fontSize:'14px', fontWeight:'600',
      boxShadow:'0 2px 10px rgba(0,0,0,.4)', lineHeight:'1',
    });
    btn.addEventListener('click', async () => {
      const sections = getAllSections();
      if (!sections.length) { alert('Nenhuma seção encontrada.'); return; }
      const chosen = await showConfirmModal(sections);
      if (!chosen.length) return;
      await runAllDownloads(chosen);
    });
    document.body.appendChild(btn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createLauncher);
  } else {
    createLauncher();
  }

})();
