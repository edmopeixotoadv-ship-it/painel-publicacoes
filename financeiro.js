// Aba Financeiro: lançamentos, contas a receber e a pagar, honorários por contrato, alvarás e repasses.
// Grava direto no banco; as regras por nível (public.nivel('financeiro')) valem lá:
// 1 vê e exporta, 2 lança, 3 administra (contas, categorias e exclusões).
// Vencimentos podem ir para a agenda pela função "agenda", com o tipo "financeiro",
// que só aparece para quem também vê o financeiro.
// Usa as utilidades de app.js ($, esc, sb, estado, avisar, pode...) e de atendimento.js (at, normalizarNome).

const SUBS_FIN = {
  geral: "Visão geral", lancamentos: "Lançamentos", receber: "A receber", pagar: "A pagar",
  honorarios: "Honorários", alvaras: "Alvarás e repasses", config: "Configurações",
};
const TIPOS_CONTA = { banco: "Banco", caixa: "Caixa", cartao: "Cartão de crédito", outro: "Outro" };
const TIPOS_CONTRATO = { fixo: "Fixo", exito: "Êxito", fixo_exito: "Fixo + êxito" };
const SITUACOES_CONTRATO = { ativo: "Ativo", encerrado: "Encerrado", cancelado: "Cancelado" };

const fin = {
  contas: [], categorias: [], lancamentos: [], contratos: [], alvaras: [],
  carregado: false,
  mes: null,
  sub: "geral",
  dialogo: null, // { salvar, excluir }
};

// ------------------------------------------------------------- utilidades

const formatoMoeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const formatoMoedaCurta = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
function moeda(v) { return formatoMoeda.format(Number(v || 0)); }
function moedaCurta(v) { return formatoMoedaCurta.format(Number(v || 0)); }

// aceita "1.234,56", "1234,56", "1234.56" e "R$ 800"
function lerValor(s) {
  let t = String(s ?? "").replace(/[^\d,.-]/g, "");
  if (!t) return NaN;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function valorCampo(v) {
  return v == null || v === "" ? "" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// mesmo dia nos meses seguintes (31/01 + 1 mês = 28 ou 29/02)
function somarMeses(iso, n) {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

function nomeMes(mes) {
  return new Date(`${mes}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
}

const nomeConta = (id) => fin.contas.find((c) => c.id === id)?.nome || "";
const nomeCategoria = (id) => fin.categorias.find((c) => c.id === id)?.nome || "Sem categoria";
const categoriaPorNome = (nome, natureza) =>
  fin.categorias.find((c) => c.nome === nome && c.natureza === natureza && c.ativa) ||
  fin.categorias.find((c) => c.natureza === natureza && c.ativa);
const contaPadrao = () => fin.contas.find((c) => c.ativa)?.id || null;
const emAtraso = (l) => !l.pago_em && l.vencimento < hoje();
const soma = (lista) => lista.reduce((t, l) => t + Number(l.valor || 0), 0);

function guardar(lista, item) {
  const i = lista.findIndex((x) => x.id === item.id);
  if (i >= 0) lista[i] = item; else lista.push(item);
}

function clientePorNome(nome) {
  const alvo = normalizarNome(nome);
  return alvo ? at.clientes.find((c) => normalizarNome(c.nome) === alvo) : null;
}

function opcoes(lista, atual, vazio) {
  return (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : "") +
    lista.map(([v, r]) => `<option value="${esc(v)}" ${v === atual ? "selected" : ""}>${esc(r)}</option>`).join("");
}

function opcoesContas(atual) {
  return opcoes(fin.contas.filter((c) => c.ativa || c.id === atual).map((c) => [c.id, c.nome]), atual, "—");
}

function opcoesCategorias(natureza, atual) {
  return opcoes(fin.categorias.filter((c) => c.natureza === natureza && (c.ativa || c.id === atual)).map((c) => [c.id, c.nome]), atual);
}

function mensagemErro(error) {
  const m = error?.message || "";
  if (/row-level security|permission denied/i.test(m)) return "Você não tem permissão para esta alteração.";
  return m || "Não foi possível salvar.";
}

// o Supabase devolve no máximo 1000 linhas por consulta
async function lerTudo(montar) {
  const linhas = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await montar().range(i, i + 999);
    if (error) return { error };
    linhas.push(...data);
    if (data.length < 1000) return { data: linhas };
  }
}

// ------------------------------------------------------------- carga e rotas

async function carregarFinanceiro() {
  const [contas, categorias, lancamentos, contratos, alvaras] = await Promise.all([
    sb.from("fin_contas").select("*").order("ordem").order("nome"),
    sb.from("fin_categorias").select("*").order("ordem").order("nome"),
    lerTudo(() => sb.from("fin_lancamentos").select("*").order("vencimento").order("id")),
    lerTudo(() => sb.from("fin_contratos").select("*").order("criado_em").order("id")),
    lerTudo(() => sb.from("fin_alvaras").select("*").order("data_levantamento").order("id")),
  ]);
  const falha = [contas, categorias, lancamentos, contratos, alvaras].find((r) => r.error);
  if (falha) {
    $("fin-conteudo").innerHTML = `<div class="vazio">Não foi possível carregar o financeiro: ${esc(falha.error.message)}</div>`;
    return;
  }
  Object.assign(fin, {
    contas: contas.data, categorias: categorias.data, lancamentos: lancamentos.data,
    contratos: contratos.data, alvaras: alvaras.data, carregado: true,
  });
  preencherClientesFin();
  renderizarFinanceiro();
  if (at.carregado) renderizarAtendimentos();
}

function preencherClientesFin() {
  $("fin-clientes").innerHTML = at.clientes.map((c) => `<option value="${esc(c.nome)}">`).join("");
}

function rotearFinanceiro() {
  if (!fin.carregado) return;
  const [p1, p2, p3] = location.hash.replace(/^#/, "").split("/").slice(1);
  if (SUBS_FIN[p1]) fin.sub = p1;
  if (fin.sub === "config" && !pode("financeiro", 3)) fin.sub = "geral";
  if (p1 === "contrato" || p1 === "alvara") fin.sub = p1 === "contrato" ? "honorarios" : "alvaras";
  renderizarFinanceiro();
  if (p1 === "lancamento") {
    const l = fin.lancamentos.find((x) => x.id === p2);
    if (l) abrirLancamento(l); else naoEncontrado();
  } else if (p1 === "contrato") {
    if (p2 === "novo") {
      if (!pode("financeiro", 2)) return naoEncontrado();
      abrirContrato(null, at.lista.find((a) => a.id === p3));
    } else {
      const c = fin.contratos.find((x) => x.id === p2);
      if (c) abrirContrato(c); else naoEncontrado();
    }
  } else if (p1 === "alvara") {
    const a = fin.alvaras.find((x) => x.id === p2);
    if (a) abrirAlvara(a); else naoEncontrado();
  }
}

function naoEncontrado() {
  avisar("Registro não encontrado.");
  history.replaceState(null, "", `#financeiro/${fin.sub}`);
}

// ------------------------------------------------------------- painel

function renderizarFinanceiro() {
  if (!fin.carregado) return;
  const mes = fin.mes || hoje().slice(0, 7);
  const anterior = somarMeses(`${mes}-01`, -1).slice(0, 7);
  const pagosNo = (m) => fin.lancamentos.filter((l) => l.pago_em?.startsWith(m));
  const doMes = pagosNo(mes);
  const receitas = doMes.filter((l) => l.natureza === "receita");
  const despesas = doMes.filter((l) => l.natureza === "despesa");
  const resultado = soma(receitas) - soma(despesas);
  const doAnterior = pagosNo(anterior);
  const resultadoAnterior = soma(doAnterior.filter((l) => l.natureza === "receita")) - soma(doAnterior.filter((l) => l.natureza === "despesa"));
  const aReceber = fin.lancamentos.filter((l) => l.natureza === "receita" && !l.pago_em);
  const atrasadas = aReceber.filter(emAtraso);

  $("fin-mes").textContent = nomeMes(mes);
  $("fin-n-entradas").textContent = moedaCurta(soma(receitas));
  $("fin-r-entradas").textContent = `${receitas.length} lançamento(s)`;
  $("fin-n-saidas").textContent = moedaCurta(soma(despesas));
  $("fin-r-saidas").textContent = `${despesas.length} lançamento(s)`;
  $("fin-n-resultado").textContent = moedaCurta(resultado);
  $("fin-n-resultado").className = `n ${resultado > 0 ? "pos" : resultado < 0 ? "neg" : ""}`;
  $("fin-r-resultado").textContent = doAnterior.length ? `${nomeMes(anterior).split(" ")[0]}: ${moedaCurta(resultadoAnterior)}` : "";
  $("fin-n-receber").textContent = moedaCurta(soma(aReceber));
  $("fin-r-receber").innerHTML = atrasadas.length
    ? `<span class="atrasado">${moedaCurta(soma(atrasadas))} em atraso</span>` : `${aReceber.length} em aberto`;

  $("fin-novo-receita").hidden = $("fin-novo-despesa").hidden = !pode("financeiro", 2);
  document.querySelectorAll("[data-fin-sub]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.finSub === fin.sub);
    if (b.dataset.finSub === "config") b.hidden = !pode("financeiro", 3);
  });

  const telas = {
    geral: telaGeral, lancamentos: telaLancamentos, receber: () => telaPendentes("receita"),
    pagar: () => telaPendentes("despesa"), honorarios: telaHonorarios, alvaras: telaAlvaras, config: telaConfig,
  };
  $("fin-conteudo").innerHTML = telas[fin.sub](mes, doMes);
  if (fin.sub === "lancamentos") renderizarTabelaLancamentos();
}

function itemVencimento(l) {
  const sub = [nomeCategoria(l.categoria_id), l.cliente_nome, l.processo && `Proc. ${l.processo}`].filter(Boolean).map(esc).join(" · ");
  return `
  <div class="venc">
    <a class="venc-link" href="#financeiro/lancamento/${esc(l.id)}">
      <span class="d">${dataBR(l.vencimento).slice(0, 5)}</span>
      <span class="t"><b>${esc(l.descricao)}</b><span>${sub}</span></span>
    </a>
    ${emAtraso(l) ? '<span class="selo-at atrasado">em atraso</span>' : ""}
    <span class="valor ${l.natureza === "receita" ? "rec" : "desp"}">${moeda(l.valor)}</span>
    ${pode("financeiro", 2) ? `<button class="botao-sec mini" data-pagar="${esc(l.id)}" title="${l.natureza === "receita" ? "Marcar como recebida" : "Marcar como paga"}">✓</button>` : ""}
  </div>`;
}

function telaGeral(mes, doMes) {
  const limite = somarDias(hoje(), 30);
  const proximos = fin.lancamentos.filter((l) => !l.pago_em && l.vencimento <= limite)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento)).slice(0, 15);

  const porCategoria = new Map();
  for (const l of doMes) {
    const chave = `${l.natureza}|${l.categoria_id || ""}`;
    porCategoria.set(chave, (porCategoria.get(chave) || 0) + Number(l.valor));
  }
  const linhas = [...porCategoria.entries()].map(([k, v]) => ({ natureza: k.split("|")[0], categoria: k.split("|")[1], v }))
    .sort((a, b) => (a.natureza === b.natureza ? b.v - a.v : a.natureza === "receita" ? -1 : 1));
  const maior = Math.max(1, ...linhas.map((x) => x.v));

  const contas = fin.contas.map((c) => {
    const pagos = fin.lancamentos.filter((l) => l.pago_em && l.conta_id === c.id);
    const saldo = Number(c.saldo_inicial) + soma(pagos.filter((l) => l.natureza === "receita")) - soma(pagos.filter((l) => l.natureza === "despesa"));
    return { c, saldo };
  }).filter((x) => x.c.ativa || Math.abs(x.saldo) > 0.004);
  const semConta = fin.lancamentos.filter((l) => l.pago_em && !l.conta_id).length;

  return `
  <div class="fin-grade">
    <div class="bloco">
      <h3>Vencimentos até ${dataBR(limite).slice(0, 5)}</h3>
      ${proximos.length ? proximos.map(itemVencimento).join("") : '<div class="vazio pequeno">Nada vencendo nos próximos 30 dias.</div>'}
    </div>
    <div>
      <div class="bloco">
        <h3>Resultado por categoria · ${esc(nomeMes(mes).split(" ")[0])}</h3>
        ${linhas.length ? linhas.map((x) => `
          <div class="cat"><span>${esc(nomeCategoria(x.categoria))}</span>
            <span class="trilho"><i style="width:${Math.max(2, Math.round((100 * x.v) / maior))}%" class="${x.natureza}"></i></span>
            <span class="valor ${x.natureza === "receita" ? "rec" : "desp"}">${moedaCurta(x.v)}</span></div>`).join("")
          : '<div class="vazio pequeno">Nenhum lançamento pago neste mês.</div>'}
      </div>
      <div class="bloco">
        <h3>Saldo por conta</h3>
        ${contas.map((x) => `<div class="conta"><span>${esc(x.c.nome)}</span><span class="valor ${x.saldo < 0 ? "desp" : ""}">${moeda(x.saldo)}</span></div>`).join("")}
        <div class="conta total"><span>Total</span><span class="valor">${moeda(contas.reduce((t, x) => t + x.saldo, 0))}</span></div>
        ${semConta ? `<p class="at-sub">${semConta} lançamento(s) pago(s) sem conta não entram nos saldos.</p>` : ""}
        ${pode("financeiro", 3) ? '<p class="at-sub">Saldo inicial e contas em <a href="#financeiro/config">Configurações</a>.</p>' : ""}
      </div>
    </div>
  </div>`;
}

function telaLancamentos() {
  const contas = fin.contas.map((c) => [c.id, c.nome]);
  const cats = fin.categorias.map((c) => [c.id, `${c.nome} (${c.natureza === "receita" ? "receita" : "despesa"})`]);
  return `
  <div class="filtros fin-filtros">
    <input class="busca" id="fl-busca" type="search" placeholder="Buscar descrição, cliente ou processo…" aria-label="Buscar lançamentos">
    <select id="fl-f-conta" aria-label="Conta">${opcoes(contas, "", "Todas as contas")}</select>
    <select id="fl-f-categoria" aria-label="Categoria">${opcoes(cats, "", "Todas as categorias")}</select>
    <select id="fl-f-natureza" aria-label="Tipo">${opcoes([["receita", "Só receitas"], ["despesa", "Só despesas"]], "", "Receitas e despesas")}</select>
  </div>
  <div class="contagem" id="fl-contagem"></div>
  <div class="bloco rol"><table class="fin"><thead><tr>
    <th>Data</th><th>Descrição</th><th>Categoria</th><th>Conta</th><th>Situação</th><th class="num">Valor</th>
  </tr></thead><tbody id="fl-corpo"></tbody></table></div>`;
}

function lancamentosDoMes() {
  const mes = fin.mes || hoje().slice(0, 7);
  return fin.lancamentos.filter((l) => l.pago_em?.startsWith(mes) || (!l.pago_em && l.vencimento.startsWith(mes)));
}

function renderizarTabelaLancamentos() {
  const busca = normalizarNome($("fl-busca")?.value || "");
  const conta = $("fl-f-conta").value, categoria = $("fl-f-categoria").value, natureza = $("fl-f-natureza").value;
  const lista = lancamentosDoMes().filter((l) => {
    if (conta && l.conta_id !== conta) return false;
    if (categoria && l.categoria_id !== categoria) return false;
    if (natureza && l.natureza !== natureza) return false;
    if (busca) {
      const alvo = normalizarNome([l.descricao, l.cliente_nome, l.processo, l.observacoes].join(" "));
      if (!busca.split(" ").every((t) => alvo.includes(t))) return false;
    }
    return true;
  }).sort((a, b) => (b.pago_em || b.vencimento).localeCompare(a.pago_em || a.vencimento));
  const rec = soma(lista.filter((l) => l.natureza === "receita")), desp = soma(lista.filter((l) => l.natureza === "despesa"));
  $("fl-contagem").textContent = `${lista.length} lançamento(s) · receitas ${moeda(rec)} · despesas ${moeda(desp)}`;
  $("fl-corpo").innerHTML = lista.length ? lista.map((l) => {
    const situacao = l.pago_em ? `<span class="selo-at distribuida">${l.natureza === "receita" ? "recebido" : "pago"}</span>`
      : emAtraso(l) ? '<span class="selo-at atrasado">em atraso</span>' : '<span class="selo-at">a vencer</span>';
    const sub = [l.cliente_nome, l.processo && `Proc. ${l.processo}`, l.reembolsavel && "reembolsável"].filter(Boolean).map(esc).join(" · ");
    return `<tr class="clicavel" data-ir="#financeiro/lancamento/${esc(l.id)}">
      <td>${dataBR(l.pago_em || l.vencimento).slice(0, 5)}</td>
      <td><a href="#financeiro/lancamento/${esc(l.id)}">${esc(l.descricao)}</a>${sub ? `<span class="at-sub" style="display:block">${sub}</span>` : ""}</td>
      <td>${esc(nomeCategoria(l.categoria_id))}</td><td>${esc(nomeConta(l.conta_id))}</td><td>${situacao}</td>
      <td class="num valor ${l.natureza === "receita" ? "rec" : "desp"}">${l.natureza === "despesa" ? "− " : ""}${moeda(l.valor)}</td></tr>`;
  }).join("") : '<tr><td colspan="6"><div class="vazio pequeno">Nenhum lançamento neste mês com esses filtros.</div></td></tr>';
}

function telaPendentes(natureza) {
  const lista = fin.lancamentos.filter((l) => l.natureza === natureza && !l.pago_em)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const fimMes = somarMeses(`${hoje().slice(0, 7)}-01`, 1);
  const grupos = [
    ["Em atraso", lista.filter(emAtraso)],
    ["Até o fim deste mês", lista.filter((l) => !emAtraso(l) && l.vencimento < fimMes)],
    ["Próximos meses", lista.filter((l) => l.vencimento >= fimMes)],
  ].filter(([, g]) => g.length);
  const verbo = natureza === "receita" ? "Marcar recebida" : "Marcar paga";
  return `
  <p class="contagem">${lista.length} em aberto · total ${moeda(soma(lista))}</p>
  ${grupos.length ? grupos.map(([titulo, g]) => `
    <h3 class="fin-grupo">${titulo} · ${moeda(soma(g))}</h3>
    <div class="lista">${g.map((l) => `
      <div class="at-item ${emAtraso(l) ? "fin-atrasado" : ""}">
        <a class="at-link" href="#financeiro/lancamento/${esc(l.id)}">
          <span class="at-data">${dataBR(l.vencimento)}</span>
          <span class="at-info"><span class="at-titulo">${esc(l.descricao)}</span>
            <span class="at-sub">${[nomeCategoria(l.categoria_id), l.cliente_nome, l.processo && `Proc. ${l.processo}`, l.compromisso_id && "📅 na agenda"].filter(Boolean).map(esc).join(" · ")}</span></span>
        </a>
        <span class="at-acoes"><span class="valor ${natureza === "receita" ? "rec" : "desp"}">${moeda(l.valor)}</span>
          ${pode("financeiro", 2) ? `<button class="botao-sec" data-pagar="${esc(l.id)}">${verbo}</button>` : ""}</span>
      </div>`).join("")}</div>`).join("")
    : `<div class="vazio">Nada ${natureza === "receita" ? "a receber" : "a pagar"} em aberto.</div>`}`;
}

function resumoContrato(c) {
  const lancs = fin.lancamentos.filter((l) => l.contrato_id === c.id);
  const parcelas = lancs.filter((l) => l.parcela);
  const pagas = parcelas.filter((l) => l.pago_em);
  return { lancs, parcelas, pagas, recebido: soma(lancs.filter((l) => l.pago_em)) };
}

function telaHonorarios() {
  const ordem = { ativo: 0, encerrado: 1, cancelado: 2 };
  const lista = [...fin.contratos].sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || b.criado_em.localeCompare(a.criado_em));
  return `
  <div class="barra-fin">${pode("financeiro", 2) ? '<button class="botao" data-novo-contrato>+ Contrato de honorários</button>' : ""}</div>
  ${lista.length ? `<div class="bloco rol"><table class="fin"><thead><tr>
    <th>Cliente</th><th>Tipo</th><th>Contratado</th><th class="num">Recebido</th><th>Parcelas</th><th>Situação</th><th>Origem</th>
  </tr></thead><tbody>${lista.map((c) => {
    const r = resumoContrato(c);
    const contratado = [c.valor_fixo && moeda(c.valor_fixo), c.percentual_exito != null && `${String(c.percentual_exito).replace(".", ",")}% de êxito`].filter(Boolean).join(" + ");
    const pct = r.parcelas.length ? Math.round((100 * r.pagas.length) / r.parcelas.length) : 0;
    const atend = c.atendimento_id && at.lista.find((a) => a.id === c.atendimento_id);
    return `<tr class="clicavel" data-ir="#financeiro/contrato/${esc(c.id)}">
      <td><a href="#financeiro/contrato/${esc(c.id)}">${esc(c.cliente_nome)}</a></td>
      <td>${TIPOS_CONTRATO[c.tipo]}</td><td>${esc(contratado || "—")}</td>
      <td class="num valor rec">${r.recebido ? moeda(r.recebido) : "—"}</td>
      <td>${r.parcelas.length ? `<span class="prog"><i style="width:${pct}%"></i></span> ${r.pagas.length}/${r.parcelas.length}` : "—"}</td>
      <td><span class="selo-at ${c.situacao === "ativo" ? "distribuida" : ""}">${SITUACOES_CONTRATO[c.situacao]}</span></td>
      <td>${atend ? `<a href="#atendimento/${esc(atend.id)}">Atendimento ${dataBR(atend.data_atendimento).slice(0, 5)}</a>` : esc(c.processo ? `Proc. ${c.processo}` : "—")}</td></tr>`;
  }).join("")}</tbody></table></div>`
    : '<div class="vazio">Nenhum contrato de honorários cadastrado. Ao fechar um contrato no Atendimento, use “💰 Cadastrar honorários”.</div>'}`;
}

function telaAlvaras() {
  const lista = [...fin.alvaras].sort((a, b) => b.data_levantamento.localeCompare(a.data_levantamento));
  const pendentes = lista.filter((a) => !a.repassado_em && Number(a.repasse) > 0);
  return `
  <div class="barra-fin">
    ${pendentes.length ? `<span class="atrasado">${pendentes.length} repasse(s) pendente(s) · ${moeda(soma(pendentes.map((a) => ({ valor: a.repasse }))))}</span>` : ""}
    ${pode("financeiro", 2) ? '<button class="botao" data-novo-alvara>+ Alvará</button>' : ""}
  </div>
  ${lista.length ? `<div class="bloco rol"><table class="fin"><thead><tr>
    <th>Data</th><th>Cliente / processo</th><th class="num">Levantado</th><th class="num">Honorários</th><th class="num">Descontos</th><th class="num">Repasse</th><th>Situação</th>
  </tr></thead><tbody>${lista.map((a) => `
    <tr class="clicavel" data-ir="#financeiro/alvara/${esc(a.id)}">
      <td>${dataBR(a.data_levantamento)}</td>
      <td><a href="#financeiro/alvara/${esc(a.id)}">${esc(a.cliente_nome)}</a>${a.processo ? `<span class="at-sub" style="display:block">${esc(a.processo)}</span>` : ""}</td>
      <td class="num valor">${moeda(a.valor_levantado)}</td><td class="num valor rec">${moeda(a.honorarios)}</td>
      <td class="num valor">${Number(a.descontos) ? moeda(a.descontos) : "—"}</td><td class="num valor">${moeda(a.repasse)}</td>
      <td>${a.repassado_em ? `<span class="selo-at distribuida">repassado ${dataBR(a.repassado_em).slice(0, 5)}</span>`
        : Number(a.repasse) > 0 ? '<span class="selo-at aguardando_distribuicao">repasse pendente</span>' : "—"}</td></tr>`).join("")}
  </tbody></table></div>` : '<div class="vazio">Nenhum alvará registrado.</div>'}`;
}

function telaConfig() {
  const linhaConta = (c) => `
    <tr data-conta="${esc(c.id)}">
      <td><input class="cfg-nome" value="${esc(c.nome)}" maxlength="80" aria-label="Nome da conta"></td>
      <td><select class="cfg-tipo" aria-label="Tipo">${opcoes(Object.entries(TIPOS_CONTA), c.tipo)}</select></td>
      <td><input class="cfg-saldo" value="${esc(valorCampo(c.saldo_inicial))}" inputmode="decimal" aria-label="Saldo inicial"></td>
      <td><label class="check"><input type="checkbox" class="cfg-ativa" ${c.ativa ? "checked" : ""}> ativa</label></td>
      <td><button class="botao-sec mini" data-salvar-conta="${esc(c.id)}">Salvar</button></td></tr>`;
  const linhaCategoria = (c) => `
    <tr data-categoria="${esc(c.id)}">
      <td><input class="cfg-nome" value="${esc(c.nome)}" maxlength="80" aria-label="Nome da categoria"></td>
      <td><label class="check"><input type="checkbox" class="cfg-ativa" ${c.ativa ? "checked" : ""}> ativa</label></td>
      <td><button class="botao-sec mini" data-salvar-categoria="${esc(c.id)}">Salvar</button></td></tr>`;
  const cats = (n) => fin.categorias.filter((c) => c.natureza === n);
  return `
  <div class="bloco rol">
    <h3>Contas</h3>
    <p class="at-sub">O saldo inicial é o saldo da conta no dia em que vocês começaram a lançar aqui. Contas desativadas somem dos formulários, mas o histórico fica.</p>
    <table class="fin cfg"><thead><tr><th>Nome</th><th>Tipo</th><th>Saldo inicial (R$)</th><th></th><th></th></tr></thead>
    <tbody>${fin.contas.map(linhaConta).join("")}</tbody></table>
    <button class="botao-sec" data-nova-conta>+ Conta</button>
  </div>
  <div class="fin-grade metade">
    ${["receita", "despesa"].map((n) => `
    <div class="bloco rol">
      <h3>Categorias de ${n}</h3>
      <table class="fin cfg"><tbody>${cats(n).map(linhaCategoria).join("")}</tbody></table>
      <button class="botao-sec" data-nova-categoria="${n}">+ Categoria</button>
    </div>`).join("")}
  </div>`;
}

// ------------------------------------------------------------- diálogo genérico

function abrirDialogo({ titulo, corpo, ok = "Salvar", salvar, excluir, somenteLeitura = false }) {
  fin.dialogo = { salvar, excluir };
  $("dfin-titulo").textContent = titulo;
  $("dfin-corpo").innerHTML = corpo;
  $("dfin-campos").disabled = somenteLeitura;
  $("dfin-ok").textContent = ok;
  $("dfin-ok").hidden = somenteLeitura || !salvar;
  $("dfin-excluir").hidden = !excluir;
  if (!$("dlg-fin").open) $("dlg-fin").showModal();
}

function fecharDialogo() {
  if ($("dlg-fin").open) $("dlg-fin").close();
}

function escolhas(id, lista, atual, desabilitado = false) {
  return `<div class="escolhas" data-tipo="opcao" id="${id}">${lista.map(([v, r]) =>
    `<label class="escolha"><input type="checkbox" value="${esc(v)}" ${v === atual ? "checked" : ""} ${desabilitado ? "disabled" : ""}><span>${esc(r)}</span></label>`).join("")}</div>`;
}

const escolhido = (id) => $(id).querySelector("input:checked")?.value;

function rodapeAutoria(r) {
  if (!r?.criado_em) return "";
  return `<div class="quem">Criado por ${esc(nomePessoa(r.criado_por))} em ${new Date(r.criado_em).toLocaleString("pt-BR")}` +
    (r.atualizado_por ? ` · última alteração: ${esc(nomePessoa(r.atualizado_por))} em ${new Date(r.atualizado_em).toLocaleString("pt-BR")}` : "") + "</div>";
}

// ------------------------------------------------------------- lançamentos

function compromissoAtivo(l) {
  if (!l?.compromisso_id) return false;
  const c = estado.compromissos.find((x) => x.id === l.compromisso_id);
  return c ? c.situacao !== "cancelado" : true;
}

function abrirLancamento(l, base = {}) {
  const novo = !l?.id;
  const d = novo ? { natureza: "receita", vencimento: hoje(), conta_id: contaPadrao(), ...base } : l;
  const contrato = d.contrato_id && fin.contratos.find((c) => c.id === d.contrato_id);
  const alvara = !novo && fin.alvaras.find((a) => a.lancamento_id === d.id);
  const vinculos = [
    contrato && `Contrato de honorários de <a href="#financeiro/contrato/${esc(contrato.id)}">${esc(contrato.cliente_nome)}</a>`,
    d.parcela && `parcela ${d.parcela}/${d.total_parcelas}`,
    alvara && `gerado pelo <a href="#financeiro/alvara/${esc(alvara.id)}">alvará de ${dataBR(alvara.data_levantamento)}</a> (altere por lá)`,
  ].filter(Boolean);
  abrirDialogo({
    titulo: novo ? `Nova ${d.natureza === "receita" ? "receita" : "despesa"}` : `${d.natureza === "receita" ? "Receita" : "Despesa"}`,
    somenteLeitura: !pode("financeiro", 2) || !!alvara,
    excluir: !novo && pode("financeiro", 3) && !alvara ? () => excluirLancamento(d) : null,
    salvar: () => salvarLancamento(l, d),
    corpo: `
      ${novo ? escolhas("fl-natureza", [["receita", "Receita"], ["despesa", "Despesa"]], d.natureza) : ""}
      <label>Descrição<input id="fl-descricao" required maxlength="200" value="${esc(d.descricao || "")}" placeholder="Ex.: Parcela de honorários — Cliente, Aluguel de novembro"></label>
      <div class="linha3">
        <label>Valor (R$)<input id="fl-valor" inputmode="decimal" required value="${esc(valorCampo(d.valor))}" placeholder="0,00"></label>
        <label>Vencimento<input type="date" id="fl-vencimento" required value="${esc(d.vencimento || "")}"></label>
        <label><span id="fl-pago-rotulo">${d.natureza === "receita" ? "Recebido em" : "Pago em"}</span><input type="date" id="fl-pago" value="${esc(d.pago_em || "")}"></label>
      </div>
      <p class="at-sub">Deixe “${d.natureza === "receita" ? "recebido" : "pago"} em” vazio para lançar como ${d.natureza === "receita" ? "a receber" : "a pagar"}.</p>
      <div class="linha2">
        <label>Categoria<select id="fl-categoria">${opcoesCategorias(d.natureza, d.categoria_id)}</select></label>
        <label>Conta<select id="fl-conta">${opcoesContas(d.conta_id)}</select></label>
      </div>
      <div class="linha2">
        <label>Cliente (opcional)<input id="fl-cliente" list="fin-clientes" maxlength="200" value="${esc(d.cliente_nome || "")}"></label>
        <label>Processo (opcional)<input id="fl-processo" maxlength="60" value="${esc(d.processo || "")}"></label>
      </div>
      ${novo ? `<div class="linha2">
        <label>Repetir<select id="fl-repetir">${opcoes([["", "Não repete"], ["parcelar", "Parcelar (divide o valor)"], ["mensal", "Todo mês (mesmo valor)"]], "")}</select></label>
        <label>Quantas vezes<input type="number" id="fl-vezes" min="2" max="120" value="2" disabled></label>
      </div>` : ""}
      <label class="check" id="fl-reembolsavel-l" ${d.natureza === "receita" ? "hidden" : ""}><input type="checkbox" id="fl-reembolsavel" ${d.reembolsavel ? "checked" : ""}> Despesa reembolsável pelo cliente (custas, cópias, diligências)</label>
      <label class="check"><input type="checkbox" id="fl-agenda" ${compromissoAtivo(d) ? "checked" : ""}> Lembrar do vencimento na Agenda (e no seu Google Agenda)</label>
      <label>Observações<textarea id="fl-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${vinculos.length ? `<div class="vinculo">${vinculos.join(" · ")}</div>` : ""}
      ${rodapeAutoria(l)}`,
  });
}

async function salvarLancamento(l, d) {
  const novo = !l?.id;
  const natureza = novo ? escolhido("fl-natureza") : d.natureza;
  const descricao = $("fl-descricao").value.trim();
  const valor = lerValor($("fl-valor").value);
  const vencimento = $("fl-vencimento").value;
  if (!descricao || !(valor > 0) || !vencimento) { avisar("Preencha descrição, valor e vencimento."); return; }
  const clienteNome = $("fl-cliente").value.trim();
  const cliente = clientePorNome(clienteNome);
  const dados = {
    natureza, descricao, valor, vencimento,
    pago_em: $("fl-pago").value || null,
    categoria_id: $("fl-categoria").value || null,
    conta_id: $("fl-conta").value || null,
    cliente_nome: clienteNome || null,
    cliente_id: cliente?.id ?? (clienteNome && clienteNome === d.cliente_nome ? d.cliente_id : null),
    processo: $("fl-processo").value.trim() || null,
    reembolsavel: natureza === "despesa" && $("fl-reembolsavel").checked,
    observacoes: $("fl-obs").value.trim() || null,
  };
  const lembrar = $("fl-agenda").checked;
  $("dfin-ok").disabled = true;
  try {
    if (!novo) {
      const { data, error } = await sb.from("fin_lancamentos").update(dados).eq("id", l.id).select().single();
      if (error) { avisar(mensagemErro(error), 4000); return; }
      guardar(fin.lancamentos, data);
      const aviso = await sincronizarVencimento(data, lembrar);
      fecharDialogo();
      avisar(aviso ? `Salvo. Atenção — ${aviso}` : "Lançamento salvo.", aviso ? 5000 : 2500);
    } else {
      const repetir = $("fl-repetir").value;
      const vezes = repetir ? Math.max(2, Math.min(120, Number($("fl-vezes").value) || 2)) : 1;
      const linhas = montarParcelas({ ...dados, contrato_id: d.contrato_id || null, atendimento_id: d.atendimento_id || null },
        vezes, repetir === "parcelar");
      const { data, error } = await sb.from("fin_lancamentos").insert(linhas).select();
      if (error) { avisar(mensagemErro(error), 4000); return; }
      data.forEach((x) => guardar(fin.lancamentos, x));
      let aviso = null;
      if (lembrar) for (const x of data) aviso = (await sincronizarVencimento(x, true)) || aviso;
      fecharDialogo();
      avisar(aviso ? `Salvo. Atenção — ${aviso}` : data.length > 1 ? `${data.length} lançamentos criados.` : "Lançamento salvo.", aviso ? 5000 : 2500);
    }
  } finally {
    $("dfin-ok").disabled = false;
  }
  renderizarFinanceiro();
}

// divide em parcelas (centavos que sobram vão para a última) ou repete o mesmo valor todo mês
function montarParcelas(base, vezes, dividir) {
  if (vezes <= 1) return [base];
  const grupo = crypto.randomUUID();
  const centavos = Math.round(base.valor * 100);
  const parte = dividir ? Math.floor(centavos / vezes) : centavos;
  return Array.from({ length: vezes }, (_, i) => ({
    ...base,
    descricao: `${base.descricao} (${i + 1}/${vezes})`,
    valor: (dividir && i === vezes - 1 ? centavos - parte * (vezes - 1) : parte) / 100,
    vencimento: somarMeses(base.vencimento, i),
    pago_em: i === 0 ? base.pago_em : null,
    parcela: i + 1, total_parcelas: vezes, grupo,
  }));
}

// cria, atualiza ou cancela o lembrete do vencimento na agenda; devolve um aviso ou null
async function sincronizarVencimento(l, lembrar) {
  if (!l.compromisso_id && (!lembrar || l.pago_em)) return null;
  const situacao = l.pago_em ? "cumprido" : lembrar ? "pendente" : "cancelado";
  const atual = estado.compromissos.find((c) => c.id === l.compromisso_id);
  const compromisso = {
    id: l.compromisso_id || undefined,
    tipo: "financeiro",
    titulo: `${l.natureza === "receita" ? "Receber" : "Pagar"}: ${l.descricao}`,
    dia_inteiro: true,
    inicio: `${l.vencimento}T00:00:00-03:00`,
    fim: null,
    processo: l.processo || null,
    descricao: [moeda(l.valor), l.cliente_nome, `Lançamento: ${location.origin}${location.pathname}#financeiro/lancamento/${l.id}`]
      .filter(Boolean).join("\n"),
    situacao,
  };
  if (atual && atual.situacao === situacao && situacao === "cancelado") return null;
  const corpo = { compromisso };
  if (!l.compromisso_id) corpo.responsaveis = [estado.eu];
  const { data, error } = await sb.functions.invoke("agenda", { body: corpo });
  if (error || !data?.compromisso) return "não foi possível atualizar a agenda";
  const salvo = data.compromisso;
  if (pode("agenda")) {
    guardar(estado.compromissos, salvo);
    estado.compromissos.sort((a, b) => a.inicio.localeCompare(b.inicio));
    renderizarAgenda();
  }
  if (!l.compromisso_id) {
    const { data: atualizado } = await sb.from("fin_lancamentos").update({ compromisso_id: salvo.id }).eq("id", l.id).select().single();
    if (atualizado) guardar(fin.lancamentos, atualizado);
  }
  return salvo.google_erro ? `Google Agenda: ${salvo.google_erro}` : null;
}

async function excluirLancamento(l) {
  if (!confirm(`Excluir “${l.descricao}” (${moeda(l.valor)})? Esta ação não pode ser desfeita.`)) return;
  if (l.compromisso_id) await sincronizarVencimento({ ...l, pago_em: null }, false);
  const { error } = await sb.from("fin_lancamentos").delete().eq("id", l.id);
  if (error) { avisar(mensagemErro(error), 4000); return; }
  fin.lancamentos = fin.lancamentos.filter((x) => x.id !== l.id);
  fecharDialogo();
  renderizarFinanceiro();
  avisar("Lançamento excluído.");
}

function abrirPagamento(l) {
  const receita = l.natureza === "receita";
  abrirDialogo({
    titulo: receita ? "Marcar como recebida" : "Marcar como paga",
    ok: "Confirmar",
    salvar: async () => {
      const pago_em = $("fp-data").value;
      if (!pago_em) { avisar("Informe a data."); return; }
      const mudancas = { pago_em, conta_id: $("fp-conta").value || null };
      const valor = lerValor($("fp-valor").value);
      if (!(valor > 0)) { avisar("Informe o valor."); return; }
      if (valor !== Number(l.valor)) mudancas.valor = valor;
      $("dfin-ok").disabled = true;
      const { data, error } = await sb.from("fin_lancamentos").update(mudancas).eq("id", l.id).select().single();
      $("dfin-ok").disabled = false;
      if (error) { avisar(mensagemErro(error), 4000); return; }
      guardar(fin.lancamentos, data);
      const aviso = data.compromisso_id ? await sincronizarVencimento(data, true) : null;
      fecharDialogo();
      renderizarFinanceiro();
      avisar(aviso ? `Registrado. Atenção — ${aviso}` : receita ? "Recebimento registrado." : "Pagamento registrado.", aviso ? 5000 : 2500);
    },
    corpo: `
      <p><strong>${esc(l.descricao)}</strong><br><span class="at-sub">Vencimento ${dataBR(l.vencimento)}</span></p>
      <div class="linha3">
        <label>${receita ? "Recebido em" : "Pago em"}<input type="date" id="fp-data" value="${hoje()}"></label>
        <label>Valor (R$)<input id="fp-valor" inputmode="decimal" value="${esc(valorCampo(l.valor))}"></label>
        <label>Conta<select id="fp-conta">${opcoesContas(l.conta_id || contaPadrao())}</select></label>
      </div>
      ${l.compromisso_id ? '<p class="at-sub">O lembrete na agenda será marcado como cumprido.</p>' : ""}`,
  });
}

// ------------------------------------------------------------- contratos de honorários

function atendimentosFechados(atual) {
  return at.lista.filter((a) => ["aguardando_distribuicao", "distribuida"].includes(a.situacao) || a.id === atual)
    .map((a) => [a.id, `${dataBR(a.data_atendimento)} · ${tituloAtendimento(a)}`]);
}

function abrirContrato(c, atendimento) {
  const novo = !c;
  const d = c || {
    tipo: "fixo", parcelas: 1, situacao: "ativo",
    cliente_nome: atendimento?.cliente_nome || "", cliente_id: atendimento?.cliente_id || null,
    atendimento_id: atendimento?.id || null, processo: atendimento?.processo || "",
  };
  const r = novo ? null : resumoContrato(c);
  const exito = d.tipo !== "fixo";
  abrirDialogo({
    titulo: novo ? "Novo contrato de honorários" : `Honorários · ${d.cliente_nome}`,
    somenteLeitura: !pode("financeiro", 2),
    excluir: !novo && pode("financeiro", 3) ? () => excluirContrato(c) : null,
    salvar: () => salvarContrato(c, d),
    corpo: `
      <div class="linha2">
        <label>Cliente<input id="fc-cliente" list="fin-clientes" required maxlength="200" value="${esc(d.cliente_nome)}"></label>
        <label>Processo (opcional)<input id="fc-processo" maxlength="60" value="${esc(d.processo || "")}"></label>
      </div>
      <label>Atendimento de origem<select id="fc-atendimento">${opcoes(atendimentosFechados(d.atendimento_id), d.atendimento_id, "—")}</select></label>
      <span class="rotulo">Tipo de honorários</span>
      ${escolhas("fc-tipo", Object.entries(TIPOS_CONTRATO), d.tipo, !novo)}
      <div id="fc-fixo" ${d.tipo === "exito" ? "hidden" : ""}>
        ${novo ? `
        <div class="linha3">
          <label>Valor total fixo (R$)<input id="fc-valor" inputmode="decimal" placeholder="0,00"></label>
          <label>Parcelas<input type="number" id="fc-parcelas" min="1" max="120" value="1"></label>
          <label>1º vencimento<input type="date" id="fc-vencimento" value="${hoje()}"></label>
        </div>
        <div class="linha2">
          <label>Conta para receber<select id="fc-conta">${opcoesContas(contaPadrao())}</select></label>
          <label class="check fc-agenda"><input type="checkbox" id="fc-agenda"> Lembrar cada parcela na Agenda</label>
        </div>
        <p class="at-sub" id="fc-previa"></p>`
        : `<p>Valor fixo: <strong>${moeda(d.valor_fixo)}</strong>${d.parcelas > 1 ? ` em ${d.parcelas} parcelas` : ""} ·
            recebido ${moeda(r.recebido)}${r.parcelas.length ? ` · ${r.pagas.length} de ${r.parcelas.length} parcela(s) paga(s)` : ""}.</p>`}
      </div>
      <div id="fc-exito" ${exito ? "" : "hidden"}>
        <label>Percentual de êxito (%)<input id="fc-percentual" inputmode="decimal" value="${esc(d.percentual_exito != null ? String(d.percentual_exito).replace(".", ",") : "")}" placeholder="30"></label>
      </div>
      ${novo ? "" : `<label>Situação<select id="fc-situacao">${opcoes(Object.entries(SITUACOES_CONTRATO), d.situacao)}</select></label>`}
      <label>Observações<textarea id="fc-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${novo ? "" : `
        <div class="bloco-dlg">
          <span class="rotulo">Lançamentos deste contrato</span>
          ${r.lancs.length ? `<table class="fin mini"><tbody>${[...r.lancs].sort((a, b) => a.vencimento.localeCompare(b.vencimento)).map((l) => `
            <tr><td>${dataBR(l.vencimento)}</td><td><a href="#financeiro/lancamento/${esc(l.id)}">${esc(l.descricao)}</a></td>
            <td class="num valor">${moeda(l.valor)}</td>
            <td>${l.pago_em ? '<span class="selo-at distribuida">recebido</span>' : emAtraso(l) ? '<span class="selo-at atrasado">em atraso</span>' : '<span class="selo-at">a vencer</span>'}</td></tr>`).join("")}
          </tbody></table>` : '<p class="at-sub">Nenhum lançamento ainda.</p>'}
          ${pode("financeiro", 2) ? `<div class="acoes-dlg">
            ${exito ? `<button type="button" class="botao-sec mini" data-exito="${esc(c.id)}">+ Recebimento de êxito</button>` : ""}
            <button type="button" class="botao-sec mini" data-parcela-extra="${esc(c.id)}">+ Outra parcela</button></div>` : ""}
          <p class="at-sub">Para mudar valor ou data de uma parcela, abra a parcela.</p>
        </div>`}
      ${rodapeAutoria(c)}`,
  });
  if (novo) atualizarPreviaContrato();
}

function atualizarPreviaContrato() {
  if (!$("fc-previa")) return;
  const valor = lerValor($("fc-valor").value), n = Math.max(1, Number($("fc-parcelas").value) || 1), venc = $("fc-vencimento").value;
  if (!(valor > 0) || !venc) { $("fc-previa").textContent = ""; return; }
  const linhas = montarParcelas({ valor, vencimento: venc, descricao: "" }, n, true);
  $("fc-previa").textContent = n === 1
    ? `Uma parcela de ${moeda(valor)} em ${dataBR(venc)}.`
    : `${n} parcelas de ${moeda(linhas[0].valor)}${linhas[n - 1].valor !== linhas[0].valor ? ` (a última de ${moeda(linhas[n - 1].valor)})` : ""}, de ${dataBR(venc)} a ${dataBR(linhas[n - 1].vencimento)}.`;
}

async function salvarContrato(c, d) {
  const novo = !c;
  const clienteNome = $("fc-cliente").value.trim();
  if (!clienteNome) { avisar("Informe o cliente."); return; }
  const cliente = clientePorNome(clienteNome);
  const tipo = novo ? escolhido("fc-tipo") : c.tipo;
  const percentual = tipo === "fixo" ? null : lerValor($("fc-percentual").value);
  if (tipo !== "fixo" && !(percentual > 0 && percentual <= 100)) { avisar("Informe o percentual de êxito."); return; }
  const dados = {
    cliente_nome: clienteNome,
    cliente_id: cliente?.id ?? (clienteNome === d.cliente_nome ? d.cliente_id : null),
    processo: $("fc-processo").value.trim() || null,
    atendimento_id: $("fc-atendimento").value || null,
    percentual_exito: percentual,
    observacoes: $("fc-obs").value.trim() || null,
  };
  let parcelas = [];
  if (novo) {
    dados.tipo = tipo;
    if (tipo !== "exito") {
      const valor = lerValor($("fc-valor").value);
      const n = Math.max(1, Math.min(120, Number($("fc-parcelas").value) || 1));
      const venc = $("fc-vencimento").value;
      if (!(valor > 0) || !venc) { avisar("Informe o valor fixo e o primeiro vencimento."); return; }
      dados.valor_fixo = valor;
      dados.parcelas = n;
      parcelas = montarParcelas({
        natureza: "receita", descricao: `Honorários — ${clienteNome}`, valor, vencimento: venc, pago_em: null,
        categoria_id: categoriaPorNome("Honorários fixos", "receita")?.id || null, conta_id: $("fc-conta").value || null,
        cliente_nome: clienteNome, cliente_id: dados.cliente_id, processo: dados.processo, atendimento_id: dados.atendimento_id,
      }, n, true);
      if (n === 1) Object.assign(parcelas[0], { parcela: 1, total_parcelas: 1 });
    }
  } else {
    dados.situacao = $("fc-situacao").value;
  }
  $("dfin-ok").disabled = true;
  try {
    const consulta = novo ? sb.from("fin_contratos").insert(dados) : sb.from("fin_contratos").update(dados).eq("id", c.id);
    const { data: salvo, error } = await consulta.select().single();
    if (error) { avisar(mensagemErro(error), 4000); return; }
    guardar(fin.contratos, salvo);
    let aviso = null;
    if (parcelas.length) {
      const { data, error: e2 } = await sb.from("fin_lancamentos").insert(parcelas.map((p) => ({ ...p, contrato_id: salvo.id }))).select();
      if (e2) { avisar(`Contrato salvo, mas as parcelas não: ${mensagemErro(e2)}`, 6000); return; }
      data.forEach((x) => guardar(fin.lancamentos, x));
      if ($("fc-agenda").checked) for (const x of data) aviso = (await sincronizarVencimento(x, true)) || aviso;
    }
    fecharDialogo();
    renderizarFinanceiro();
    if (at.carregado) renderizarAtendimentos();
    avisar(aviso ? `Salvo. Atenção — ${aviso}` : novo && parcelas.length > 1 ? `Contrato salvo com ${parcelas.length} parcelas a receber.` : "Contrato salvo.", aviso ? 5000 : 3000);
  } finally {
    $("dfin-ok").disabled = false;
  }
}

async function excluirContrato(c) {
  const r = resumoContrato(c);
  if (r.lancs.some((l) => l.pago_em)) {
    avisar("Este contrato já tem valores recebidos. Em vez de excluir, mude a situação para “Encerrado” ou “Cancelado”.", 6000);
    return;
  }
  if (!confirm(`Excluir o contrato de ${c.cliente_nome} e ${r.lancs.length} parcela(s) a receber? Esta ação não pode ser desfeita.`)) return;
  for (const l of r.lancs) {
    if (l.compromisso_id) await sincronizarVencimento(l, false);
    const { error } = await sb.from("fin_lancamentos").delete().eq("id", l.id);
    if (error) { avisar(mensagemErro(error), 4000); return; }
    fin.lancamentos = fin.lancamentos.filter((x) => x.id !== l.id);
  }
  const { error } = await sb.from("fin_contratos").delete().eq("id", c.id);
  if (error) { avisar(mensagemErro(error), 4000); return; }
  fin.contratos = fin.contratos.filter((x) => x.id !== c.id);
  fecharDialogo();
  renderizarFinanceiro();
  if (at.carregado) renderizarAtendimentos();
  avisar("Contrato excluído.");
}

function baseDoContrato(c, extra) {
  return {
    natureza: "receita", contrato_id: c.id, cliente_nome: c.cliente_nome, cliente_id: c.cliente_id,
    processo: c.processo, atendimento_id: c.atendimento_id, conta_id: contaPadrao(), ...extra,
  };
}

// ------------------------------------------------------------- alvarás

function abrirAlvara(a) {
  const novo = !a;
  const d = a || { data_levantamento: hoje(), conta_id: contaPadrao(), descontos: 0 };
  const contratos = fin.contratos.filter((c) => c.percentual_exito != null || c.id === d.contrato_id)
    .map((c) => [c.id, `${c.cliente_nome}${c.processo ? ` · ${c.processo}` : ""} · ${String(c.percentual_exito ?? "").replace(".", ",")}%`]);
  abrirDialogo({
    titulo: novo ? "Novo alvará" : `Alvará · ${d.cliente_nome}`,
    somenteLeitura: !pode("financeiro", 2),
    excluir: !novo && pode("financeiro", 3) ? () => excluirAlvara(a) : null,
    salvar: () => salvarAlvara(a, d),
    corpo: `
      <label>Contrato de honorários (opcional)<select id="fa-contrato">${opcoes(contratos, d.contrato_id, "—")}</select></label>
      <div class="linha2">
        <label>Cliente<input id="fa-cliente" list="fin-clientes" required maxlength="200" value="${esc(d.cliente_nome || "")}"></label>
        <label>Processo<input id="fa-processo" maxlength="60" value="${esc(d.processo || "")}"></label>
      </div>
      <div class="linha2">
        <label>Data do levantamento<input type="date" id="fa-data" required value="${esc(d.data_levantamento)}"></label>
        <label>Conta que recebeu<select id="fa-conta">${opcoesContas(d.conta_id)}</select></label>
      </div>
      <div class="linha3">
        <label>Valor levantado (R$)<input id="fa-levantado" inputmode="decimal" required value="${esc(valorCampo(d.valor_levantado))}"></label>
        <label>Honorários retidos (R$)<input id="fa-honorarios" inputmode="decimal" value="${esc(valorCampo(d.honorarios))}"></label>
        <label>Custas reembolsadas (R$)<input id="fa-descontos" inputmode="decimal" value="${esc(valorCampo(d.descontos))}"></label>
      </div>
      <button type="button" class="botao-sec mini" id="fa-calcular" hidden></button>
      <p class="previa" id="fa-previa"></p>
      <label>Repassado ao cliente em<input type="date" id="fa-repassado" value="${esc(d.repassado_em || "")}"></label>
      <label>Observações<textarea id="fa-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      <p class="at-sub">Os honorários retidos entram como receita (“Honorários de êxito”) na data do levantamento. O valor do cliente não entra no resultado do escritório.</p>
      ${rodapeAutoria(a)}`,
  });
  atualizarPreviaAlvara();
}

function atualizarPreviaAlvara() {
  if (!$("fa-previa")) return;
  const levantado = lerValor($("fa-levantado").value) || 0;
  const honorarios = lerValor($("fa-honorarios").value) || 0;
  const descontos = lerValor($("fa-descontos").value) || 0;
  const contrato = fin.contratos.find((c) => c.id === $("fa-contrato").value);
  const botao = $("fa-calcular");
  botao.hidden = !(contrato?.percentual_exito != null && levantado > 0);
  if (!botao.hidden) {
    const calc = Math.round(levantado * contrato.percentual_exito) / 100;
    botao.textContent = `Usar ${String(contrato.percentual_exito).replace(".", ",")}% do levantado: ${moeda(calc)}`;
    botao.dataset.valor = calc;
  }
  const repasse = levantado - honorarios - descontos;
  $("fa-previa").innerHTML = levantado
    ? `Repasse ao cliente: <strong class="${repasse < 0 ? "atrasado" : ""}">${moeda(repasse)}</strong>` : "";
}

async function salvarAlvara(a, d) {
  const novo = !a;
  const clienteNome = $("fa-cliente").value.trim();
  const levantado = lerValor($("fa-levantado").value);
  const honorarios = lerValor($("fa-honorarios").value) || 0;
  const descontos = lerValor($("fa-descontos").value) || 0;
  const dataLev = $("fa-data").value;
  if (!clienteNome || !(levantado > 0) || !dataLev) { avisar("Preencha cliente, data e valor levantado."); return; }
  if (honorarios + descontos > levantado) { avisar("Honorários e custas não podem passar do valor levantado."); return; }
  const cliente = clientePorNome(clienteNome);
  const dados = {
    cliente_nome: clienteNome,
    cliente_id: cliente?.id ?? (clienteNome === d.cliente_nome ? d.cliente_id : null),
    processo: $("fa-processo").value.trim() || null,
    contrato_id: $("fa-contrato").value || null,
    data_levantamento: dataLev,
    conta_id: $("fa-conta").value || null,
    valor_levantado: levantado, honorarios, descontos,
    repassado_em: $("fa-repassado").value || null,
    observacoes: $("fa-obs").value.trim() || null,
  };
  $("dfin-ok").disabled = true;
  try {
    const consulta = novo ? sb.from("fin_alvaras").insert(dados) : sb.from("fin_alvaras").update(dados).eq("id", a.id);
    const { data: salvo, error } = await consulta.select().single();
    if (error) { avisar(mensagemErro(error), 4000); return; }
    guardar(fin.alvaras, salvo);

    // honorários retidos viram (ou atualizam) a receita ligada ao alvará
    const receita = {
      natureza: "receita", descricao: `Êxito — ${clienteNome}${dados.processo ? ` (${dados.processo})` : ""}`,
      valor: honorarios, vencimento: dataLev, pago_em: dataLev, conta_id: dados.conta_id,
      categoria_id: categoriaPorNome("Honorários de êxito", "receita")?.id || null,
      cliente_nome: clienteNome, cliente_id: dados.cliente_id, processo: dados.processo, contrato_id: dados.contrato_id,
    };
    let aviso = null;
    if (honorarios > 0) {
      const q = salvo.lancamento_id
        ? sb.from("fin_lancamentos").update(receita).eq("id", salvo.lancamento_id)
        : sb.from("fin_lancamentos").insert(receita);
      const { data: lanc, error: e2 } = await q.select().single();
      if (e2) aviso = `a receita dos honorários não foi gravada (${mensagemErro(e2)})`;
      else {
        guardar(fin.lancamentos, lanc);
        if (!salvo.lancamento_id) {
          const { data: ligado } = await sb.from("fin_alvaras").update({ lancamento_id: lanc.id }).eq("id", salvo.id).select().single();
          if (ligado) guardar(fin.alvaras, ligado);
        }
      }
    } else if (salvo.lancamento_id) {
      const { error: e3 } = await sb.from("fin_lancamentos").delete().eq("id", salvo.lancamento_id);
      if (e3) aviso = "a receita antiga dos honorários continua lançada; peça a quem administra o financeiro para excluí-la";
      else fin.lancamentos = fin.lancamentos.filter((x) => x.id !== salvo.lancamento_id);
    }
    fecharDialogo();
    renderizarFinanceiro();
    avisar(aviso ? `Alvará salvo. Atenção — ${aviso}.` : "Alvará salvo.", aviso ? 6000 : 2500);
  } finally {
    $("dfin-ok").disabled = false;
  }
}

async function excluirAlvara(a) {
  if (!confirm(`Excluir o alvará de ${a.cliente_nome} (${moeda(a.valor_levantado)}) e a receita dos honorários ligada a ele?`)) return;
  const { error } = await sb.from("fin_alvaras").delete().eq("id", a.id);
  if (error) { avisar(mensagemErro(error), 4000); return; }
  fin.alvaras = fin.alvaras.filter((x) => x.id !== a.id);
  if (a.lancamento_id) {
    await sb.from("fin_lancamentos").delete().eq("id", a.lancamento_id);
    fin.lancamentos = fin.lancamentos.filter((x) => x.id !== a.lancamento_id);
  }
  fecharDialogo();
  renderizarFinanceiro();
  avisar("Alvará excluído.");
}

// ------------------------------------------------------------- configurações

async function salvarConfig(tabela, id, linha) {
  const nome = linha.querySelector(".cfg-nome").value.trim();
  if (!nome) { avisar("Informe o nome."); return; }
  const dados = { nome, ativa: linha.querySelector(".cfg-ativa").checked };
  if (tabela === "fin_contas") {
    dados.tipo = linha.querySelector(".cfg-tipo").value;
    const saldo = lerValor(linha.querySelector(".cfg-saldo").value || "0");
    if (!Number.isFinite(saldo)) { avisar("Saldo inicial inválido."); return; }
    dados.saldo_inicial = saldo;
  }
  const { data, error } = await sb.from(tabela).update(dados).eq("id", id).select().single();
  if (error) { avisar(mensagemErro(error), 4000); return; }
  guardar(tabela === "fin_contas" ? fin.contas : fin.categorias, data);
  renderizarFinanceiro();
  avisar("Salvo.");
}

async function novaConfig(tabela, dados) {
  const lista = tabela === "fin_contas" ? fin.contas : fin.categorias;
  const ordem = Math.max(0, ...lista.map((x) => x.ordem || 0)) + 1;
  const { data, error } = await sb.from(tabela).insert({ ...dados, ordem }).select().single();
  if (error) { avisar(mensagemErro(error), 4000); return; }
  lista.push(data);
  renderizarFinanceiro();
  avisar("Criado. Ajuste o nome e clique em Salvar.");
}

// ------------------------------------------------------------- exportação

function exportarFinanceiro() {
  const mes = fin.mes || hoje().slice(0, 7);
  const lista = lancamentosDoMes().sort((a, b) => (a.pago_em || a.vencimento).localeCompare(b.pago_em || b.vencimento));
  const celula = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const numero = (v) => Number(v).toFixed(2).replace(".", ",");
  const linhas = [
    ["Vencimento", "Pago/recebido em", "Tipo", "Descrição", "Categoria", "Conta", "Cliente", "Processo", "Reembolsável", "Valor"],
    ...lista.map((l) => [dataBR(l.vencimento), dataBR(l.pago_em), l.natureza === "receita" ? "Receita" : "Despesa", l.descricao,
      nomeCategoria(l.categoria_id), nomeConta(l.conta_id), l.cliente_nome, l.processo, l.reembolsavel ? "sim" : "",
      numero(l.natureza === "despesa" ? -l.valor : l.valor)]),
  ];
  const alvaras = fin.alvaras.filter((a) => a.data_levantamento.startsWith(mes));
  if (alvaras.length) {
    linhas.push([], ["Alvarás do mês"], ["Data", "Cliente", "Processo", "Levantado", "Honorários", "Custas reembolsadas", "Repasse", "Repassado em"]);
    alvaras.forEach((a) => linhas.push([dataBR(a.data_levantamento), a.cliente_nome, a.processo,
      numero(a.valor_levantado), numero(a.honorarios), numero(a.descontos), numero(a.repasse), dataBR(a.repassado_em)]));
  }
  const csv = "﻿" + linhas.map((l) => l.map((c) => (/^-?\d+,\d{2}$/.test(c) ? c : celula(c))).join(";")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `financeiro-${mes}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ------------------------------------------------------------- eventos

function prepararFinanceiro() {
  $("fin-mes-anterior").addEventListener("click", () => { fin.mes = somarMeses(`${fin.mes || hoje().slice(0, 7)}-01`, -1).slice(0, 7); renderizarFinanceiro(); });
  $("fin-mes-proximo").addEventListener("click", () => { fin.mes = somarMeses(`${fin.mes || hoje().slice(0, 7)}-01`, 1).slice(0, 7); renderizarFinanceiro(); });
  $("fin-novo-receita").addEventListener("click", () => abrirLancamento(null, { natureza: "receita" }));
  $("fin-novo-despesa").addEventListener("click", () => abrirLancamento(null, { natureza: "despesa" }));
  $("fin-exportar").addEventListener("click", exportarFinanceiro);
  document.querySelectorAll("[data-fin-sub]").forEach((b) => b.addEventListener("click", () => {
    location.hash = `#financeiro/${b.dataset.finSub}`;
  }));

  const conteudo = $("fin-conteudo");
  conteudo.addEventListener("input", (e) => { if (e.target.id === "fl-busca") renderizarTabelaLancamentos(); });
  conteudo.addEventListener("change", (e) => { if (/^fl-f-/.test(e.target.id)) renderizarTabelaLancamentos(); });
  conteudo.addEventListener("click", (e) => {
    const t = e.target.closest("button, a, tr[data-ir]");
    if (!t) return;
    if (t.dataset.pagar) abrirPagamento(fin.lancamentos.find((l) => l.id === t.dataset.pagar));
    else if (t.dataset.novoContrato !== undefined) abrirContrato(null);
    else if (t.dataset.novoAlvara !== undefined) abrirAlvara(null);
    else if (t.dataset.salvarConta) salvarConfig("fin_contas", t.dataset.salvarConta, t.closest("tr"));
    else if (t.dataset.salvarCategoria) salvarConfig("fin_categorias", t.dataset.salvarCategoria, t.closest("tr"));
    else if (t.dataset.novaConta !== undefined) novaConfig("fin_contas", { nome: "Nova conta", tipo: "banco" });
    else if (t.dataset.novaCategoria) novaConfig("fin_categorias", { nome: "Nova categoria", natureza: t.dataset.novaCategoria });
    else if (t.tagName === "TR") location.hash = t.dataset.ir;
  });

  $("form-fin").addEventListener("submit", (e) => { e.preventDefault(); fin.dialogo?.salvar?.(); });
  $("dfin-excluir").addEventListener("click", () => fin.dialogo?.excluir?.());
  $("dlg-fin").addEventListener("click", (e) => {
    if (e.target.closest("[data-fechar]")) { fecharDialogo(); return; }
    const t = e.target.closest("button");
    if (t?.id === "fa-calcular") { $("fa-honorarios").value = valorCampo(t.dataset.valor); atualizarPreviaAlvara(); }
    if (t?.dataset.exito) {
      const c = fin.contratos.find((x) => x.id === t.dataset.exito);
      abrirLancamento(null, baseDoContrato(c, {
        descricao: `Êxito — ${c.cliente_nome}`, pago_em: hoje(),
        categoria_id: categoriaPorNome("Honorários de êxito", "receita")?.id,
      }));
    }
    if (t?.dataset.parcelaExtra) {
      const c = fin.contratos.find((x) => x.id === t.dataset.parcelaExtra);
      abrirLancamento(null, baseDoContrato(c, {
        descricao: `Honorários — ${c.cliente_nome}`, categoria_id: categoriaPorNome("Honorários fixos", "receita")?.id,
      }));
    }
  });
  $("dlg-fin").addEventListener("input", (e) => {
    if (/^fc-(valor|parcelas|vencimento)$/.test(e.target.id)) atualizarPreviaContrato();
    if (/^fa-/.test(e.target.id)) atualizarPreviaAlvara();
  });
  $("dlg-fin").addEventListener("change", (e) => {
    const t = e.target;
    const unico = t.closest('.escolhas[data-tipo="opcao"]');
    if (unico) {
      if (!t.checked) { t.checked = true; return; }
      unico.querySelectorAll("input").forEach((i) => { if (i !== t) i.checked = false; });
    }
    if (unico?.id === "fl-natureza") {
      const receita = t.value === "receita";
      $("dfin-titulo").textContent = receita ? "Nova receita" : "Nova despesa";
      $("fl-categoria").innerHTML = opcoesCategorias(t.value);
      $("fl-pago-rotulo").textContent = receita ? "Recebido em" : "Pago em";
      $("fl-reembolsavel-l").hidden = receita;
    }
    if (unico?.id === "fc-tipo") {
      $("fc-fixo").hidden = t.value === "exito";
      $("fc-exito").hidden = t.value === "fixo";
    }
    if (t.id === "fl-repetir") $("fl-vezes").disabled = !t.value;
    if (t.id === "fc-atendimento" && t.value) {
      const a = at.lista.find((x) => x.id === t.value);
      if (a && !$("fc-cliente").value.trim()) $("fc-cliente").value = a.cliente_nome || "";
      if (a?.processo && !$("fc-processo").value.trim()) $("fc-processo").value = a.processo;
    }
    if (t.id === "fa-contrato" && t.value) {
      const c = fin.contratos.find((x) => x.id === t.value);
      if (c && !$("fa-cliente").value.trim()) $("fa-cliente").value = c.cliente_nome;
      if (c?.processo && !$("fa-processo").value.trim()) $("fa-processo").value = c.processo;
    }
    if (/^fa-/.test(t.id)) atualizarPreviaAlvara();
  });
  $("dlg-fin").addEventListener("close", () => {
    fin.dialogo = null;
    if (/^#financeiro\/(lancamento|contrato|alvara)\//.test(location.hash)) history.replaceState(null, "", `#financeiro/${fin.sub}`);
  });
}
