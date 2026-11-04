// Aba Atendimento: painel do mês, listas, clientes (CRM) e fichas por área.
// Rascunhos são gravados direto no banco; concluir, "não fechou", distribuir e reabrir
// passam pela função "atendimento", que agenda a distribuição e grava o .md no GitHub.
// Usa as utilidades de app.js ($, esc, sb, estado, avisar...), carregado depois deste arquivo.

const REPO_ATENDIMENTOS = "edmopeixotoadv-ship-it/supralex-atendimentos";
const SITUACOES_AT = {
  em_atendimento: "Em atendimento",
  aguardando_distribuicao: "Aguardando distribuição",
  distribuida: "Distribuída",
  nao_fechou: "Não fechou",
};
const NOMES_AREA = Object.fromEntries(AREAS_ATENDIMENTO.map((a) => [a.area, a.rotulo]));

const at = {
  lista: [],
  clientes: [],
  carregado: false,
  filtro: "abertos",
  mes: null,
  ficha: null, // { atendimento, modelo, versao, salva, somenteLeitura }
  tempo: null,
  fila: Promise.resolve(true),
  acao: null,
};

// ------------------------------------------------------------- utilidades

function digitos(s) { return String(s ?? "").replace(/\D/g, ""); }

function normalizarNome(s) {
  return semAcento(s).replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(ltda|me|epp|eireli|s ?a|sa|cia)\b/g, " ").replace(/\s+/g, " ").trim();
}

function formatarCPF(s) {
  const d = digitos(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return s;
}

function somarAnos(iso, n) { return `${Number(iso.slice(0, 4)) + n}${iso.slice(4)}`; }

function camposDaFicha(modelo) { return modelo.secoes.flatMap((s) => s.campos); }

function tituloAtendimento(a) {
  const contraria = a.partes_contrarias?.[0];
  return `${a.cliente_nome || "Cliente sem nome"}${contraria ? ` × ${contraria}` : ""}${a.partes_contrarias?.length > 1 ? ` e outra(s)` : ""}`;
}

function linkArquivo(a) {
  return `https://github.com/${REPO_ATENDIMENTOS}/blob/main/${a.arquivo_md.split("/").map(encodeURIComponent).join("/")}`;
}

// ------------------------------------------------------------- carga

async function carregarAtendimentos() {
  const [a, c] = await Promise.all([
    sb.from("atendimentos").select("*").order("data_atendimento", { ascending: false })
      .order("criado_em", { ascending: false }).limit(3000),
    sb.from("clientes").select("*").order("nome").limit(5000),
  ]);
  if (a.error) {
    $("at-lista").innerHTML = `<div class="vazio">Não foi possível carregar os atendimentos: ${esc(a.error.message)}</div>`;
    return;
  }
  at.lista = a.data;
  at.clientes = c.data || [];
  at.carregado = true;
  renderizarAtendimentos();
}

function guardarAtendimento(a) {
  const i = at.lista.findIndex((x) => x.id === a.id);
  if (i >= 0) at.lista[i] = a; else at.lista.unshift(a);
}

// ------------------------------------------------------------- rotas

function rotearAtendimento(id, extra) {
  if (!id) {
    at.ficha = null;
    $("at-painel").hidden = false;
    $("at-ficha").hidden = true;
    renderizarAtendimentos();
    return;
  }
  if (id === "novo") {
    if (!pode("atendimento", 2)) { location.hash = "#atendimento"; return; }
    return abrirFicha({ ficha: extra, dados: {} });
  }
  if (at.ficha?.atendimento.id === id) return;
  if (!at.carregado) return; // carregarAtendimentos chama rotear de novo ao terminar
  const a = at.lista.find((x) => x.id === id);
  if (a) abrirFicha(a);
  else { avisar("Atendimento não encontrado."); location.hash = "#atendimento"; }
}

// ------------------------------------------------------------- painel e listas

function renderizarAtendimentos() {
  if (!at.carregado) return;
  const mes = at.mes || hoje().slice(0, 7);
  const dHoje = hoje();
  const noMes = (iso) => iso && diaLocal(iso).startsWith(mes);
  const fechados = at.lista.filter((a) => noMes(a.concluido_em) && ["aguardando_distribuicao", "distribuida"].includes(a.situacao));
  const naoFechou = at.lista.filter((a) => noMes(a.concluido_em) && a.situacao === "nao_fechou");
  const distribuidas = at.lista.filter((a) => a.distribuida_em?.startsWith(mes));
  const aguardando = at.lista.filter((a) => a.situacao === "aguardando_distribuicao");
  const atrasadas = aguardando.filter((a) => a.data_prevista && a.data_prevista < dHoje);
  const decididos = fechados.length + naoFechou.length;

  $("at-mes").textContent = new Date(`${mes}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  $("at-n-fechados").textContent = fechados.length;
  $("at-n-distribuidas").textContent = distribuidas.length;
  $("at-n-conversao").textContent = decididos ? `${Math.round((100 * fechados.length) / decididos)}%` : "–";
  $("at-r-conversao").textContent = decididos ? `Conversão (${fechados.length} de ${decididos})` : "Conversão";
  $("at-n-aguardando").textContent = aguardando.length;
  $("at-r-aguardando").innerHTML = atrasadas.length
    ? `Aguardando distribuição · <span class="atrasado">${atrasadas.length} atrasada(s)</span>` : "Aguardando distribuição";

  document.querySelectorAll("[data-at-filtro]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.atFiltro === at.filtro));
  const busca = normalizarNome($("at-busca").value);
  const buscaDoc = digitos($("at-busca").value);

  if (at.filtro === "clientes") return renderizarClientes(busca, buscaDoc);

  const situacoes = {
    abertos: ["em_atendimento", "aguardando_distribuicao"],
    distribuidas: ["distribuida"],
    nao_fechou: ["nao_fechou"],
  }[at.filtro];
  const lista = at.lista.filter((a) => situacoes.includes(a.situacao)).filter((a) => {
    if (!busca && !buscaDoc) return true;
    const alvo = normalizarNome([a.cliente_nome, ...(a.partes_contrarias || []), a.processo].join(" "));
    return (busca && busca.split(" ").every((t) => alvo.includes(t))) ||
      (buscaDoc.length >= 5 && [...(a.documentos_contrarios || []), digitos(a.processo)].some((d) => d.includes(buscaDoc)));
  });
  if (at.filtro === "abertos") {
    // os que aguardam distribuição primeiro, pela data prevista; depois os rascunhos
    lista.sort((x, y) => (x.situacao === y.situacao
      ? (x.data_prevista || "").localeCompare(y.data_prevista || "")
      : x.situacao === "aguardando_distribuicao" ? -1 : 1));
  }
  $("at-lista").innerHTML = lista.length ? lista.map(itemAtendimento).join("")
    : `<div class="vazio">${busca || buscaDoc ? "Nenhum atendimento encontrado." : "Nenhum atendimento aqui ainda."}</div>`;
}

function seloSituacao(a) {
  const atrasada = a.situacao === "aguardando_distribuicao" && a.data_prevista && a.data_prevista < hoje();
  let texto = SITUACOES_AT[a.situacao];
  if (a.situacao === "aguardando_distribuicao" && a.data_prevista) texto += ` · prevista ${dataBR(a.data_prevista)}`;
  if (a.situacao === "distribuida") texto += ` em ${dataBR(a.distribuida_em)}`;
  return `<span class="selo-at ${a.situacao}${atrasada ? " atrasado" : ""}">${esc(texto)}</span>`;
}

function itemAtendimento(a) {
  const sub = [
    NOMES_AREA[a.area],
    a.atendente && `Atendente: ${nomePessoa(a.atendente)}`,
    a.processo && `Processo ${a.processo}`,
    a.motivo_nao_fechou && `Motivo: ${a.motivo_nao_fechou}`,
  ].filter(Boolean).map(esc).join(" · ");
  return `
  <article class="at-item ${a.situacao}">
    <a class="at-link" href="#atendimento/${esc(a.id)}">
      <span class="at-data">${dataBR(a.data_atendimento)}</span>
      <span class="at-info">
        <span class="at-titulo">${esc(tituloAtendimento(a))}</span>
        <span class="at-sub">${sub}</span>
      </span>
    </a>
    <span class="at-acoes">
      ${seloSituacao(a)}
      ${a.situacao === "aguardando_distribuicao" && pode("atendimento", 3) ? `<button class="botao-sec" data-distribuir="${esc(a.id)}">Registrar distribuição</button>` : ""}
      ${botaoHonorarios(a)}
    </span>
  </article>`;
}

// contrato fechado: atalho para cadastrar (ou ver) os honorários no Financeiro
function botaoHonorarios(a) {
  if (!["aguardando_distribuicao", "distribuida"].includes(a.situacao) || !pode("financeiro")) return "";
  const contrato = fin.contratos.find((c) => c.atendimento_id === a.id);
  if (contrato) return `<a class="botao-sec" href="#financeiro/contrato/${esc(contrato.id)}">💰 Honorários</a>`;
  return pode("financeiro", 2) ? `<a class="botao-sec" href="#financeiro/contrato/novo/${esc(a.id)}">💰 Cadastrar honorários</a>` : "";
}

function renderizarClientes(busca, buscaDoc) {
  const lista = at.clientes.filter((c) => {
    if (!busca && !buscaDoc) return true;
    return (busca && busca.split(" ").every((t) => normalizarNome(c.nome).includes(t))) ||
      (buscaDoc.length >= 5 && (c.documento || "").includes(buscaDoc));
  });
  if (!lista.length) {
    $("at-lista").innerHTML = '<div class="vazio">Nenhum cliente encontrado. Os clientes entram aqui sozinhos quando um atendimento é salvo.</div>';
    return;
  }
  $("at-lista").innerHTML = lista.map((c) => {
    const atendimentos = at.lista.filter((a) => a.cliente_id === c.id);
    const contato = [c.documento && formatarCPF(c.documento), c.telefone, c.email].filter(Boolean).map(esc).join(" · ");
    return `
    <article class="cliente">
      <div class="cliente-cab"><strong>${esc(c.nome)}</strong><span class="at-sub">${contato}</span></div>
      ${c.endereco ? `<div class="at-sub">${esc(c.endereco)}</div>` : ""}
      <ul class="cliente-atendimentos">${atendimentos.map((a) =>
        `<li><a href="#atendimento/${esc(a.id)}">${dataBR(a.data_atendimento)} · ${esc(NOMES_AREA[a.area])}${a.partes_contrarias?.[0] ? ` × ${esc(a.partes_contrarias[0])}` : ""}</a> ${seloSituacao(a)}</li>`).join("")}</ul>
    </article>`;
  }).join("");
}

function navegarMes(sentido) {
  const d = new Date(`${(at.mes || hoje().slice(0, 7))}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + sentido);
  at.mes = d.toISOString().slice(0, 7);
  renderizarAtendimentos();
}

function escolherArea() {
  $("dat-titulo").textContent = "Novo atendimento";
  $("dat-ok").hidden = true;
  $("dat-corpo").innerHTML = '<p class="at-sub">Escolha a área. Cada uma abre a ficha própria.</p>' +
    AREAS_ATENDIMENTO.map((a) => `
      <div class="area-escolha">
        <strong>${esc(a.rotulo)}</strong>
        ${a.fichas.length
          ? a.fichas.map((f) => `<a class="botao" href="#atendimento/novo/${esc(f.id)}" data-fechar>${esc(f.rotulo)}</a>`).join("")
          : '<span class="em-breve">em breve</span>'}
      </div>`).join("");
  at.acao = null;
  $("dlg-at").showModal();
}

// ------------------------------------------------------------- ficha: montagem

function campoHTML(c, v) {
  const id = esc(c.id);
  const largo = c.largo || ["area", "opcoes", "tabela", "grupo", "pedidos", "nota"].includes(c.tipo) ? " largo" : "";
  switch (c.tipo) {
    case "nota":
      return `<p class="nota largo">${esc(c.texto)}</p>`;
    case "area":
      return `<label class="campo${largo}">${esc(c.rotulo)}<textarea data-c="${id}" rows="${c.linhas || 3}">${esc(v || "")}</textarea></label>`;
    case "pessoa":
      return `<label class="campo">${esc(c.rotulo)}<select data-c="${id}">${estado.equipe.map((p) =>
        `<option value="${esc(p.email)}" ${p.email === v ? "selected" : ""}>${esc(p.nome || p.email)}</option>`).join("")}</select></label>`;
    case "opcao":
    case "opcoes": {
      const marcados = Array.isArray(v) ? v : v ? [v] : [];
      const conflito = c.conflito
        ? '<button type="button" class="botao-sec" data-conflito>Verificar agora</button><div class="conflito-res" id="conflito-res" hidden></div>' : "";
      return `<div class="campo${c.tipo === "opcoes" || c.opcoes.length > 3 ? " largo" : ""}"><span>${esc(c.rotulo)}</span>
        <div class="escolhas${c.colunas ? " colunas" : ""}" data-c="${id}" data-tipo="${c.tipo}">${c.opcoes.map((o) =>
          `<label class="escolha"><input type="checkbox" value="${esc(o)}" ${marcados.includes(o) ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>${conflito}</div>`;
    }
    case "tabela": {
      const salvas = Array.isArray(v) ? v : [];
      const linhas = c.fixas
        ? c.fixas.map((rotulo) => ({ linha: rotulo, ...(salvas.find((l) => l.linha === rotulo) || {}) }))
        : Array.from({ length: Math.max(c.linhas || 1, salvas.length) }, (_, i) => salvas[i] || {});
      return `<div class="campo largo"><span>${esc(c.rotulo)}</span>
        <div class="tabela-rolagem"><table class="tabela" data-c="${id}">
          <thead><tr>${c.fixas ? "<th>Dia</th>" : ""}${c.colunas.map((col) => `<th>${esc(col.rotulo)}</th>`).join("")}</tr></thead>
          <tbody>${linhas.map((l) => linhaTabela(c, l)).join("")}</tbody>
        </table></div>
        ${c.adicionar ? `<button type="button" class="botao-sec mini" data-mais-linha="${id}">+ ${esc(c.adicionar)}</button>` : ""}</div>`;
    }
    case "grupo": {
      const itens = Array.isArray(v) && v.length ? v : [];
      while (itens.length < (c.minimo || 1)) itens.push({});
      return `<div class="largo repete" data-c="${id}">${itens.map((item, i) => itemGrupo(c, item, i)).join("")}</div>
        <button type="button" class="botao-sec mini largo-auto" data-mais-item="${id}">+ ${esc(c.adicionar)}</button>`;
    }
    case "pedidos": {
      const salvos = v || {};
      return `<div class="largo tabela-rolagem"><table class="tabela pedidos" data-c="${id}">
        <thead><tr><th>Cód.</th><th>Pedido</th><th>Aplica</th><th>Fatos e dados para cálculo</th><th>Risco</th></tr></thead>
        <tbody>${c.itens.map(([cod, nome]) => {
          const p = salvos[cod] || {};
          return `<tr data-cod="${cod}" class="${p.aplica ? "aplica" : ""}"><td>${cod}</td><td>${esc(nome)}</td>
            <td><input type="checkbox" data-p="aplica" aria-label="${esc(nome)} se aplica" ${p.aplica ? "checked" : ""}></td>
            <td><input data-p="fatos" aria-label="Fatos de ${esc(nome)}" value="${esc(p.fatos || "")}"></td>
            <td><select data-p="risco" aria-label="Risco de ${esc(nome)}">${["", "B", "M", "A"].map((r) =>
              `<option ${p.risco === r ? "selected" : ""}>${r}</option>`).join("")}</select></td></tr>`;
        }).join("")}</tbody></table></div>`;
    }
    default: {
      const tipo = { data: "date", hora: "time", numero: "number" }[c.tipo] || "text";
      const extra = c.tipo === "valor" ? ' inputmode="decimal"' : c.mascara ? ' inputmode="numeric"' : "";
      return `<label class="campo${largo}">${esc(c.rotulo)}${c.obrigatorio ? " *" : ""}<input type="${tipo}" data-c="${id}"${extra} value="${esc(v || "")}"${c.dica ? ` placeholder="${esc(c.dica)}"` : ""}></label>`;
    }
  }
}

function linhaTabela(c, l) {
  return `<tr${l.linha ? ` data-linha="${esc(l.linha)}"` : ""}>${l.linha ? `<th scope="row">${esc(l.linha)}</th>` : ""}${c.colunas.map((col) => {
    const v = l[col.id] || "";
    const rotulo = esc(`${col.rotulo}${l.linha ? ` – ${l.linha}` : ""}`);
    if (col.opcoes) {
      return `<td><select data-col="${esc(col.id)}" aria-label="${rotulo}">${col.opcoes.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></td>`;
    }
    return `<td><input data-col="${esc(col.id)}" aria-label="${rotulo}"${col.hora ? ' type="time"' : ""} value="${esc(v)}"></td>`;
  }).join("")}</tr>`;
}

function itemGrupo(c, item, i) {
  return `<div class="repete-item">
    <div class="repete-cab"><strong>${esc(c.rotulo)} ${i + 1}</strong>${i >= (c.minimo || 1) ? '<button type="button" class="botao-sec mini" data-remover-item>Remover</button>' : ""}</div>
    <div class="campos">${c.campos.map((sub) => campoHTML(sub, item[sub.id])).join("")}</div>
  </div>`;
}

function abrirFicha(a) {
  const modelo = FICHAS[a.ficha];
  if (!modelo) { avisar("Ficha desconhecida."); location.hash = "#atendimento"; return; }
  const atendimento = a.id ? a : { ficha: a.ficha, area: modelo.area, situacao: "em_atendimento", dados: {} };
  const dados = { ...atendimento.dados };
  if (!a.id) {
    dados[modelo.dataAtendimento] = hoje();
    dados[modelo.atendente] = estado.eu;
  }
  at.ficha = { atendimento, modelo, versao: 0, salva: 0,
    somenteLeitura: atendimento.situacao !== "em_atendimento" || !pode("atendimento", 2) };
  $("at-painel").hidden = true;
  $("at-ficha").hidden = false;
  $("ficha-titulo").textContent = `${NOMES_AREA[modelo.area]} · ${modelo.titulo}`;
  $("ficha-instrucao").textContent = modelo.instrucao || "";
  $("ficha-indice").innerHTML = modelo.secoes.map((s, i) => `<a href="#" data-secao="${i}">${i + 1}. ${esc(s.titulo)}</a>`).join("");
  $("ficha-campos").innerHTML = modelo.secoes.map((s, i) => `
    <section class="secao" id="secao-${i}">
      <h3>${i + 1}. ${esc(s.titulo)}</h3>
      <div class="campos">${s.campos.map((c) => campoHTML(c, dados[c.id])).join("")}</div>
    </section>`).join("");
  atualizarCabecalhoFicha();
  window.scrollTo(0, 0);
}

function atualizarCabecalhoFicha() {
  const { atendimento: a, somenteLeitura } = at.ficha;
  $("ficha-campos").disabled = somenteLeitura;
  $("ficha-salvar").hidden = somenteLeitura;
  $("ficha-concluir").hidden = somenteLeitura || !pode("atendimento", 3);
  $("ficha-distribuir").hidden = a.situacao !== "aguardando_distribuicao" || !pode("atendimento", 3);
  $("ficha-reabrir").hidden = !["aguardando_distribuicao", "nao_fechou"].includes(a.situacao) || !pode("atendimento", 3);
  $("ficha-situacao").innerHTML = a.id ? seloSituacao(a) : '<span class="selo-at em_atendimento">Novo</span>';
  const avisos = [];
  if (a.situacao === "aguardando_distribuicao") {
    avisos.push(`Contrato fechado em ${dataBR(diaLocal(a.concluido_em))} por ${esc(nomePessoa(a.concluido_por))}. ` +
      `Distribuição prevista para <strong>${dataBR(a.data_prevista)}</strong>` +
      (a.compromisso_id ? ` · <a href="#agenda/${esc(a.compromisso_id)}">ver na agenda</a>` : "") + ".");
  }
  if (a.situacao === "distribuida") avisos.push(`Distribuída em ${dataBR(a.distribuida_em)} · processo <strong>${esc(a.processo)}</strong>.`);
  if (a.situacao === "nao_fechou") avisos.push(`Não fechou contrato${a.motivo_nao_fechou ? `: ${esc(a.motivo_nao_fechou)}` : ""}.`);
  if (a.arquivo_md) avisos.push(`Ficha em Markdown: <a href="${esc(linkArquivo(a))}" target="_blank" rel="noopener">abrir no GitHub</a>.`);
  if (a.arquivo_erro) avisos.push(`<span class="erro">⚠ O arquivo .md não foi gravado: ${esc(a.arquivo_erro)}</span>`);
  if (!pode("atendimento", 2)) avisos.push("Você pode consultar esta ficha, mas não alterá-la.");
  else if (somenteLeitura && a.situacao !== "distribuida") avisos.push("A ficha está travada. Para corrigir, use “Reabrir”.");
  $("ficha-aviso").hidden = !avisos.length;
  $("ficha-aviso").innerHTML = avisos.join("<br>");
  $("ficha-estado").textContent = a.atualizado_em
    ? `Salvo por ${nomePessoa(a.atualizado_por)} em ${new Date(a.atualizado_em).toLocaleString("pt-BR")}` : "Ainda não salvo";
}

// ------------------------------------------------------------- ficha: leitura e gravação

function lerCampos(raiz, campos) {
  const d = {};
  for (const c of campos) {
    if (c.tipo === "nota") continue;
    const el = raiz.querySelector(`[data-c="${c.id}"]`);
    if (!el) continue;
    if (c.tipo === "opcao") d[c.id] = el.querySelector("input:checked")?.value || "";
    else if (c.tipo === "opcoes") d[c.id] = [...el.querySelectorAll("input:checked")].map((i) => i.value);
    else if (c.tipo === "grupo") d[c.id] = [...el.querySelectorAll(":scope > .repete-item")].map((item) => lerCampos(item, c.campos));
    else if (c.tipo === "tabela") {
      d[c.id] = [...el.querySelectorAll("tbody tr")].map((tr) => {
        const l = tr.dataset.linha ? { linha: tr.dataset.linha } : {};
        for (const col of c.colunas) l[col.id] = tr.querySelector(`[data-col="${col.id}"]`).value.trim();
        return l;
      });
    } else if (c.tipo === "pedidos") {
      d[c.id] = {};
      for (const tr of el.querySelectorAll("tr[data-cod]")) {
        const p = {
          aplica: tr.querySelector('[data-p="aplica"]').checked,
          fatos: tr.querySelector('[data-p="fatos"]').value.trim(),
          risco: tr.querySelector('[data-p="risco"]').value,
        };
        if (p.aplica || p.fatos || p.risco) d[c.id][tr.dataset.cod] = p;
      }
    } else d[c.id] = el.value.trim();
  }
  return d;
}

function lerFicha() { return lerCampos($("ficha-campos"), camposDaFicha(at.ficha.modelo)); }

async function gravarCliente(id, c) {
  const registro = {
    nome: c.nome, documento: digitos(c.documento) || null,
    telefone: c.telefone || null, email: c.email || null, endereco: c.endereco || null,
  };
  if (!id && registro.documento) id = at.clientes.find((x) => x.documento === registro.documento)?.id;
  let r = id
    ? await sb.from("clientes").update(registro).eq("id", id).select().single()
    : await sb.from("clientes").insert(registro).select().single();
  if (r.error?.code === "23505") {
    // o CPF já pertence a outro cliente cadastrado: passa a usar aquele
    r = await sb.from("clientes").update(registro).eq("documento", registro.documento).select().single();
  }
  if (r.error) throw new Error(`cliente: ${r.error.message}`);
  const i = at.clientes.findIndex((x) => x.id === r.data.id);
  if (i >= 0) at.clientes[i] = r.data; else at.clientes.push(r.data);
  at.clientes.sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));
  return r.data.id;
}

async function gravarFicha(f, dados, versao) {
  if (!f || f.somenteLeitura) return true;
  const m = f.modelo;
  const nome = dados[m.cliente.nome];
  const contrarias = (dados[m.contrarias.grupo] || [])
    .map((r) => ({ nome: r[m.contrarias.nome] || "", doc: digitos(r[m.contrarias.documento]) }))
    .filter((p) => p.nome || p.doc);
  const visivel = () => at.ficha === f;
  if (visivel()) $("ficha-estado").textContent = "Salvando…";
  try {
    const clienteId = nome
      ? await gravarCliente(f.atendimento.cliente_id, Object.fromEntries(Object.entries(m.cliente).map(([k, campo]) => [k, dados[campo]])))
      : f.atendimento.cliente_id ?? null;
    const linha = {
      cliente_id: clienteId,
      cliente_nome: nome || null,
      partes_contrarias: contrarias.map((p) => p.nome).filter(Boolean),
      documentos_contrarios: contrarias.map((p) => p.doc).filter(Boolean),
      data_atendimento: dados[m.dataAtendimento] || hoje(),
      atendente: dados[m.atendente] || estado.eu,
      dados,
    };
    const r = f.atendimento.id
      ? await sb.from("atendimentos").update(linha).eq("id", f.atendimento.id).select().single()
      : await sb.from("atendimentos").insert({ ...linha, area: m.area, ficha: f.atendimento.ficha }).select().single();
    if (r.error) throw new Error(r.error.message);
    const novo = !f.atendimento.id;
    f.atendimento = r.data;
    f.salva = versao;
    guardarAtendimento(r.data);
    if (!visivel()) return true; // usuário já saiu desta ficha
    if (novo && location.hash.startsWith("#atendimento/novo")) history.replaceState(null, "", `#atendimento/${r.data.id}`);
    atualizarCabecalhoFicha();
    if (f.versao !== versao) $("ficha-estado").textContent = "Alterações não salvas";
    return true;
  } catch (e) {
    if (visivel()) $("ficha-estado").textContent = "⚠ Não foi possível salvar";
    avisar(`Não foi possível salvar: ${e.message}`, 4500);
    return false;
  }
}

// lê a ficha na hora e grava em fila, para as gravações não correrem em paralelo
function salvarFicha() {
  clearTimeout(at.tempo);
  const f = at.ficha;
  if (!f || f.somenteLeitura) return Promise.resolve(true);
  const dados = lerFicha(), versao = f.versao;
  const gravar = () => gravarFicha(f, dados, versao);
  at.fila = at.fila.then(gravar, gravar);
  return at.fila;
}

function fichaAlterada() { return at.ficha && !at.ficha.somenteLeitura && at.ficha.versao !== at.ficha.salva; }

function marcarAlteracao() {
  const f = at.ficha;
  if (!f || f.somenteLeitura) return;
  f.versao++;
  $("ficha-estado").textContent = "Alterações não salvas";
  clearTimeout(at.tempo);
  at.tempo = setTimeout(salvarFicha, 3000);
}

// ------------------------------------------------------------- conflito de interesses

function verificarConflito() {
  const { modelo: m, atendimento: atual } = at.ficha;
  const dados = lerFicha();
  const nomeCliente = normalizarNome(dados[m.cliente.nome]);
  const docCliente = digitos(dados[m.cliente.documento]);
  const contrarias = (dados[m.contrarias.grupo] || [])
    .map((r) => ({ nome: r[m.contrarias.nome] || "", chave: normalizarNome(r[m.contrarias.nome]), doc: digitos(r[m.contrarias.documento]) }))
    .filter((p) => p.chave || p.doc);
  if (!nomeCliente && !docCliente && !contrarias.length) {
    avisar("Preencha o nome do cliente e das partes contrárias antes de verificar.");
    return;
  }
  const conflitos = [];
  const informacoes = [];
  for (const p of contrarias) {
    const cliente = at.clientes.find((c) => c.id !== atual.cliente_id &&
      ((p.doc && c.documento === p.doc) || (p.chave && normalizarNome(c.nome) === p.chave)));
    if (cliente) conflitos.push(`${p.nome || formatarCPF(p.doc)} já é cliente do escritório (${cliente.nome}).`);
  }
  for (const a of at.lista) {
    if (a.id === atual.id) continue;
    const contra = (docCliente && (a.documentos_contrarios || []).includes(docCliente)) ||
      (nomeCliente && (a.partes_contrarias || []).some((n) => normalizarNome(n) === nomeCliente));
    if (contra) conflitos.push(`O cliente aparece como parte contrária no atendimento de ${dataBR(a.data_atendimento)} (${a.cliente_nome || "sem nome"}).`);
    const mesmaContraria = contrarias.some((p) => (p.doc && (a.documentos_contrarios || []).includes(p.doc)) ||
      (p.chave && (a.partes_contrarias || []).some((n) => normalizarNome(n) === p.chave)));
    if (mesmaContraria) informacoes.push(`Mesma parte contrária no atendimento de ${dataBR(a.data_atendimento)} (${a.cliente_nome || "sem nome"}, ${SITUACOES_AT[a.situacao].toLowerCase()}).`);
    else if (atual.cliente_id && a.cliente_id === atual.cliente_id) informacoes.push(`Atendimento anterior do mesmo cliente em ${dataBR(a.data_atendimento)}.`);
  }
  const caixa = $("conflito-res");
  caixa.hidden = false;
  caixa.className = `conflito-res ${conflitos.length ? "erro" : "ok"}`;
  caixa.innerHTML = (conflitos.length ? `<strong>⚠ Possível conflito:</strong><br>${conflitos.map(esc).join("<br>")}`
    : "Nenhum conflito encontrado nos clientes e atendimentos cadastrados.") +
    (informacoes.length ? `<div class="at-sub">${informacoes.map(esc).join("<br>")}</div>` : "");
  const resposta = conflitos.length ? "Há conflito" : "Sem conflito";
  const escolhas = $("ficha-campos").querySelector(`[data-c="${m.conflito}"]`);
  escolhas.querySelectorAll("input").forEach((i) => (i.checked = i.value === resposta));
  marcarAlteracao();
}

// ------------------------------------------------------------- Markdown

function celulaMD(s) { return String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"); }

function valorMD(c, v) {
  if (c.tipo === "data") return dataBR(v);
  if (c.tipo === "pessoa") return nomePessoa(v);
  if (c.tipo === "valor") return `R$ ${v}`;
  if (c.mascara) return formatarCPF(v);
  return v;
}

function camposMD(campos, d, nivel = 3) {
  const linhas = [];
  for (const c of campos) {
    const v = d[c.id];
    if (c.tipo === "nota") continue;
    if (c.tipo === "area") {
      if (v) linhas.push("", `**${c.rotulo}:**`, "", v.replace(/\r?\n/g, "  \n"), ""); // quebra de linha simples no Markdown
    } else if (c.tipo === "opcoes") {
      if (v?.length) linhas.push(`- **${c.rotulo}:** ${v.join("; ")}`);
    } else if (c.tipo === "grupo") {
      (v || []).forEach((item, i) => {
        const corpo = camposMD(c.campos, item, nivel + 1);
        if (corpo) linhas.push("", `${"#".repeat(nivel)} ${c.rotulo} ${i + 1}`, "", corpo);
      });
    } else if (c.tipo === "tabela") {
      const cheias = (v || []).filter((l) => c.colunas.some((col) => l[col.id]));
      if (cheias.length) {
        const cab = [...(c.fixas ? ["Dia"] : []), ...c.colunas.map((col) => col.rotulo)];
        linhas.push("", `**${c.rotulo}:**`, "", `| ${cab.map(celulaMD).join(" | ")} |`, `|${cab.map(() => " --- ").join("|")}|`,
          ...cheias.map((l) => `| ${[...(c.fixas ? [l.linha] : []), ...c.colunas.map((col) => l[col.id])].map(celulaMD).join(" | ")} |`), "");
      }
    } else if (c.tipo === "pedidos") {
      const itens = c.itens.filter(([cod]) => v?.[cod]?.aplica || v?.[cod]?.fatos);
      if (itens.length) {
        linhas.push("| Cód. | Pedido | Aplica | Fatos e dados para cálculo | Risco |", "| --- | --- | --- | --- | --- |",
          ...itens.map(([cod, nome]) => `| ${cod} | ${celulaMD(nome)} | ${v[cod].aplica ? "Sim" : "Não"} | ${celulaMD(v[cod].fatos)} | ${v[cod].risco || ""} |`), "");
      }
    } else if (v) {
      linhas.push(`- **${c.rotulo}:** ${celulaMD(valorMD(c, v))}`);
    }
  }
  return linhas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function situacaoMD(a) {
  switch (a.situacao) {
    case "aguardando_distribuicao":
      return `Contrato fechado em ${dataBR(diaLocal(a.concluido_em))} (${nomePessoa(a.concluido_por)}) · distribuição prevista para ${dataBR(a.data_prevista)}`;
    case "distribuida":
      return `Ação distribuída em ${dataBR(a.distribuida_em)} · processo ${a.processo}`;
    case "nao_fechou":
      return `Não fechou contrato${a.motivo_nao_fechou ? ` · motivo: ${a.motivo_nao_fechou}` : ""}`;
    default:
      return SITUACOES_AT[a.situacao];
  }
}

function gerarMarkdown(a) {
  const m = FICHAS[a.ficha];
  const contrarias = a.partes_contrarias || [];
  const linhas = [
    `# Ficha de atendimento — ${m.titulo}`,
    "",
    `- **${m.rotuloCliente}:** ${a.cliente_nome || "—"}`,
    contrarias.length ? `- **${m.rotuloContraria}${contrarias.length > 1 ? "s" : ""}:** ${contrarias.join("; ")}` : null,
    `- **Área:** ${NOMES_AREA[a.area]}`,
    `- **Atendimento:** ${dataBR(a.data_atendimento)} · ${nomePessoa(a.atendente)}`,
    `- **Situação:** ${situacaoMD(a)}`,
    `- **Ficha no Supralex:** ${location.origin}/#atendimento/${a.id}`,
    "",
    "> Documento com dados pessoais e sensíveis (LGPD). Uso restrito à equipe do escritório.",
    "",
  ].filter((l) => l !== null);
  m.secoes.forEach((s, i) => {
    linhas.push(`## ${i + 1}. ${s.titulo}`, "", camposMD(s.campos, a.dados || {}) || "_Sem informações._", "");
  });
  linhas.push("---", "");
  if (m.declaracao) linhas.push(`_${m.declaracao}_`, "");
  linhas.push(`_Gerado pelo Supralex em ${new Date().toLocaleString("pt-BR", { timeZone: FUSO })}._`, "");
  return linhas.join("\n");
}

// ------------------------------------------------------------- concluir, distribuir, reabrir

function abrirConcluir() {
  const { modelo: m } = at.ficha;
  const dados = lerFicha();
  if (!dados[m.cliente.nome]) { avisar(`Preencha o nome do ${m.rotuloCliente.toLowerCase()} antes de concluir.`); return; }
  const semConflito = dados[m.conflito] === "Sem conflito";
  at.acao = "concluir";
  $("dat-titulo").textContent = "Concluir atendimento";
  $("dat-ok").hidden = false;
  $("dat-ok").textContent = "Concluir";
  $("dat-corpo").innerHTML = `
    ${semConflito ? "" : `<div class="google erro">${dados[m.conflito] === "Há conflito" ? "⚠ A ficha marca conflito de interesses." : "⚠ O conflito de interesses ainda não foi verificado (item 1)."}</div>`}
    <div class="escolhas" data-tipo="opcao" id="dat-resultado">
      <label class="escolha"><input type="checkbox" value="fechou" checked><span>Contrato fechado</span></label>
      <label class="escolha"><input type="checkbox" value="nao_fechou"><span>Não fechou contrato</span></label>
    </div>
    <div id="dat-fechou">
      <label>Data prevista para distribuição da ação<input type="date" id="dat-data" value="${esc(dados[m.dataPrevista] || "")}"></label>
      <span class="rotulo">Responsável pela distribuição</span>
      <div class="responsaveis" id="dat-responsaveis">${estado.equipe.map((p) =>
        `<label class="check"><input type="checkbox" value="${esc(p.email)}" ${p.email === estado.eu ? "checked" : ""}> ${esc(p.nome || p.email)}</label>`).join("")}</div>
      <p class="at-sub">Cria o compromisso “Distribuir ação” na agenda (e no Google Agenda do responsável). A ficha fica travada para edição.</p>
    </div>
    <div id="dat-naofechou" hidden>
      <label>Motivo (opcional)<textarea id="dat-motivo" rows="3" placeholder="Ex.: achou os honorários altos, vai pensar, procurou outro escritório…"></textarea></label>
    </div>
    <p class="at-sub">A ficha será gravada em Markdown no repositório privado do GitHub.</p>`;
  $("dlg-at").showModal();
}

function abrirDistribuir(a) {
  at.acao = "distribuir";
  at.acaoAtendimento = a;
  $("dat-titulo").textContent = "Registrar distribuição";
  $("dat-ok").hidden = false;
  $("dat-ok").textContent = "Registrar";
  $("dat-corpo").innerHTML = `
    <p><strong>${esc(tituloAtendimento(a))}</strong></p>
    <label>Número do processo<input id="dat-processo" required placeholder="0000000-00.0000.0.00.0000"></label>
    <label>Data da distribuição<input type="date" id="dat-data" required value="${hoje()}"></label>
    <p class="at-sub">O atendimento passa para “Ações distribuídas”, o compromisso da agenda é marcado como cumprido e o .md no GitHub recebe o número do processo.</p>`;
  $("dlg-at").showModal();
}

async function executarAcao(acao, a, extra, projetado) {
  $("dat-ok").disabled = true;
  const markdown = projetado ? gerarMarkdown({ ...a, ...projetado }) : undefined;
  const { data, error } = await sb.functions.invoke("atendimento", { body: { acao, id: a.id, markdown, ...extra } });
  $("dat-ok").disabled = false;
  if (error || !data?.atendimento) {
    let msg = "Não foi possível concluir a operação.";
    try { msg = (await error.context.json()).erro || msg; } catch { /* resposta sem corpo */ }
    avisar(msg, 5000);
    return null;
  }
  guardarAtendimento(data.atendimento);
  carregarAgenda();
  return data.atendimento;
}

async function confirmarAcao() {
  if (at.acao === "concluir") {
    const fechou = $("dat-resultado").querySelector("input:checked")?.value !== "nao_fechou";
    const dataPrevista = $("dat-data").value;
    const responsaveis = [...$("dat-responsaveis").querySelectorAll("input:checked")].map((i) => i.value);
    if (fechou && !dataPrevista) { avisar("Informe a data prevista para a distribuição."); return; }
    if (fechou && !responsaveis.length) { avisar("Escolha o responsável pela distribuição."); return; }
    if (!(await salvarFicha())) return;
    const a = at.ficha.atendimento;
    const agora = new Date().toISOString();
    const salvo = fechou
      ? await executarAcao("concluir", a, { data_prevista: dataPrevista, responsaveis },
        { situacao: "aguardando_distribuicao", concluido_em: agora, concluido_por: estado.eu, data_prevista: dataPrevista })
      : await executarAcao("nao_fechou", a, { motivo: $("dat-motivo").value.trim() },
        { situacao: "nao_fechou", concluido_em: agora, concluido_por: estado.eu, motivo_nao_fechou: $("dat-motivo").value.trim() });
    if (!salvo) return;
    $("dlg-at").close();
    at.ficha = null;
    location.hash = "#atendimento";
    avisar(salvo.arquivo_erro ? `Concluído. Atenção — arquivo .md: ${salvo.arquivo_erro}`
      : fechou ? `Atendimento concluído. Distribuição agendada para ${dataBR(dataPrevista)}.` : "Atendimento registrado como “não fechou”.", 5000);
  } else if (at.acao === "distribuir") {
    const a = at.acaoAtendimento;
    const processo = $("dat-processo").value.trim();
    const data = $("dat-data").value;
    if (!processo || !data) { avisar("Informe o número do processo e a data."); return; }
    const salvo = await executarAcao("distribuir", a, { processo, distribuida_em: data },
      { situacao: "distribuida", processo, distribuida_em: data });
    if (!salvo) return;
    $("dlg-at").close();
    if (at.ficha?.atendimento.id === salvo.id) { at.ficha.atendimento = salvo; atualizarCabecalhoFicha(); }
    renderizarAtendimentos();
    avisar(salvo.arquivo_erro ? `Distribuição registrada. Atenção — arquivo .md: ${salvo.arquivo_erro}` : "Distribuição registrada.", 4500);
  }
}

async function reabrir() {
  const a = at.ficha.atendimento;
  if (!confirm("Reabrir o atendimento para edição? O compromisso de distribuição na agenda será cancelado.")) return;
  const salvo = await executarAcao("reabrir", a);
  if (!salvo) return;
  at.ficha.atendimento = salvo;
  at.ficha.somenteLeitura = false;
  atualizarCabecalhoFicha();
  avisar("Atendimento reaberto. Conclua de novo quando terminar.");
}

// ------------------------------------------------------------- eventos

function prepararAtendimento() {
  $("at-novo").addEventListener("click", escolherArea);
  $("at-mes-anterior").addEventListener("click", () => navegarMes(-1));
  $("at-mes-proximo").addEventListener("click", () => navegarMes(1));
  $("at-busca").addEventListener("input", renderizarAtendimentos);
  document.querySelectorAll("[data-at-filtro]").forEach((b) => b.addEventListener("click", () => {
    at.filtro = b.dataset.atFiltro; renderizarAtendimentos();
  }));
  $("at-lista").addEventListener("click", (e) => {
    const b = e.target.closest("[data-distribuir]");
    if (b) abrirDistribuir(at.lista.find((a) => a.id === b.dataset.distribuir));
  });

  const campos = $("ficha-campos");
  campos.addEventListener("input", marcarAlteracao);
  campos.addEventListener("change", (e) => {
    const t = e.target;
    const unico = t.closest('.escolhas[data-tipo="opcao"]');
    if (unico && t.checked) unico.querySelectorAll("input").forEach((i) => { if (i !== t) i.checked = false; });
    if (t.dataset.p === "aplica") t.closest("tr").classList.toggle("aplica", t.checked);
    if (t.dataset.c === "at_saida" && t.value) {
      const bienal = campos.querySelector('[data-c="at_bienal"]');
      if (bienal) bienal.value = somarAnos(t.value, 2);
    }
    if (t.dataset.c === "rec_cpf") t.value = formatarCPF(t.value);
    marcarAlteracao();
  });
  campos.addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.maisLinha !== undefined) {
      const c = camposDaFicha(at.ficha.modelo).find((x) => x.id === t.dataset.maisLinha);
      campos.querySelector(`[data-c="${c.id}"] tbody`).insertAdjacentHTML("beforeend", linhaTabela(c, {}));
    } else if (t.dataset.maisItem !== undefined) {
      const c = camposDaFicha(at.ficha.modelo).find((x) => x.id === t.dataset.maisItem);
      const grupo = campos.querySelector(`[data-c="${c.id}"]`);
      grupo.insertAdjacentHTML("beforeend", itemGrupo(c, {}, grupo.children.length));
    } else if (t.dataset.removerItem !== undefined) {
      t.closest(".repete-item").remove();
      marcarAlteracao();
    } else if (t.dataset.conflito !== undefined) {
      verificarConflito();
    }
  });
  $("ficha-indice").addEventListener("click", (e) => {
    const s = e.target.dataset.secao;
    if (s === undefined) return;
    e.preventDefault();
    $(`secao-${s}`).scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("ficha-salvar").addEventListener("click", async () => { if (await salvarFicha()) avisar("Ficha salva."); });
  $("ficha-concluir").addEventListener("click", abrirConcluir);
  $("ficha-distribuir").addEventListener("click", () => abrirDistribuir(at.ficha.atendimento));
  $("ficha-reabrir").addEventListener("click", reabrir);

  $("form-at").addEventListener("submit", (e) => { e.preventDefault(); confirmarAcao(); });
  $("dlg-at").addEventListener("click", (e) => {
    if (e.target.closest("[data-fechar]")) $("dlg-at").close();
  });
  $("dlg-at").addEventListener("change", (e) => {
    const unico = e.target.closest('.escolhas[data-tipo="opcao"]');
    if (!unico) return;
    if (!e.target.checked) { e.target.checked = true; return; }
    unico.querySelectorAll("input").forEach((i) => { if (i !== e.target) i.checked = false; });
    const fechou = e.target.value === "fechou";
    $("dat-fechou").hidden = !fechou;
    $("dat-naofechou").hidden = fechou;
  });
  window.addEventListener("beforeunload", (e) => { if (fichaAlterada()) e.preventDefault(); });
}
