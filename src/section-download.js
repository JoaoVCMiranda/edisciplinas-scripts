// ==UserScript==
// @name         e-Disciplinas: Download por Seção
// @namespace    https://edisciplinas.usp.br/
// @version      3.0
// @description  Pergunta qual seção baixar e faz o download automático
// @match        https://edisciplinas.usp.br/course/view.php*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      edisciplinas.usp.br
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DELAY_MS = 600;

  // ════════════════════════════════════════════════
  //  UTILITÁRIOS
  // ════════════════════════════════════════════════

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function fetchDoc(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        responseType: 'document',
        onload: r => resolve(r.response),
        onerror: reject,
      });
    });
  }

  function sanitize(str) {
    return str.replace(/[\\/:*?"<>|]/g, '_').trim();
  }

  // ════════════════════════════════════════════════
  //  RESOLUÇÃO DE LINKS
  // ════════════════════════════════════════════════

  // Segue o redirect da página intermediária e retorna a URL final do arquivo
  function resolveResource(resourceUrl) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: resourceUrl,
        responseType: 'document',
        // Captura a URL após todos os redirects
        onload: (r) => {
          // Caso 1: URL final já é o pluginfile (redirect aconteceu)
          if (r.finalUrl && r.finalUrl.includes('pluginfile.php')) {
            return resolve(r.finalUrl);
          }

          const doc = r.response;

          // Caso 2: meta refresh na página intermediária
          const meta = doc?.querySelector('meta[http-equiv="refresh"]');
          if (meta) {
            const match = meta.content.match(/url=(.+)/i);
            if (match) return resolve(decodeURIComponent(match[1].trim()));
          }

          // Caso 3: link direto na página
          const direct = doc?.querySelector(
            'a[href*="pluginfile.php"], a[href*="forcedownload=1"]'
          );
          if (direct) return resolve(direct.href);

          // Caso 4: objeto ou iframe embeddado
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

  async function resolveFolder(folderUrl) {
    const doc = await fetchDoc(folderUrl);
    return [...doc.querySelectorAll('a[href*="pluginfile.php"]')].map(a => ({
      name: a.textContent.trim() || a.href.split('/').pop(),
      url: a.href,
    }));
  }

  // ════════════════════════════════════════════════
  //  BUSCA DE SEÇÕES NA PÁGINA
  // ════════════════════════════════════════════════
  function getAllSections() {
      // Evita duplicatas: prefere .section-item (Moodle 4.x),
      // cai para li.section.main apenas se não achar nenhum
      const nodes = document.querySelectorAll('.section-item').length
        ? document.querySelectorAll('.section-item')
        : document.querySelectorAll('li.section.main');

      const seen = new Set();
      return [...nodes]
        .map(sec => {
          const titleEl = sec.querySelector('.sectionname a, .sectionname');
          const name = titleEl?.textContent.trim() ?? '';
          return { el: sec, name };
        })
        .filter(s => {
          if (!s.name || seen.has(s.name)) return false;
          seen.add(s.name);
          return true;
        });
    }

  function findSection(sections, query) {
    return sections.find(s =>
      s.name.toLowerCase().includes(query.toLowerCase())
    ) ?? null;
  }

  async function collectDownloads(section) {
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
  //  UI — MODAL DE SELEÇÃO DE SEÇÃO
  // ════════════════════════════════════════════════

  const CSS = `
    #gm-overlay { position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:999998;display:flex;align-items:center;justify-content:center }
    #gm-modal { background:#fff;border-radius:12px;padding:24px;width:420px;max-width:90vw;box-shadow:0 8px 32px rgba(0,0,0,.35);font-family:sans-serif;z-index:999999 }
    #gm-modal h2 { margin:0 0 4px;font-size:17px;color:#009cde }
    #gm-modal p  { margin:0 0 14px;font-size:13px;color:#666 }
    #gm-search { width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #ccc;border-radius:7px;font-size:14px;outline:none }
    #gm-search:focus { border-color:#009cde;box-shadow:0 0 0 3px rgba(0,156,222,.15) }
    #gm-suggestions { list-style:none;margin:6px 0 0;padding:0;max-height:180px;overflow-y:auto;border:1px solid #eee;border-radius:7px;display:none }
    #gm-suggestions li { padding:9px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f0f0f0 }
    #gm-suggestions li:last-child { border-bottom:none }
    #gm-suggestions li:hover, #gm-suggestions li.active { background:#e8f6fd }
    #gm-suggestions li b { color:#009cde }
    #gm-modal-footer { display:flex;gap:8px;margin-top:14px }
    .gm-btn { flex:1;padding:9px;border:none;border-radius:7px;font-size:14px;cursor:pointer;font-weight:600 }
    .gm-btn-primary { background:#009cde;color:#fff }
    .gm-btn-primary:disabled { background:#aaa;cursor:not-allowed }
    .gm-btn-secondary { background:#f0f0f0;color:#555 }
    .gm-btn-primary:hover:not(:disabled) { background:#007ab8 }
  `;

  function highlight(text, query) {
    if (!query) return text;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return text.replace(re, '<b>$1</b>');
  }

  function showSectionPicker(sections) {
    return new Promise((resolve) => {
      // Injeta CSS
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);

      // Monta overlay + modal
      const overlay = document.createElement('div');
      overlay.id = 'gm-overlay';
      overlay.innerHTML = `
        <div id="gm-modal">
          <h2>⬇ Download por Seção</h2>
          <p>Digite o nome (ou parte) da seção que deseja baixar:</p>
          <input id="gm-search" type="text" placeholder="Ex: Aula 1, Materiais…" autocomplete="off" />
          <ul id="gm-suggestions"></ul>
          <div id="gm-modal-footer">
            <button class="gm-btn gm-btn-secondary" id="gm-cancel">Cancelar</button>
            <button class="gm-btn gm-btn-primary" id="gm-confirm" disabled>Baixar Seção</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const input   = overlay.querySelector('#gm-search');
      const sugList = overlay.querySelector('#gm-suggestions');
      const btnOk   = overlay.querySelector('#gm-confirm');
      const btnCancel = overlay.querySelector('#gm-cancel');
      let selected  = null;

      function renderSuggestions(query) {
        sugList.innerHTML = '';
        const matches = query.length >= 1
          ? sections.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))
          : sections;

        if (!matches.length) { sugList.style.display = 'none'; return; }

        matches.slice(0, 10).forEach(s => {
          const li = document.createElement('li');
          li.innerHTML = highlight(s.name, query);
          li.addEventListener('click', () => {
            input.value = s.name;
            selected = s;
            sugList.style.display = 'none';
            btnOk.disabled = false;
          });
          sugList.appendChild(li);
        });
        sugList.style.display = 'block';
      }

      // Mostra todas as seções ao focar no input
      input.addEventListener('focus', () => renderSuggestions(input.value));

      input.addEventListener('input', () => {
        selected = null;
        btnOk.disabled = true;
        renderSuggestions(input.value);
      });

      // Fechar sugestões ao clicar fora
      document.addEventListener('click', e => {
        if (!overlay.querySelector('#gm-modal').contains(e.target)) return;
        if (e.target !== input) sugList.style.display = 'none';
      });

      // Confirmar com Enter
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && selected) btnOk.click();
        if (e.key === 'Escape') btnCancel.click();
      });

      btnOk.addEventListener('click', () => {
        overlay.remove();
        style.remove();
        resolve(selected);
      });

      btnCancel.addEventListener('click', () => {
        overlay.remove();
        style.remove();
        resolve(null);
      });

      // Foca automaticamente
      setTimeout(() => input.focus(), 50);
    });
  }

  // ════════════════════════════════════════════════
  //  UI — PAINEL DE PROGRESSO
  // ════════════════════════════════════════════════

  function buildProgressPanel(sectionName) {
    document.getElementById('gm-dl-panel')?.remove();
    const el = document.createElement('div');
    el.id = 'gm-dl-panel';
    Object.assign(el.style, {
      position:'fixed', bottom:'20px', right:'20px',
      width:'380px', maxHeight:'75vh', overflowY:'auto',
      background:'#fff', border:'2px solid #009cde',
      borderRadius:'10px', boxShadow:'0 4px 20px rgba(0,0,0,.3)',
      zIndex:'99999', fontFamily:'sans-serif', fontSize:'13px', padding:'14px',
    });
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="color:#009cde;font-size:15px">⬇ ${sectionName}</b>
        <button id="gm-close" style="background:none;border:none;font-size:18px;cursor:pointer">✕</button>
      </div>
      <div id="gm-status" style="color:#555;margin-bottom:10px">Iniciando…</div>
      <ul id="gm-list" style="list-style:none;padding:0;margin:0"></ul>`;
    document.body.appendChild(el);
    el.querySelector('#gm-close').onclick = () => el.remove();
    return el;
  }

  function addRow(list, label, state = 'pending') {
    const icons = { pending:'⏳', resolving:'🔍', downloading:'⬇', done:'✅', error:'❌', folder:'📂' };
    const li = document.createElement('li');
    li.style.cssText = 'padding:4px 0;border-bottom:1px solid #eee;display:flex;gap:6px;align-items:flex-start';
    li.innerHTML = `<span class="ic">${icons[state]}</span><span style="word-break:break-word">${label}</span>`;
    list.appendChild(li);
    return { el: li, set(s) { li.querySelector('.ic').textContent = icons[s] ?? s; } };
  }

  // ════════════════════════════════════════════════
  //  ORQUESTRADOR DE DOWNLOADS
  // ════════════════════════════════════════════════

  // Fallback: abre aba, espera o redirect acontecer e fecha
  // Sem focar na aba — usa background tab via window.open com _blank
  function resolveViaTab(intermediaryUrl) {
    return new Promise((resolve) => {
      // Abre sem focar
      const tab = window.open(intermediaryUrl, '_blank', 'noopener,noreferrer,width=1,height=1,left=-100,top=-100');

      if (!tab) return resolve(null); // popup bloqueado

      let tries = 0;
      const poll = setInterval(() => {
        tries++;
        try {
          const url = tab.location.href;
          // Quando o redirect para pluginfile acontece, capturamos
          if (url && url.includes('pluginfile.php')) {
            clearInterval(poll);
            tab.close();
            return resolve(url);
          }
        } catch {
          // Cross-origin block — significa que o redirect já foi para o arquivo
          // Nesse caso a finalUrl não é acessível, usa a URL do GM como fallback
        }

        if (tries > 30) { // timeout ~3s
          clearInterval(poll);
          try { tab.close(); } catch {}
          resolve(null);
        }
      }, 100);
    });
  }
  async function runDownloads(section) {
    const panel  = buildProgressPanel(section.name);
    const status = panel.querySelector('#gm-status');
    const list   = panel.querySelector('#gm-list');

    const items = await collectDownloads(section);
    status.textContent = `${items.length} item(s) encontrado(s). Baixando…`;
    const rows = items.map(item => addRow(list, item.label));

    const folderName = sanitize(section.name);
    let ok = 0, fail = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row  = rows[i];
      status.textContent = `Processando ${i + 1}/${items.length}…`;

      if (item.type === 'resource') {
        row.set('resolving');
        let dlUrl = null;
        try { dlUrl = await resolveResource(item.href); } catch {}

        if (!dlUrl) {
          // Fallback: abre aba silenciosa, captura redirect e fecha
          dlUrl = await resolveViaTab(item.href);
        }

        if (!dlUrl) { row.set('error'); fail++; continue; }

        const fileName = sanitize(
          decodeURIComponent(dlUrl.split('/').pop().split('?')[0]) || item.label
        );
        row.set('downloading');
        await new Promise(resolve => {
          GM_download({
            url: dlUrl,
            name: `${folderName}/${fileName}`,
            saveAs: false,
            headers: { 'Referer': location.href },
            onload:  () => { row.set('done');  ok++;   resolve(); },
            onerror: (e) => {
              console.warn('GM_download erro:', e, dlUrl);
              row.set('error'); fail++; resolve();
            },
          });
        });

      } else if (item.type === 'folder') {
        row.set('resolving');
        let files = [];
        try { files = await resolveFolder(item.href); } catch {}
        if (!files.length) { row.set('error'); fail++; continue; }

        row.set('folder');
        row.el.querySelector('span:last-child').textContent = `${item.label} (${files.length} arquivos)`;

        for (const f of files) {
          const subRow   = addRow(list, `  ↳ ${f.name}`, 'downloading');
          const fileName = sanitize(decodeURIComponent(f.url.split('/').pop().split('?')[0]) || f.name);
          await new Promise(resolve => {
            GM_download({
              url: f.url,
              name: `${folderName}/${sanitize(item.label)}/${fileName}`,
              saveAs: false,
              onload:  () => { subRow.set('done');  ok++;   resolve(); },
              onerror: () => { subRow.set('error'); fail++; resolve(); },
            });
          });
          await sleep(DELAY_MS);
        }
      }
      await sleep(DELAY_MS);
    }

    status.textContent = `✅ Concluído — ${ok} baixados, ${fail} com erro.`;
  }

  // ════════════════════════════════════════════════
  //  ENTRADA — BOTÃO FLUTUANTE
  // ════════════════════════════════════════════════

  const launcher = document.createElement('button');
  launcher.textContent = '⬇ Baixar Seção';
  Object.assign(launcher.style, {
    position:'fixed', bottom:'20px', left:'20px',
    background:'#009cde', color:'#fff', border:'none',
    borderRadius:'8px', padding:'10px 16px', cursor:'pointer',
    zIndex:'99999', fontFamily:'sans-serif', fontSize:'14px',
    boxShadow:'0 2px 8px rgba(0,0,0,.3)',
  });

  launcher.addEventListener('click', async () => {
    const sections = getAllSections();
    if (!sections.length) {
      alert('Nenhuma seção encontrada nesta página.');
      return;
    }
    const chosen = await showSectionPicker(sections);
    if (!chosen) return;
    await runDownloads(chosen);
  });

  document.body.appendChild(launcher);

})();
