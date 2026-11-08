// Aba Financeiro: lançamentos, transferências entre contas, contas a receber e a pagar,
// contratos de honorários (parcelados, êxito e fixo mensal), alvarás e acordos com repasse ao cliente
// e reserva automática de imposto na poupança.
// Grava direto no banco; as regras por nível (public.nivel('financeiro')) valem lá:
// 1 vê e exporta, 2 lança, 3 administra (contas, categorias, configurações e exclusões de valores pagos).
// Vencimentos podem ir para a agenda pela função "agenda", com o tipo "financeiro".
// Usa as utilidades de app.js ($, esc, sb, estado, avisar, pode...) e de atendimento.js (at, normalizarNome).

const SUBS_FIN = {
  geral: "Visão geral", lancamentos: "Lançamentos", receber: "A receber", pagar: "A pagar",
  honorarios: "Honorários", alvaras: "Alvarás e acordos", config: "Configurações",
};
const TIPOS_CONTA = { banco: "Banco", poupanca: "Poupança", caixa: "Caixa", cartao: "Cartão de crédito", outro: "Outro" };
const TIPOS_CONTRATO = { fixo: "Parcelado", mensal: "Fixo mensal", exito: "Êxito", fixo_exito: "Parcelado + êxito" };
const SITUACOES_CONTRATO = { ativo: "Ativo", encerrado: "Encerrado", cancelado: "Cancelado" };
const NATUREZAS = { receita: "Receita", despesa: "Despesa", transferencia: "Transferência" };
const ORIGENS = { alvara: "Alvará judicial", acordo: "Acordo" };
const MESES_MENSAL = 12; // contratos fixos mensais ficam sempre com 12 meses lançados à frente

const fin = {
  contas: [], categorias: [], lancamentos: [], contratos: [], alvaras: [], config: null,
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
const centavos = (v) => Math.round(Number(v || 0) * 100) / 100;

// aceita "1.234,56", "1234,56", "1234.56" e "R$ 800"
function lerValor(s) {
  let t = String(s ?? "").replace(/[^\d,.-]/g, "");
  if (!t) return NaN;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ""); // "4.000" = quatro mil
  const n = Number(t);
  return Number.isFinite(n) ? centavos(n) : NaN;
}

function valorCampo(v) {
  return v == null || v === "" ? "" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percentualCampo(v) { return v == null || v === "" ? "" : String(Number(v)).replace(".", ","); }

// mesmo dia nos meses seguintes (31/01 + 1 mês = 28 ou 29/02)
function somarMeses(iso, n, dia) {
  const [a, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(dia || d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

function nomeMes(mes) {
  return new Date(`${mes}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
}
const mesBR = (mes) => `${mes.slice(5, 7)}/${mes.slice(0, 4)}`;

const conta = (id) => fin.contas.find((c) => c.id === id);
const nomeConta = (id) => conta(id)?.nome || "";
const categoria = (id) => fin.categorias.find((c) => c.id === id);
const nomeCategoria = (id) => categoria(id)?.nome || "Sem categoria";
const categoriaPorNome = (nome, natureza) =>
  fin.categorias.find((c) => c.nome === nome && c.natureza === natureza) ||
  fin.categorias.find((c) => c.natureza === natureza && c.ativa);
const contaPoupanca = () => fin.contas.find((c) => c.tipo === "poupanca" && c.ativa);
const contaPadrao = () => (fin.contas.find((c) => c.ativa && !["poupanca", "cartao"].includes(c.tipo)) || fin.contas.find((c) => c.ativa))?.id || null;
const emAtraso = (l) => !l.pago_em && l.vencimento < hoje();
const soma = (lista, f = (l) => l.valor) => centavos(lista.reduce((t, l) => t + Number(f(l) || 0), 0));
const registroDoTotal = (l) => fin.alvaras.find((a) => a.lancamento_id === l.id);
const registroDoRepasse = (l) => fin.alvaras.find((a) => a.repasse_lancamento_id === l.id);
const registroDe = (l) => registroDoTotal(l) || registroDoRepasse(l);

// quanto do lançamento é do escritório (o que entra no resultado do mês)
function valorResultado(l) {
  if (l.natureza === "transferencia") return 0;
  const reg = registroDoTotal(l);
  if (reg) return Number(reg.honorarios) + Number(reg.descontos);
  return categoria(l.categoria_id)?.resultado === false ? 0 : Number(l.valor);
}

// base da reserva de imposto: só a parte do escritório, recebida a partir da data de início da reserva
function baseImposto(l) {
  if (l.natureza !== "receita" || !l.pago_em || l.pago_em < (fin.config?.reserva_desde || "9999")) return 0;
  const reg = registroDoTotal(l);
  if (reg) return Number(reg.honorarios);
  return categoria(l.categoria_id)?.resultado === false ? 0 : Number(l.valor);
}

// valor que conta como honorários recebidos num contrato
function valorDoContrato(l) {
  const reg = registroDoTotal(l);
  return reg ? Number(reg.honorarios) : Number(l.valor);
}

function guardar(lista, item) {
  const i = lista.findIndex((x) => x.id === item.id);
  if (i >= 0) lista[i] = item; else lista.push(item);
}

function retirar(nome, id) { fin[nome] = fin[nome].filter((x) => x.id !== id); }

function clientePorNome(nome) {
  const alvo = normalizarNome(nome);
  return alvo ? at.clientes.find((c) => normalizarNome(c.nome) === alvo) : null;
}

function opcoes(lista, atual, vazio) {
  return (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : "") +
    lista.map(([v, r]) => `<option value="${esc(v)}" ${v === atual ? "selected" : ""}>${esc(r)}</option>`).join("");
}

function opcoesContas(atual, vazio = "—") {
  return opcoes(fin.contas.filter((c) => c.ativa || c.id === atual).map((c) => [c.id, c.nome]), atual, vazio);
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

// grava (insere ou altera) um lançamento e devolve o registro salvo, ou lança o erro
async function gravarLancamento(id, dados) {
  const q = id ? sb.from("fin_lancamentos").update(dados).eq("id", id) : sb.from("fin_lancamentos").insert(dados);
  const { data, error } = await q.select().single();
  if (error) throw new Error(mensagemErro(error));
  guardar(fin.lancamentos, data);
  return data;
}

async function apagarLancamento(id) {
  const { error } = await sb.from("fin_lancamentos").delete().eq("id", id);
  if (error) throw new Error(mensagemErro(error));
  fin.lancamentos = fin.lancamentos.filter((x) => x.id !== id && x.origem_id !== id);
}

// ------------------------------------------------------------- carga e rotas

async function carregarFinanceiro() {
  const [contas, categorias, lancamentos, contratos, alvaras, config] = await Promise.all([
    sb.from("fin_contas").select("*").order("ordem").order("nome"),
    sb.from("fin_categorias").select("*").order("ordem").order("nome"),
    lerTudo(() => sb.from("fin_lancamentos").select("*").order("vencimento").order("id")),
    lerTudo(() => sb.from("fin_contratos").select("*").order("criado_em").order("id")),
    lerTudo(() => sb.from("fin_alvaras").select("*").order("criado_em").order("id")),
    sb.from("fin_config").select("*").maybeSingle(),
  ]);
  const falha = [contas, categorias, lancamentos, contratos, alvaras].find((r) => r.error);
  if (falha) {
    $("fin-conteudo").innerHTML = `<div class="vazio">Não foi possível carregar o financeiro: ${esc(falha.error.message)}</div>`;
    return;
  }
  Object.assign(fin, {
    contas: contas.data, categorias: categorias.data, lancamentos: lancamentos.data,
    contratos: contratos.data, alvaras: alvaras.data, config: config.data || { percentual_imposto: 11, reserva_desde: hoje() },
    carregado: true,
  });
  preencherClientesFin();
  renderizarFinanceiro();
  if (at.carregado) renderizarAtendimentos();
  if (pode("financeiro", 2)) estenderMensais().then((n) => { if (n) renderizarFinanceiro(); });
}

function preencherClientesFin() {
  $("fin-clientes").innerHTML = at.clientes.map((c) => `<option value="${esc(c.nome)}">`).join("");
}

function rotearFinanceiro() {
  if (!fin.carregado) return;
  const [p1, p2, p3] = location.hash.replace(/^#/, "").split("/").slice(1);
  if (SUBS_FIN[p1]) fin.sub = p1;
  if (fin.sub === "config" && !pode("financeiro", 3)) fin.sub = "geral";
  if (p1 === "contrato") fin.sub = "honorarios";
  if (p1 === "alvara") fin.sub = "alvaras";
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
    if (a) abrirRecebimento(a); else naoEncontrado();
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
  const pagosNo = (m) => fin.lancamentos.filter((l) => l.pago_em?.startsWith(m) && l.natureza !== "transferencia");
  const doMes = pagosNo(mes);
  const receitas = doMes.filter((l) => l.natureza === "receita");
  const despesas = doMes.filter((l) => l.natureza === "despesa");
  const entradas = soma(receitas, valorResultado), saidas = soma(despesas, valorResultado);
  const resultado = centavos(entradas - saidas);
  const doAnterior = pagosNo(anterior);
  const resultadoAnterior = soma(doAnterior.filter((l) => l.natureza === "receita"), valorResultado) -
    soma(doAnterior.filter((l) => l.natureza === "despesa"), valorResultado);
  // caixa = tudo o que entrou e saiu; escritório = só o que entra no resultado
  const caixaEntradas = soma(receitas), caixaSaidas = soma(despesas);
  const deClientes = soma(receitas.filter((l) => registroDoTotal(l)), (l) => Number(l.valor) - valorResultado(l));
  const outrasEntradas = centavos(caixaEntradas - entradas - deClientes);
  const repasses = soma(despesas.filter((l) => registroDoRepasse(l) || nomeCategoria(l.categoria_id) === "Repasse ao Cliente"));
  const outrasSaidas = centavos(caixaSaidas - saidas - repasses);
  const saldoCaixa = centavos(caixaEntradas - caixaSaidas);
  const detalhe = (partes) => partes.filter(([v]) => Math.abs(v) > 0.004).map(([v, r]) => `${moedaCurta(v)} ${r}`).join("<br>");
  const aReceber = fin.lancamentos.filter((l) => l.natureza === "receita" && !l.pago_em);
  const atrasadas = aReceber.filter(emAtraso);

  $("fin-mes").textContent = nomeMes(mes);
  $("fin-n-entradas").textContent = moedaCurta(caixaEntradas);
  $("fin-r-entradas").innerHTML = detalhe([[entradas, "do escritório"], [outrasEntradas, "empréstimos e outros"], [deClientes, "de clientes"]]) || "nenhuma entrada";
  $("fin-n-saidas").textContent = moedaCurta(caixaSaidas);
  $("fin-r-saidas").innerHTML = detalhe([[saidas, "do escritório"], [repasses, "repasses a clientes"], [outrasSaidas, "retiradas e outros"]]) || "nenhuma saída";
  $("fin-n-caixa").textContent = moedaCurta(saldoCaixa);
  $("fin-n-caixa").className = `n ${saldoCaixa > 0 ? "pos" : saldoCaixa < 0 ? "neg" : ""}`;
  $("fin-r-caixa").textContent = "entradas menos saídas";
  $("fin-n-resultado").textContent = moedaCurta(resultado);
  $("fin-n-resultado").className = `n ${resultado > 0 ? "pos" : resultado < 0 ? "neg" : ""}`;
  $("fin-r-resultado").innerHTML = `${moedaCurta(entradas)} − ${moedaCurta(saidas)}` +
    (doAnterior.length ? `<br>${nomeMes(anterior).split(" ")[0]}: ${moedaCurta(resultadoAnterior)}` : "");
  $("fin-n-receber").textContent = moedaCurta(soma(aReceber));
  $("fin-r-receber").innerHTML = atrasadas.length
    ? `<span class="atrasado">${moedaCurta(soma(atrasadas))} em atraso</span>` : `${aReceber.length} em aberto`;

  for (const id of ["fin-novo-receita", "fin-novo-despesa", "fin-nova-transferencia"]) $(id).hidden = !pode("financeiro", 2);
  document.querySelectorAll("[data-fin-sub]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.finSub === fin.sub);
    if (b.dataset.finSub === "config") b.hidden = !pode("financeiro", 3);
  });

  const telas = {
    geral: telaGeral, lancamentos: telaLancamentos, receber: () => telaPendentes("receita"),
    pagar: () => telaPendentes("despesa"), honorarios: telaHonorarios, alvaras: telaRecebimentos, config: telaConfig,
  };
  $("fin-conteudo").innerHTML = telas[fin.sub](mes, doMes);
  if (fin.sub === "lancamentos") renderizarTabelaLancamentos();
}

function classeValor(l) { return l.natureza === "receita" ? "rec" : l.natureza === "despesa" ? "desp" : "transf"; }

function botaoEditar(l) {
  return `<a class="botao-sec mini editar" href="#financeiro/lancamento/${esc(l.id)}" title="Abrir e editar">✎ Editar</a>`;
}

function botaoPagar(l, curto = false) {
  if (!pode("financeiro", 2) || l.pago_em) return "";
  const verbo = l.natureza === "receita" ? "Marcar recebida" : l.natureza === "despesa" ? "Marcar paga" : "Marcar realizada";
  return `<button class="botao-sec mini" data-pagar="${esc(l.id)}" title="${verbo}">${curto ? "✓" : verbo}</button>`;
}

function subLancamento(l) {
  const partes = l.natureza === "transferencia"
    ? [`${nomeConta(l.conta_id)} → ${nomeConta(l.conta_destino_id)}`]
    : [nomeCategoria(l.categoria_id), l.cliente_nome, l.processo && `Proc. ${l.processo}`];
  if (l.restante_de) partes.push(`saldo de ${l.natureza === "receita" ? "recebimento" : "pagamento"} parcial`);
  if (l.compromisso_id) partes.push("📅 na agenda");
  return partes.filter(Boolean).map(esc).join(" · ");
}

function itemVencimento(l) {
  return `
  <div class="venc">
    <a class="venc-link" href="#financeiro/lancamento/${esc(l.id)}">
      <span class="d">${dataBR(l.vencimento).slice(0, 5)}</span>
      <span class="t"><b>${esc(l.descricao)}</b><span>${subLancamento(l)}</span></span>
    </a>
    ${emAtraso(l) ? '<span class="selo-at atrasado">em atraso</span>' : ""}
    <span class="valor ${classeValor(l)}">${moeda(l.valor)}</span>
    ${botaoPagar(l, true)}
  </div>`;
}

function saldosDasContas() {
  return fin.contas.map((c) => {
    const pagos = fin.lancamentos.filter((l) => l.pago_em);
    const saldo = Number(c.saldo_inicial)
      + soma(pagos.filter((l) => l.natureza === "receita" && l.conta_id === c.id))
      - soma(pagos.filter((l) => l.natureza === "despesa" && l.conta_id === c.id))
      - soma(pagos.filter((l) => l.natureza === "transferencia" && l.conta_id === c.id))
      + soma(pagos.filter((l) => l.natureza === "transferencia" && l.conta_destino_id === c.id));
    return { c, saldo: centavos(saldo) };
  }).filter((x) => x.c.ativa || Math.abs(x.saldo) > 0.004);
}

function telaGeral(mes, doMes) {
  const limite = somarDias(hoje(), 30);
  const proximos = fin.lancamentos.filter((l) => !l.pago_em && l.vencimento <= limite)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento)).slice(0, 20);

  const porCategoria = new Map();
  for (const l of doMes) {
    const v = valorResultado(l);
    if (!v) continue;
    const chave = `${l.natureza}|${l.categoria_id || ""}`;
    porCategoria.set(chave, (porCategoria.get(chave) || 0) + v);
  }
  const linhas = [...porCategoria.entries()].map(([k, v]) => ({ natureza: k.split("|")[0], categoria: k.split("|")[1], v }))
    .sort((a, b) => (a.natureza === b.natureza ? b.v - a.v : a.natureza === "receita" ? -1 : 1));
  const maior = Math.max(1, ...linhas.map((x) => x.v));
  const contas = saldosDasContas();
  const semConta = fin.lancamentos.filter((l) => l.pago_em && !l.conta_id && l.natureza !== "transferencia").length;
  const poup = contaPoupanca();

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
          <div class="cat"><span title="${esc(nomeCategoria(x.categoria))}">${esc(nomeCategoria(x.categoria))}</span>
            <span class="trilho"><i style="width:${Math.max(2, Math.round((100 * x.v) / maior))}%" class="${x.natureza}"></i></span>
            <span class="valor ${x.natureza === "receita" ? "rec" : "desp"}">${moedaCurta(x.v)}</span></div>`).join("")
          : '<div class="vazio pequeno">Nenhum lançamento pago neste mês.</div>'}
        <p class="at-sub">Valor total de alvarás e acordos conta só pela parte do escritório; repasses, empréstimos e poupança não entram no resultado.</p>
      </div>
      <div class="bloco">
        <h3>Saldo por conta</h3>
        ${contas.map((x) => `<div class="conta"><span>${esc(x.c.nome)}</span><span class="valor ${x.saldo < 0 ? "desp" : ""}">${moeda(x.saldo)}</span></div>`).join("")}
        <div class="conta total"><span>Total</span><span class="valor">${moeda(contas.reduce((t, x) => t + x.saldo, 0))}</span></div>
        ${poup ? `<p class="at-sub">Reserva de imposto: ${percentualCampo(fin.config?.percentual_imposto)}% de cada recebimento vai para a ${esc(poup.nome)} e volta no dia 20 do mês seguinte.</p>` : ""}
        ${semConta ? `<p class="at-sub">${semConta} lançamento(s) pago(s) sem conta não entram nos saldos.</p>` : ""}
        ${pode("financeiro", 3) ? '<p class="at-sub">Saldo inicial, contas e percentual em <a href="#financeiro/config">Configurações</a>.</p>' : ""}
      </div>
    </div>
  </div>`;
}

function telaLancamentos() {
  const contas = fin.contas.map((c) => [c.id, c.nome]);
  const cats = fin.categorias.map((c) => [c.id, `${c.nome} (${NATUREZAS[c.natureza].toLowerCase()})`]);
  return `
  <div class="filtros fin-filtros">
    <input class="busca" id="fl-busca" type="search" placeholder="Buscar descrição, cliente ou processo…" aria-label="Buscar lançamentos">
    <select id="fl-f-conta" aria-label="Conta">${opcoes(contas, "", "Todas as contas")}</select>
    <select id="fl-f-categoria" aria-label="Categoria">${opcoes(cats, "", "Todas as categorias")}</select>
    <select id="fl-f-natureza" aria-label="Tipo">${opcoes([["receita", "Só receitas"], ["despesa", "Só despesas"], ["transferencia", "Só transferências"]], "", "Todos os tipos")}</select>
  </div>
  <div class="contagem" id="fl-contagem"></div>
  <div class="bloco rol"><table class="fin"><thead><tr>
    <th>Data</th><th>Descrição</th><th>Categoria</th><th>Conta</th><th>Situação</th><th class="num">Valor</th><th></th>
  </tr></thead><tbody id="fl-corpo"></tbody></table></div>`;
}

function lancamentosDoMes() {
  const mes = fin.mes || hoje().slice(0, 7);
  return fin.lancamentos.filter((l) => l.pago_em?.startsWith(mes) || (!l.pago_em && l.vencimento.startsWith(mes)));
}

function seloSituacao(l) {
  if (l.pago_em && fin.lancamentos.some((x) => x.restante_de === l.id && !x.pago_em)) {
    return `<span class="selo-at aguardando_distribuicao">${l.natureza === "receita" ? "recebido" : "pago"} parcial</span>`;
  }
  if (l.pago_em) return `<span class="selo-at distribuida">${l.natureza === "receita" ? "recebido" : l.natureza === "despesa" ? "pago" : "realizada"}</span>`;
  return emAtraso(l) ? '<span class="selo-at atrasado">em atraso</span>' : '<span class="selo-at">a vencer</span>';
}

function renderizarTabelaLancamentos() {
  const busca = normalizarNome($("fl-busca")?.value || "");
  const contaF = $("fl-f-conta").value, categoriaF = $("fl-f-categoria").value, natureza = $("fl-f-natureza").value;
  const lista = lancamentosDoMes().filter((l) => {
    if (contaF && l.conta_id !== contaF && l.conta_destino_id !== contaF) return false;
    if (categoriaF && l.categoria_id !== categoriaF) return false;
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
    const sub = [l.cliente_nome, l.processo && `Proc. ${l.processo}`, l.reembolsavel && "reembolsável"].filter(Boolean).map(esc).join(" · ");
    const contaTxt = l.natureza === "transferencia" ? `${nomeConta(l.conta_id)} → ${nomeConta(l.conta_destino_id)}` : nomeConta(l.conta_id);
    const sinal = l.natureza === "despesa" ? "− " : "";
    return `<tr class="clicavel" data-ir="#financeiro/lancamento/${esc(l.id)}">
      <td>${dataBR(l.pago_em || l.vencimento).slice(0, 5)}</td>
      <td><a href="#financeiro/lancamento/${esc(l.id)}">${esc(l.descricao)}</a>${sub ? `<span class="at-sub" style="display:block">${sub}</span>` : ""}</td>
      <td>${esc(nomeCategoria(l.categoria_id))}</td><td>${esc(contaTxt)}</td><td>${seloSituacao(l)}</td>
      <td class="num valor ${classeValor(l)}">${sinal}${moeda(l.valor)}</td>
      <td>${botaoEditar(l)}</td></tr>`;
  }).join("") : '<tr><td colspan="7"><div class="vazio pequeno">Nenhum lançamento neste mês com esses filtros.</div></td></tr>';
}

function itemPendente(l) {
  return `
  <div class="at-item ${emAtraso(l) ? "fin-atrasado" : ""}">
    <a class="at-link" href="#financeiro/lancamento/${esc(l.id)}">
      <span class="at-data">${dataBR(l.vencimento)}</span>
      <span class="at-info"><span class="at-titulo">${esc(l.descricao)}</span><span class="at-sub">${subLancamento(l)}</span></span>
    </a>
    <span class="at-acoes"><span class="valor ${classeValor(l)}">${moeda(l.valor)}</span>
      <span class="acoes-linha">${botaoEditar(l)}${botaoPagar(l)}</span></span>
  </div>`;
}

function telaPendentes(natureza) {
  const lista = fin.lancamentos.filter((l) => l.natureza === natureza && !l.pago_em)
    .sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const fimMes = somarMeses(`${hoje().slice(0, 7)}-01`, 1);
  const repasse = (l) => !!registroDoRepasse(l);
  const grupos = [
    ["Em atraso", lista.filter(emAtraso)],
    ["Até o fim deste mês", lista.filter((l) => !emAtraso(l) && l.vencimento < fimMes && !repasse(l))],
    ["Repasses a clientes", natureza === "despesa" ? lista.filter((l) => !emAtraso(l) && repasse(l)) : []],
    ["Próximos meses", lista.filter((l) => !emAtraso(l) && l.vencimento >= fimMes && !repasse(l))],
  ];
  // resgates da poupança (dinheiro que volta para a conta do escritório) aparecem em "A receber"
  if (natureza === "receita") {
    grupos.push(["Resgates programados da poupança", fin.lancamentos
      .filter((l) => l.natureza === "transferencia" && !l.pago_em && l.conta_id === contaPoupanca()?.id)
      .sort((a, b) => a.vencimento.localeCompare(b.vencimento))]);
  }
  const visiveis = grupos.filter(([, g]) => g.length);
  return `
  <p class="contagem">${lista.length} em aberto · total ${moeda(soma(lista))}</p>
  ${visiveis.length ? visiveis.map(([titulo, g]) => `
    <h3 class="fin-grupo">${titulo} · ${moeda(soma(g))}</h3>
    <div class="lista">${g.map(itemPendente).join("")}</div>`).join("")
    : `<div class="vazio">Nada ${natureza === "receita" ? "a receber" : "a pagar"} em aberto.</div>`}`;
}

function resumoContrato(c) {
  const lancs = fin.lancamentos.filter((l) => l.contrato_id === c.id && l.natureza === "receita");
  const parcelas = lancs.filter((l) => l.parcela);
  const numeros = new Map(); // pagamento parcial: a parcela vira dois lançamentos com o mesmo número
  for (const l of parcelas) numeros.set(l.parcela, (numeros.get(l.parcela) ?? true) && !!l.pago_em);
  const nParcelas = numeros.size, nPagas = [...numeros.values()].filter(Boolean).length;
  return { lancs, parcelas, nParcelas, nPagas, recebido: soma(lancs.filter((l) => l.pago_em), valorDoContrato) };
}

function textoContratado(c) {
  if (c.tipo === "mensal") return `${moeda(c.valor_fixo)} por mês`;
  return [c.valor_fixo && moeda(c.valor_fixo), c.percentual_exito != null && `${percentualCampo(c.percentual_exito)}% de êxito`].filter(Boolean).join(" + ") || "—";
}

function telaHonorarios() {
  const ordem = { ativo: 0, encerrado: 1, cancelado: 2 };
  const lista = [...fin.contratos].sort((a, b) => ordem[a.situacao] - ordem[b.situacao] || b.criado_em.localeCompare(a.criado_em));
  return `
  <div class="barra-fin">${pode("financeiro", 2) ? '<button class="botao" data-novo-contrato>+ Contrato de honorários</button>' : ""}</div>
  ${lista.length ? `<div class="bloco rol"><table class="fin"><thead><tr>
    <th>Cliente</th><th>Tipo</th><th>Contratado</th><th class="num">Recebido</th><th>Parcelas</th><th>Situação</th><th>Origem</th><th></th>
  </tr></thead><tbody>${lista.map((c) => {
    const r = resumoContrato(c);
    const pct = r.nParcelas ? Math.round((100 * r.nPagas) / r.nParcelas) : 0;
    const atend = c.atendimento_id && at.lista.find((a) => a.id === c.atendimento_id);
    const parcelas = c.tipo === "mensal" ? `${r.nPagas} paga(s)` : r.nParcelas
      ? `<span class="prog"><i style="width:${pct}%"></i></span> ${r.nPagas}/${r.nParcelas}` : "—";
    return `<tr class="clicavel" data-ir="#financeiro/contrato/${esc(c.id)}">
      <td><a href="#financeiro/contrato/${esc(c.id)}">${esc(c.cliente_nome)}</a></td>
      <td>${TIPOS_CONTRATO[c.tipo]}</td><td>${esc(textoContratado(c))}</td>
      <td class="num valor rec">${r.recebido ? moeda(r.recebido) : "—"}</td>
      <td>${parcelas}</td>
      <td><span class="selo-at ${c.situacao === "ativo" ? "distribuida" : ""}">${SITUACOES_CONTRATO[c.situacao]}</span></td>
      <td>${atend ? `<a href="#atendimento/${esc(atend.id)}">Atendimento ${dataBR(atend.data_atendimento).slice(0, 5)}</a>` : esc(c.processo ? `Proc. ${c.processo}` : "—")}</td>
      <td><a class="botao-sec mini editar" href="#financeiro/contrato/${esc(c.id)}">✎ Editar</a></td></tr>`;
  }).join("")}</tbody></table></div>`
    : '<div class="vazio">Nenhum contrato de honorários cadastrado. Ao fechar um contrato no Atendimento, use “💰 Cadastrar honorários”.</div>'}`;
}

function telaRecebimentos() {
  const lista = [...fin.alvaras].sort((a, b) => (b.data_levantamento || b.vencimento || "").localeCompare(a.data_levantamento || a.vencimento || ""));
  const pendentes = lista.filter((a) => a.data_levantamento && !a.repassado_em && Number(a.repasse) > 0);
  return `
  <div class="barra-fin">
    ${pendentes.length ? `<span class="atrasado">${pendentes.length} repasse(s) pendente(s) · ${moeda(soma(pendentes, (a) => a.repasse))}</span>` : ""}
    ${pode("financeiro", 2) ? '<button class="botao-sec" data-novo-recebimento="acordo">+ Acordo</button><button class="botao" data-novo-recebimento="alvara">+ Alvará</button>' : ""}
  </div>
  <p class="at-sub">Valores pagos pela parte contrária ou levantados em juízo em que parte é do cliente. O valor total entra no caixa; só a parte do escritório entra no resultado; o repasse vira uma conta a pagar.</p>
  ${lista.length ? `<div class="bloco rol"><table class="fin"><thead><tr>
    <th>Data</th><th>Origem</th><th>Cliente / processo</th><th class="num">Valor total</th><th class="num">Escritório</th><th class="num">Repasse</th><th>Situação</th><th></th>
  </tr></thead><tbody>${lista.map((a) => {
    const situacao = !a.data_levantamento ? (a.vencimento < hoje() ? '<span class="selo-at atrasado">não recebido</span>' : '<span class="selo-at">a receber</span>')
      : a.repassado_em ? `<span class="selo-at distribuida">repassado ${dataBR(a.repassado_em).slice(0, 5)}</span>`
        : Number(a.repasse) > 0 ? '<span class="selo-at aguardando_distribuicao">repasse pendente</span>' : '<span class="selo-at distribuida">recebido</span>';
    return `
    <tr class="clicavel" data-ir="#financeiro/alvara/${esc(a.id)}">
      <td>${dataBR(a.data_levantamento || a.vencimento)}</td>
      <td>${ORIGENS[a.origem]}${a.total_parcelas > 1 ? ` ${a.parcela}/${a.total_parcelas}` : ""}</td>
      <td><a href="#financeiro/alvara/${esc(a.id)}">${esc(a.cliente_nome)}</a>${a.processo ? `<span class="at-sub" style="display:block">${esc(a.processo)}</span>` : ""}</td>
      <td class="num valor">${moeda(a.valor_levantado)}</td>
      <td class="num valor rec">${moeda(Number(a.honorarios) + Number(a.descontos))}</td>
      <td class="num valor">${moeda(a.repasse)}</td><td>${situacao}</td>
      <td><a class="botao-sec mini editar" href="#financeiro/alvara/${esc(a.id)}">✎ Editar</a></td></tr>`;
  }).join("")}
  </tbody></table></div>` : '<div class="vazio">Nenhum alvará ou acordo registrado.</div>'}`;
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
      ${c.natureza === "transferencia" ? "<td></td>" : `<td><label class="check" title="Desmarque para valores que só passam pelo caixa (parte do cliente, empréstimos)"><input type="checkbox" class="cfg-resultado" ${c.resultado !== false ? "checked" : ""}> entra no resultado</label></td>`}
      <td><label class="check"><input type="checkbox" class="cfg-ativa" ${c.ativa ? "checked" : ""}> ativa</label></td>
      <td><button class="botao-sec mini" data-salvar-categoria="${esc(c.id)}">Salvar</button></td></tr>`;
  const cats = (n) => fin.categorias.filter((c) => c.natureza === n);
  const titulos = { receita: "Categorias de receita", despesa: "Categorias de despesa", transferencia: "Tipos de transferência" };
  return `
  <div class="bloco rol">
    <h3>Contas</h3>
    <p class="at-sub">O saldo inicial é o saldo da conta no dia em que vocês começaram a lançar aqui. Contas desativadas somem dos formulários, mas o histórico fica.</p>
    <table class="fin cfg"><thead><tr><th>Nome</th><th>Tipo</th><th>Saldo inicial (R$)</th><th></th><th></th></tr></thead>
    <tbody>${fin.contas.map(linhaConta).join("")}</tbody></table>
    <button class="botao-sec" data-nova-conta>+ Conta</button>
  </div>
  <div class="bloco">
    <h3>Reserva de imposto</h3>
    <p class="at-sub">A cada recebimento (só a parte do escritório), o sistema transfere este percentual para a conta poupança e programa o resgate para o dia 20 do mês seguinte.</p>
    <div class="cfg-linha">
      <label>Percentual (%)<input id="cfg-imposto" inputmode="decimal" value="${esc(percentualCampo(fin.config?.percentual_imposto))}"></label>
      <label>Valer para recebimentos a partir de<input type="date" id="cfg-desde" value="${esc(fin.config?.reserva_desde || "")}"></label>
      <button class="botao-sec" data-salvar-reserva>Salvar</button>
    </div>
    ${contaPoupanca() ? "" : '<p class="atrasado">Cadastre uma conta do tipo “Poupança” para a reserva funcionar.</p>'}
  </div>
  <div class="fin-grade metade">
    ${["receita", "despesa"].map((n) => `
    <div class="bloco rol">
      <h3>${titulos[n]}</h3>
      <table class="fin cfg"><tbody>${cats(n).map(linhaCategoria).join("")}</tbody></table>
      <button class="botao-sec" data-nova-categoria="${n}">+ Categoria</button>
    </div>`).join("")}
  </div>
  <div class="bloco rol">
    <h3>${titulos.transferencia}</h3>
    <table class="fin cfg"><tbody>${cats("transferencia").map(linhaCategoria).join("")}</tbody></table>
    <button class="botao-sec" data-nova-categoria="transferencia">+ Tipo de transferência</button>
  </div>`;
}

// ------------------------------------------------------------- diálogo genérico

function abrirDialogo({ titulo, corpo, ok = "Salvar", salvar, excluir, somenteLeitura = false, extras = "" }) {
  fin.dialogo = { salvar, excluir };
  $("dfin-extras").innerHTML = extras; // botões do rodapé: funcionam mesmo com o formulário travado
  $("dfin-titulo").textContent = titulo;
  $("dfin-corpo").innerHTML = corpo;
  $("dfin-campos").disabled = somenteLeitura;
  $("dfin-ok").textContent = ok;
  $("dfin-ok").hidden = somenteLeitura || !salvar;
  $("dfin-excluir").hidden = !excluir;
  if (!$("dlg-fin").open) $("dlg-fin").showModal();
  $("dfin-campos").scrollTop = 0;
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

async function executar(acao, sucesso) {
  $("dfin-ok").disabled = true;
  try {
    const aviso = await acao();
    fecharDialogo();
    renderizarFinanceiro();
    if (at.carregado) renderizarAtendimentos();
    if (typeof proc !== "undefined" && proc.carregado) renderizarProcessos();
    if (typeof tf !== "undefined" && tf.carregado) renderizarTarefas();
    avisar(aviso ? `${sucesso} Atenção — ${aviso}` : sucesso, aviso ? 6000 : 2500);
  } catch (e) {
    avisar(e.message || "Não foi possível salvar.", 5000);
  } finally {
    $("dfin-ok").disabled = false;
  }
}

// ------------------------------------------------------------- reserva de imposto

// cria, ajusta ou remove a transferência para a poupança ligada a uma receita; depois acerta os resgates
async function atualizarReserva(l, removida = false) {
  const poup = contaPoupanca();
  if (!poup) return null;
  const existente = fin.lancamentos.find((x) => x.origem_id === l.id);
  const pct = Number(fin.config?.percentual_imposto ?? 11);
  const valor = removida ? 0 : centavos((baseImposto(l) * pct) / 100);
  const meses = new Set(existente?.pago_em ? [existente.pago_em.slice(0, 7)] : []);
  const origemConta = l.conta_id && l.conta_id !== poup.id ? l.conta_id : contaPadrao();
  if (valor > 0 && origemConta) {
    const dados = {
      natureza: "transferencia", descricao: `Reserva de imposto (${percentualCampo(pct)}%) — ${l.descricao}`,
      valor, vencimento: l.pago_em, pago_em: l.pago_em, conta_id: origemConta, conta_destino_id: poup.id,
      categoria_id: categoriaPorNome("Aplicação na poupança", "transferencia")?.id || null,
      origem_id: l.id, cliente_nome: l.cliente_nome, processo: l.processo,
    };
    await gravarLancamento(existente?.id, dados);
    meses.add(l.pago_em.slice(0, 7));
  } else if (existente) {
    if (!removida) await apagarLancamento(existente.id);
    else fin.lancamentos = fin.lancamentos.filter((x) => x.id !== existente.id);
  }
  for (const m of meses) await atualizarResgate(m);
  return null;
}

// um resgate por mês de competência, no dia 20 do mês seguinte, com a soma das reservas do mês
async function atualizarResgate(mes) {
  const poup = contaPoupanca();
  if (!poup) return;
  const referencia = `resgate-imposto-${mes}`;
  const existente = fin.lancamentos.find((x) => x.referencia === referencia);
  if (existente?.pago_em) return; // já resgatado: não mexe
  const total = soma(fin.lancamentos.filter((x) => x.origem_id && x.natureza === "transferencia" &&
    x.conta_destino_id === poup.id && x.pago_em?.startsWith(mes)));
  if (total > 0) {
    await gravarLancamento(existente?.id, {
      natureza: "transferencia", descricao: `Resgate para imposto — competência ${mesBR(mes)}`,
      valor: total, vencimento: `${somarMeses(`${mes}-01`, 1).slice(0, 7)}-20`, pago_em: null,
      conta_id: poup.id, conta_destino_id: existente?.conta_destino_id || contaPadrao(),
      categoria_id: categoriaPorNome("Resgate de poupança", "transferencia")?.id || null, referencia,
    });
  } else if (existente) {
    await apagarLancamento(existente.id);
  }
}

// ------------------------------------------------------------- lançamentos (receitas e despesas)

function compromissoAtivo(l) {
  if (!l?.compromisso_id) return false;
  const c = estado.compromissos.find((x) => x.id === l.compromisso_id);
  return c ? c.situacao !== "cancelado" : true;
}

function abrirLancamento(l, base = {}) {
  if ((l?.natureza || base.natureza) === "transferencia") return abrirTransferencia(l, base);
  const novo = !l?.id;
  const d = novo ? { natureza: "receita", vencimento: hoje(), conta_id: contaPadrao(), ...base } : l;
  const contrato = d.contrato_id && fin.contratos.find((c) => c.id === d.contrato_id);
  const reg = !novo && registroDe(d);
  const reserva = !novo && fin.lancamentos.find((x) => x.origem_id === d.id);
  const saldo = !novo && fin.lancamentos.find((x) => x.restante_de === d.id);
  const original = !novo && d.restante_de && fin.lancamentos.find((x) => x.id === d.restante_de);
  const termo = d.natureza === "receita" ? "recebimento" : "pagamento";
  const receita = d.natureza === "receita";
  const vinculos = [
    contrato && `Contrato de honorários de <a href="#financeiro/contrato/${esc(contrato.id)}">${esc(contrato.cliente_nome)}</a>`,
    d.parcela && `parcela ${d.parcela}/${d.total_parcelas}`,
    reg && `faz parte do <a href="#financeiro/alvara/${esc(reg.id)}">${ORIGENS[reg.origem].toLowerCase()} de ${esc(reg.cliente_nome)}</a> — altere valores por lá`,
    reserva && `reserva de imposto: <a href="#financeiro/lancamento/${esc(reserva.id)}">${moeda(reserva.valor)} para a poupança</a>`,
    saldo && `${termo} parcial: <a href="#financeiro/lancamento/${esc(saldo.id)}">saldo de ${moeda(saldo.valor)}</a> ${saldo.pago_em ? "já quitado" : `em aberto, vence ${dataBR(saldo.vencimento)}`}`,
    original && `saldo do ${termo} parcial de <a href="#financeiro/lancamento/${esc(original.id)}">${dataBR(original.pago_em)} (${moeda(original.valor)})</a>`,
  ].filter(Boolean);
  const extras = !novo && !d.pago_em && !registroDoRepasse(d) && pode("financeiro", 2)
    ? `<button type="button" class="botao-sec" data-parcial="${esc(d.id)}">${receita ? "Recebimento" : "Pagamento"} parcial</button>
       <button type="button" class="botao-sec" data-pagar-dlg="${esc(d.id)}">${receita ? "Marcar recebida" : "Marcar paga"}</button>` : "";
  abrirDialogo({
    titulo: novo ? `Nova ${receita ? "receita" : "despesa"}`
      : reg ? `${receita ? "Receita" : "Despesa"} do ${ORIGENS[reg.origem].toLowerCase()} — valores pelo ${ORIGENS[reg.origem].toLowerCase()}`
        : `Editar ${receita ? "receita" : "despesa"}`,
    extras,
    somenteLeitura: !pode("financeiro", 2) || !!reg,
    excluir: !novo && !reg && (pode("financeiro", 3) || (pode("financeiro", 2) && !d.pago_em)) ? () => excluirLancamento(d) : null,
    salvar: () => salvarLancamento(l, d),
    corpo: `
      ${escolhas("fl-natureza", [["receita", "Receita"], ["despesa", "Despesa"]], d.natureza)}
      <label>Descrição<input id="fl-descricao" required maxlength="200" value="${esc(d.descricao || "")}" placeholder="Ex.: Consulta — Cliente, Aluguel de novembro"></label>
      <div class="linha3">
        <label>Valor (R$)<input id="fl-valor" inputmode="decimal" required value="${esc(valorCampo(d.valor))}" placeholder="0,00"></label>
        <label>Vencimento<input type="date" id="fl-vencimento" required value="${esc(d.vencimento || "")}"></label>
        <label><span id="fl-pago-rotulo">${receita ? "Recebido em" : "Pago em"}</span><input type="date" id="fl-pago" value="${esc(d.pago_em || "")}"></label>
      </div>
      <p class="at-sub">Deixe “${receita ? "recebido" : "pago"} em” vazio para ficar ${receita ? "a receber" : "a pagar"}. Para desfazer um ${receita ? "recebimento" : "pagamento"}, apague a data.</p>
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
      <label class="check" id="fl-reembolsavel-l" ${receita ? "hidden" : ""}><input type="checkbox" id="fl-reembolsavel" ${d.reembolsavel ? "checked" : ""}> Despesa reembolsável pelo cliente (custas, cópias, diligências)</label>
      <label class="check"><input type="checkbox" id="fl-agenda" ${compromissoAtivo(d) ? "checked" : ""}> Lembrar do vencimento na Agenda (e no seu Google Agenda)</label>
      <label>Observações<textarea id="fl-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${vinculos.length ? `<div class="vinculo">${vinculos.join(" · ")}</div>` : ""}
      ${rodapeAutoria(l)}`,
  });
}

function salvarLancamento(l, d) {
  const novo = !l?.id;
  const natureza = escolhido("fl-natureza") || d.natureza;
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
  const repetir = novo ? $("fl-repetir").value : "";
  const vezes = repetir ? Math.max(2, Math.min(120, Number($("fl-vezes").value) || 2)) : 1;
  return executar(async () => {
    const linhas = novo
      ? montarParcelas({ ...dados, contrato_id: d.contrato_id || null, atendimento_id: d.atendimento_id || null }, vezes, repetir === "parcelar")
      : [dados];
    const salvos = [];
    if (novo) {
      const { data, error } = await sb.from("fin_lancamentos").insert(linhas).select();
      if (error) throw new Error(mensagemErro(error));
      data.forEach((x) => { guardar(fin.lancamentos, x); salvos.push(x); });
    } else {
      salvos.push(await gravarLancamento(l.id, dados));
    }
    let aviso = null;
    for (const x of salvos) {
      if (lembrar || x.compromisso_id) aviso = (await sincronizarVencimento(x, lembrar)) || aviso;
      await atualizarReserva(x);
    }
    return aviso;
  }, novo && vezes > 1 ? `${vezes} lançamentos criados.` : "Lançamento salvo.");
}

// divide em parcelas (centavos que sobram vão para a última) ou repete o mesmo valor todo mês
function montarParcelas(base, vezes, dividir) {
  if (vezes <= 1) return [base];
  const grupo = crypto.randomUUID();
  const total = Math.round(base.valor * 100);
  const parte = dividir ? Math.floor(total / vezes) : total;
  return Array.from({ length: vezes }, (_, i) => ({
    ...base,
    descricao: `${base.descricao} (${i + 1}/${vezes})`,
    valor: (dividir && i === vezes - 1 ? total - parte * (vezes - 1) : parte) / 100,
    vencimento: somarMeses(base.vencimento, i),
    pago_em: i === 0 ? base.pago_em : null,
    parcela: i + 1, total_parcelas: vezes, grupo,
  }));
}

// cria, atualiza ou cancela o lembrete do vencimento na agenda; devolve um aviso ou null
async function sincronizarVencimento(l, lembrar) {
  if (l.natureza === "transferencia") return null;
  if (!l.compromisso_id && (!lembrar || l.pago_em)) return null;
  const situacao = l.pago_em ? "cumprido" : lembrar ? "pendente" : "cancelado";
  const atual = estado.compromissos.find((c) => c.id === l.compromisso_id);
  if (atual && atual.situacao === situacao && situacao === "cancelado") return null;
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
  if (!l.compromisso_id) await gravarLancamento(l.id, { compromisso_id: salvo.id }).catch(() => null);
  return salvo.google_erro ? `Google Agenda: ${salvo.google_erro}` : null;
}

function excluirLancamento(l) {
  if (!confirm(`Excluir “${l.descricao}” (${moeda(l.valor)})? Esta ação não pode ser desfeita.`)) return;
  return executar(async () => {
    if (l.compromisso_id) await sincronizarVencimento({ ...l, pago_em: null }, false);
    const reserva = fin.lancamentos.find((x) => x.origem_id === l.id);
    await apagarLancamento(l.id); // a reserva ligada sai junto
    if (reserva?.pago_em) await atualizarResgate(reserva.pago_em.slice(0, 7));
    return null;
  }, "Lançamento excluído.");
}

function abrirPagamento(l, parcial = false) {
  const reg = registroDe(l);
  const verbo = l.natureza === "receita" ? "recebida" : l.natureza === "despesa" ? "paga" : "realizada";
  const termo = l.natureza === "receita" ? "Recebimento" : "Pagamento";
  const podeParcial = l.natureza !== "transferencia" && !registroDoRepasse(l);
  abrirDialogo({
    titulo: `Marcar como ${verbo}`,
    ok: "Confirmar",
    salvar: () => {
      const pago_em = $("fp-data").value;
      const valor = lerValor($("fp-valor").value);
      if (!pago_em || !(valor > 0)) { avisar("Informe a data e o valor."); return; }
      if (podeParcial && $("fp-parcial").checked) {
        if (valor >= Number(l.valor)) { avisar(`No ${termo.toLowerCase()} parcial, o valor tem de ser menor que ${moeda(l.valor)}.`); return; }
        const vencSaldo = $("fp-venc-saldo").value;
        if (!vencSaldo) { avisar("Informe o vencimento do saldo."); return; }
        const dados = { pago_em, valor, conta_id: $("fp-conta").value || null, vencSaldo };
        return executar(() => (reg ? registrarParcialRecebimento(reg, l, dados) : registrarParcial(l, dados)),
          `${termo} parcial registrado. Saldo de ${moeda(centavos(l.valor - valor))} continua em aberto.`);
      }
      return executar(async () => {
        if (reg) {
          // alvará ou acordo: o registro manda nos lançamentos ligados a ele
          const mudanca = registroDoTotal(l)
            ? { data_levantamento: pago_em, conta_id: $("fp-conta").value || reg.conta_id }
            : { repassado_em: pago_em };
          return (await gravarRecebimento({ ...reg, ...mudanca })).aviso;
        }
        const mudancas = { pago_em };
        if (l.natureza !== "transferencia") mudancas.conta_id = $("fp-conta").value || null;
        if (valor !== Number(l.valor)) mudancas.valor = valor;
        const salvo = await gravarLancamento(l.id, mudancas);
        const aviso = salvo.compromisso_id ? await sincronizarVencimento(salvo, true) : null;
        await atualizarReserva(salvo);
        return aviso;
      }, l.natureza === "receita" ? "Recebimento registrado." : l.natureza === "despesa" ? "Pagamento registrado." : "Transferência registrada.");
    },
    corpo: `
      <p><strong>${esc(l.descricao)}</strong><br><span class="at-sub">Vencimento ${dataBR(l.vencimento)}${l.natureza === "transferencia" ? ` · ${esc(nomeConta(l.conta_id))} → ${esc(nomeConta(l.conta_destino_id))}` : ""}</span></p>
      <div class="linha3">
        <label>${l.natureza === "receita" ? "Recebido em" : l.natureza === "despesa" ? "Pago em" : "Realizada em"}<input type="date" id="fp-data" value="${hoje()}"></label>
        <label><span id="fp-valor-rotulo">Valor (R$)</span><input id="fp-valor" inputmode="decimal" value="${esc(valorCampo(l.valor))}" ${reg ? "disabled" : ""}></label>
        ${l.natureza === "transferencia" ? "<span></span>" : `<label>Conta<select id="fp-conta">${opcoesContas(l.conta_id || contaPadrao())}</select></label>`}
      </div>
      ${baseImposto({ ...l, pago_em: hoje() }) > 0 && contaPoupanca() ? `<p class="at-sub">${percentualCampo(fin.config?.percentual_imposto)}% da parte do escritório irá para a poupança como reserva de imposto.</p>` : ""}
      ${podeParcial ? `
        <label class="check"><input type="checkbox" id="fp-parcial" ${parcial ? "checked" : ""}> ${termo} parcial — o restante continua em aberto</label>
        <div id="fp-resto" ${parcial ? "" : "hidden"}>
          <div class="linha2"><label>Vencimento do saldo<input type="date" id="fp-venc-saldo" value="${esc(l.vencimento < hoje() ? hoje() : l.vencimento)}"></label><span></span></div>
          <p class="previa" id="fp-previa"></p>
        </div>` : ""}
      ${l.compromisso_id ? '<p class="at-sub">O lembrete na agenda será marcado como cumprido.</p>' : ""}`,
  });
  if (podeParcial) {
    fin.pagamento = l;
    atualizarPreviaPagamento();
  }
}

function atualizarPreviaPagamento() {
  const l = fin.pagamento;
  if (!l || !$("fp-parcial")) return;
  const parcial = $("fp-parcial").checked;
  $("fp-resto").hidden = !parcial;
  $("fp-valor-rotulo").textContent = parcial ? `Valor ${l.natureza === "receita" ? "recebido" : "pago"} agora (R$)` : "Valor (R$)";
  if (registroDoTotal(l)) { // alvará/acordo: o valor só muda no parcial
    $("fp-valor").disabled = !parcial;
    if (!parcial) $("fp-valor").value = valorCampo(l.valor);
  }
  const valor = lerValor($("fp-valor").value) || 0;
  const resto = centavos(Number(l.valor) - valor);
  $("fp-previa").innerHTML = parcial
    ? (resto > 0 ? `Fica em aberto: <strong>${moeda(resto)}</strong> (de ${moeda(l.valor)})` +
      (registroDoTotal(l) ? ". Honorários e repasse ao cliente se dividem na mesma proporção." : "")
      : `<span class="atrasado">O valor tem de ser menor que ${moeda(l.valor)}.</span>`)
    : "";
}

// o lançamento fica com o valor pago; o restante vira um novo lançamento em aberto, ligado ao original
async function registrarParcial(l, { pago_em, valor, conta_id, vencSaldo }) {
  const restante = centavos(Number(l.valor) - valor);
  const lembrava = compromissoAtivo(l);
  const pago = await gravarLancamento(l.id, { pago_em, valor, conta_id });
  const campos = ["natureza", "categoria_id", "conta_id", "cliente_id", "cliente_nome", "processo", "atendimento_id",
    "contrato_id", "parcela", "total_parcelas", "grupo", "reembolsavel", "observacoes"];
  const copia = Object.fromEntries(campos.map((c) => [c, l[c] ?? null]));
  const saldo = await gravarLancamento(null, {
    ...copia, descricao: `${l.descricao.replace(/ \(saldo\)$/, "")} (saldo)`, valor: restante,
    vencimento: vencSaldo, pago_em: null, restante_de: l.id,
  });
  let aviso = null;
  if (pago.compromisso_id) aviso = await sincronizarVencimento(pago, true);
  if (lembrava) aviso = (await sincronizarVencimento(saldo, true)) || aviso;
  await atualizarReserva(pago);
  return aviso;
}

// ------------------------------------------------------------- transferências entre contas

function abrirTransferencia(l, base = {}) {
  const novo = !l?.id;
  const poup = contaPoupanca();
  const d = novo ? {
    natureza: "transferencia", vencimento: hoje(), pago_em: hoje(), conta_id: contaPadrao(), conta_destino_id: poup?.id || null,
    categoria_id: categoriaPorNome("Aplicação na poupança", "transferencia")?.id, ...base,
  } : l;
  const origem = !novo && d.origem_id && fin.lancamentos.find((x) => x.id === d.origem_id);
  abrirDialogo({
    titulo: novo ? "Nova transferência entre contas" : "Editar transferência",
    somenteLeitura: !pode("financeiro", 2),
    excluir: !novo && !origem && (pode("financeiro", 3) || (pode("financeiro", 2) && !d.pago_em)) ? () => excluirLancamento(d) : null,
    salvar: () => salvarTransferencia(l, d),
    corpo: `
      <label>Tipo<select id="ft-categoria">${opcoesCategorias("transferencia", d.categoria_id)}</select></label>
      <label>Descrição<input id="ft-descricao" maxlength="200" value="${esc(d.descricao || "")}" placeholder="Ex.: Aplicação na poupança"></label>
      <div class="linha2">
        <label>Sai da conta<select id="ft-origem">${opcoesContas(d.conta_id)}</select></label>
        <label>Entra na conta<select id="ft-destino">${opcoesContas(d.conta_destino_id)}</select></label>
      </div>
      <div class="linha3">
        <label>Valor (R$)<input id="ft-valor" inputmode="decimal" value="${esc(valorCampo(d.valor))}" placeholder="0,00"></label>
        <label>Data prevista<input type="date" id="ft-vencimento" value="${esc(d.vencimento || "")}"></label>
        <label>Realizada em<input type="date" id="ft-pago" value="${esc(d.pago_em || "")}"></label>
      </div>
      <p class="at-sub">Transferências mudam o saldo das contas, mas não entram em receitas, despesas nem no resultado. Deixe “realizada em” vazio para programar.</p>
      <label>Observações<textarea id="ft-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${origem ? `<div class="vinculo">Reserva automática de imposto da receita <a href="#financeiro/lancamento/${esc(origem.id)}">${esc(origem.descricao)}</a>. Se a receita mudar, esta reserva é recalculada.</div>` : ""}
      ${d.referencia ? '<div class="vinculo">Resgate automático: soma das reservas de imposto do mês. O valor é recalculado enquanto não for realizado.</div>' : ""}
      ${rodapeAutoria(l)}`,
  });
}

function salvarTransferencia(l, d) {
  const valor = lerValor($("ft-valor").value);
  const vencimento = $("ft-vencimento").value;
  const de = $("ft-origem").value, para = $("ft-destino").value;
  if (!(valor > 0) || !vencimento || !de || !para) { avisar("Preencha contas, valor e data."); return; }
  if (de === para) { avisar("Escolha contas diferentes."); return; }
  const cat = $("ft-categoria").value || null;
  const dados = {
    natureza: "transferencia", valor, vencimento, pago_em: $("ft-pago").value || null,
    conta_id: de, conta_destino_id: para, categoria_id: cat,
    descricao: $("ft-descricao").value.trim() || categoria(cat)?.nome || "Transferência entre contas",
    observacoes: $("ft-obs").value.trim() || null,
  };
  return executar(async () => {
    const salvo = await gravarLancamento(l?.id, dados);
    // resgate do imposto realizado: as reservas do mês deixam de alterar o valor dele
    if (salvo.origem_id && salvo.pago_em) await atualizarResgate(salvo.pago_em.slice(0, 7));
    return null;
  }, "Transferência salva.");
}

// ------------------------------------------------------------- contratos de honorários

function atendimentosFechados(atual) {
  return at.lista.filter((a) => ["aguardando_distribuicao", "distribuida"].includes(a.situacao) || a.id === atual)
    .map((a) => [a.id, `${dataBR(a.data_atendimento)} · ${tituloAtendimento(a)}`]);
}

function linhaParcela(p, i) {
  const pago = !!p.pago_em;
  return `<tr data-id="${esc(p.id || "")}" ${pago ? 'data-pago="1"' : ""}>
    <td class="num">${i + 1}</td>
    <td><input type="date" class="pc-venc" value="${esc(p.vencimento || "")}" ${pago ? "disabled" : ""} aria-label="Vencimento"></td>
    <td><input class="pc-valor" inputmode="decimal" value="${esc(valorCampo(p.valor))}" ${pago ? "disabled" : ""} aria-label="Valor"></td>
    <td>${pago ? `<span class="selo-at distribuida">recebida ${dataBR(p.pago_em).slice(0, 5)}</span>` : p.id ? (emAtraso(p) ? '<span class="selo-at atrasado">em atraso</span>' : '<span class="selo-at">a vencer</span>') : '<span class="selo-at">nova</span>'}</td>
    <td>${pago ? (p.id ? `<a href="#financeiro/lancamento/${esc(p.id)}">abrir</a>` : "") : '<button type="button" class="botao-sec mini" data-remover-parcela>Remover</button>'}</td>
  </tr>`;
}

function tabelaParcelas(parcelas) {
  return `
  <table class="fin mini parcelas"><thead><tr><th class="num">#</th><th>Vencimento</th><th>Valor (R$)</th><th></th><th></th></tr></thead>
    <tbody id="pc-corpo">${parcelas.map(linhaParcela).join("")}</tbody></table>
  <div class="acoes-dlg"><button type="button" class="botao-sec mini" data-mais-parcela>+ Parcela</button>
    <span class="at-sub" id="pc-total"></span></div>`;
}

function lerParcelas() {
  return [...document.querySelectorAll("#pc-corpo tr")].map((tr) => ({
    id: tr.dataset.id || null, pago: !!tr.dataset.pago,
    vencimento: tr.querySelector(".pc-venc").value, valor: lerValor(tr.querySelector(".pc-valor").value),
  }));
}

function atualizarTotalParcelas() {
  if (!$("pc-total")) return;
  const ps = lerParcelas();
  ps.forEach((_, i) => { document.querySelectorAll("#pc-corpo tr")[i].firstElementChild.textContent = i + 1; });
  const total = soma(ps.filter((p) => p.valor > 0));
  const alvo = $("fc-valor") ? lerValor($("fc-valor").value) : NaN;
  const dif = alvo > 0 ? centavos(alvo - total) : 0;
  $("pc-total").innerHTML = `${ps.length} parcela(s) · total ${moeda(total)}` +
    (dif ? ` <span class="atrasado">(${dif > 0 ? "faltam" : "sobram"} ${moeda(Math.abs(dif))} para o valor do contrato)</span>` : "");
}

// gera a tabela a partir de valor, número de parcelas e 1º vencimento (só antes de mexer na tabela)
function gerarParcelasContrato(forcar = false) {
  const corpo = $("pc-corpo");
  if (!corpo || (corpo.dataset.manual && !forcar)) return atualizarTotalParcelas();
  const tipo = escolhido("fc-tipo");
  const valor = lerValor($("fc-valor")?.value), venc = $("fc-vencimento")?.value;
  const pagas = lerParcelas().filter((p) => p.pago);
  let novas = [];
  if (tipo === "mensal") {
    if (valor > 0 && venc) novas = Array.from({ length: MESES_MENSAL }, (_, i) => ({ vencimento: somarMeses(venc, i), valor }));
  } else {
    const n = Math.max(1, Math.min(120, Number($("fc-parcelas").value) || 1));
    const restante = centavos(valor - soma(pagas));
    if (restante > 0 && venc) novas = montarParcelas({ valor: restante, vencimento: venc, descricao: "" }, n - pagas.length || 1, true);
  }
  const existentes = [...corpo.querySelectorAll("tr")].filter((tr) => !tr.dataset.pago).map((tr) => tr.dataset.id).filter(Boolean);
  corpo.innerHTML = [...pagas, ...novas.map((p, i) => ({ ...p, id: existentes[i] || null }))].map((p, i) => linhaParcela(
    p.pago ? fin.lancamentos.find((l) => l.id === p.id) : p, i)).join("");
  delete corpo.dataset.manual;
  atualizarTotalParcelas();
}

function abrirContrato(c, atendimento) {
  const novo = !c;
  const d = c || {
    tipo: "fixo", parcelas: 1, situacao: "ativo",
    cliente_nome: atendimento?.cliente_nome || "", cliente_id: atendimento?.cliente_id || null,
    atendimento_id: atendimento?.id || null, processo: atendimento?.processo || "",
  };
  const r = novo ? null : resumoContrato(c);
  const parcelas = novo ? [] : [...r.lancs].filter((l) => l.parcela || c.tipo === "mensal").sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  const outros = novo ? [] : r.lancs.filter((l) => !parcelas.includes(l));
  const temParcelas = d.tipo !== "exito";
  const primeiro = parcelas.find((p) => !p.pago_em)?.vencimento || parcelas[0]?.vencimento || hoje();
  abrirDialogo({
    titulo: novo ? "Novo contrato de honorários" : `Editar contrato · ${d.cliente_nome}`,
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
      ${escolhas("fc-tipo", Object.entries(TIPOS_CONTRATO), d.tipo)}
      <div id="fc-fixo" ${temParcelas ? "" : "hidden"}>
        <div class="linha3">
          <label><span id="fc-valor-rotulo">${d.tipo === "mensal" ? "Valor mensal (R$)" : "Valor total (R$)"}</span><input id="fc-valor" inputmode="decimal" value="${esc(valorCampo(d.valor_fixo))}" placeholder="0,00"></label>
          <label id="fc-parcelas-l" ${d.tipo === "mensal" ? "hidden" : ""}>Parcelas<input type="number" id="fc-parcelas" min="1" max="120" value="${esc(String(d.parcelas || 1))}"></label>
          <label>${novo ? "1º vencimento" : "Próximo vencimento"}<input type="date" id="fc-vencimento" value="${esc(primeiro)}"></label>
        </div>
        <div class="linha2">
          <label>Conta para receber<select id="fc-conta">${opcoesContas(parcelas[0]?.conta_id || contaPadrao())}</select></label>
          ${novo ? '<label class="check fc-agenda"><input type="checkbox" id="fc-agenda"> Lembrar cada parcela na Agenda</label>' : "<span></span>"}
        </div>
        <p class="at-sub" id="fc-ajuda">${d.tipo === "mensal"
          ? `Sem data de término: o sistema mantém sempre ${MESES_MENSAL} meses lançados à frente. Ao encerrar o contrato, as parcelas futuras em aberto são removidas.`
          : "Ajuste data e valor de cada parcela na tabela abaixo, se forem diferentes."}</p>
        <div class="acoes-dlg"><button type="button" class="botao-sec mini" data-gerar-parcelas>${novo ? "Gerar parcelas" : "Refazer parcelas em aberto"}</button></div>
        ${tabelaParcelas(parcelas)}
      </div>
      <div id="fc-exito" ${["exito", "fixo_exito"].includes(d.tipo) ? "" : "hidden"}>
        <label>Percentual de êxito (%)<input id="fc-percentual" inputmode="decimal" value="${esc(percentualCampo(d.percentual_exito))}" placeholder="30"></label>
      </div>
      ${novo ? "" : `<label>Situação<select id="fc-situacao">${opcoes(Object.entries(SITUACOES_CONTRATO), d.situacao)}</select></label>`}
      <label>Observações<textarea id="fc-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${novo ? "" : `
        <div class="bloco-dlg">
          <span class="rotulo">Recebido neste contrato: <strong>${moeda(r.recebido)}</strong></span>
          ${outros.length ? `<table class="fin mini"><tbody>${outros.sort((a, b) => a.vencimento.localeCompare(b.vencimento)).map((l) => `
            <tr><td>${dataBR(l.vencimento)}</td><td><a href="#financeiro/lancamento/${esc(l.id)}">${esc(l.descricao)}</a></td>
            <td class="num valor">${moeda(l.valor)}</td><td>${seloSituacao(l)}</td></tr>`).join("")}</tbody></table>` : ""}
          ${pode("financeiro", 2) ? `<div class="acoes-dlg">
            ${["exito", "fixo_exito"].includes(d.tipo) ? `<button type="button" class="botao-sec mini" data-exito="${esc(c.id)}">+ Recebimento de êxito</button>
            <button type="button" class="botao-sec mini" data-recebimento-contrato="${esc(c.id)}">+ Alvará ou acordo deste contrato</button>` : ""}
          </div>` : ""}
        </div>`}
      ${rodapeAutoria(c)}`,
  });
  if (novo) gerarParcelasContrato(true);
  else { $("pc-corpo").dataset.manual = "1"; atualizarTotalParcelas(); } // só refaz as parcelas pelo botão
}

function salvarContrato(c, d) {
  const novo = !c;
  const clienteNome = $("fc-cliente").value.trim();
  if (!clienteNome) { avisar("Informe o cliente."); return; }
  const cliente = clientePorNome(clienteNome);
  const tipo = escolhido("fc-tipo");
  const comExito = ["exito", "fixo_exito"].includes(tipo);
  const percentual = comExito ? lerValor($("fc-percentual").value) : null;
  if (comExito && !(percentual > 0 && percentual <= 100)) { avisar("Informe o percentual de êxito."); return; }
  const situacao = novo ? "ativo" : $("fc-situacao").value;
  const parcelas = tipo === "exito" ? [] : lerParcelas();
  const valorFixo = lerValor($("fc-valor").value);
  if (tipo !== "exito") {
    if (!(valorFixo > 0)) { avisar(tipo === "mensal" ? "Informe o valor mensal." : "Informe o valor total."); return; }
    if (!parcelas.length) { avisar("Gere as parcelas (botão “Gerar parcelas”)."); return; }
    if (parcelas.some((p) => !p.pago && (!p.vencimento || !(p.valor > 0)))) { avisar("Toda parcela precisa de data e valor."); return; }
  }
  const dados = {
    cliente_nome: clienteNome,
    cliente_id: cliente?.id ?? (clienteNome === d.cliente_nome ? d.cliente_id : null),
    processo: $("fc-processo").value.trim() || null,
    atendimento_id: $("fc-atendimento").value || null,
    tipo, situacao,
    percentual_exito: percentual,
    valor_fixo: tipo === "exito" ? null : valorFixo,
    parcelas: tipo === "exito" || tipo === "mensal" ? null : parcelas.length,
    dia_vencimento: tipo === "mensal" ? Number(($("fc-vencimento").value || hoje()).slice(8)) : null,
    inicio: tipo === "mensal" ? (parcelas[0]?.vencimento || $("fc-vencimento").value) : null,
    observacoes: $("fc-obs").value.trim() || null,
  };
  const contaId = $("fc-conta").value || null;
  const lembrar = novo && $("fc-agenda")?.checked;
  return executar(async () => {
    const q = novo ? sb.from("fin_contratos").insert(dados) : sb.from("fin_contratos").update(dados).eq("id", c.id);
    const { data: salvo, error } = await q.select().single();
    if (error) throw new Error(mensagemErro(error));
    guardar(fin.contratos, salvo);
    let aviso = null;
    if (tipo !== "exito") aviso = await sincronizarParcelas(salvo, parcelas, contaId, lembrar);
    if (!novo && situacao !== "ativo") aviso = (await removerParcelasFuturas(salvo)) || aviso;
    return aviso;
  }, novo ? "Contrato salvo." : "Contrato atualizado.");
}

function descricaoParcela(c, p, i, n) {
  return c.tipo === "mensal"
    ? `Contrato fixo — ${c.cliente_nome} — ${mesBR(p.vencimento.slice(0, 7))}`
    : `Honorários — ${c.cliente_nome} (${i + 1}/${n})`;
}

// grava a tabela de parcelas: altera as existentes, cria as novas e remove as que saíram (só em aberto)
async function sincronizarParcelas(c, lista, contaId, lembrar) {
  const parcelas = [...lista].sort((a, b) => a.vencimento.localeCompare(b.vencimento)); // numeração segue as datas
  const atuais = fin.lancamentos.filter((l) => l.contrato_id === c.id && l.natureza === "receita" && (l.parcela || c.tipo === "mensal"));
  const cat = categoriaPorNome(c.tipo === "mensal" ? "Contrato Fixo" : "Contrato Parcelas", "receita")?.id || null;
  let aviso = null;
  // primeiro sai o que foi removido da tabela (só parcelas em aberto)
  const mantidas = new Set(parcelas.map((p) => p.id).filter(Boolean));
  for (const l of atuais.filter((x) => !mantidas.has(x.id) && !x.pago_em)) {
    if (l.compromisso_id) await sincronizarVencimento(l, false);
    await apagarLancamento(l.id);
  }
  // numeração: o saldo de um pagamento parcial fica com o mesmo número da parcela de origem
  const numeros = [];
  let k = 0;
  for (const p of parcelas) {
    const lanc = p.id && fin.lancamentos.find((l) => l.id === p.id);
    const origem = lanc?.restante_de ? parcelas.findIndex((x) => x.id === lanc.restante_de) : -1;
    numeros.push(origem >= 0 && numeros[origem] ? numeros[origem] : ++k);
  }
  const n = k;
  for (const [idx, p] of parcelas.entries()) {
    const i = numeros[idx] - 1;
    const existente = p.id && atuais.find((l) => l.id === p.id);
    const totalParcelas = c.tipo === "mensal" ? null : n;
    if (existente?.pago_em) {
      if (existente.parcela !== i + 1 || existente.total_parcelas !== totalParcelas) await gravarLancamento(existente.id, { parcela: i + 1, total_parcelas: totalParcelas });
      continue;
    }
    const dados = {
      natureza: "receita", descricao: descricaoParcela(c, p, i, n) + (existente?.restante_de ? " (saldo)" : ""), valor: p.valor, vencimento: p.vencimento,
      categoria_id: existente?.categoria_id || cat, conta_id: contaId || existente?.conta_id || null,
      cliente_nome: c.cliente_nome, cliente_id: c.cliente_id, processo: c.processo, atendimento_id: c.atendimento_id,
      contrato_id: c.id, parcela: i + 1, total_parcelas: totalParcelas,
    };
    const salvo = await gravarLancamento(existente?.id, dados);
    if (lembrar || salvo.compromisso_id) aviso = (await sincronizarVencimento(salvo, lembrar || compromissoAtivo(salvo))) || aviso;
  }
  return aviso;
}

// contrato encerrado ou cancelado: parcelas futuras em aberto deixam de existir
async function removerParcelasFuturas(c) {
  const futuras = fin.lancamentos.filter((l) => l.contrato_id === c.id && !l.pago_em && l.vencimento > hoje());
  for (const l of futuras) {
    if (l.compromisso_id) await sincronizarVencimento(l, false);
    await apagarLancamento(l.id);
  }
  return futuras.length ? `${futuras.length} parcela(s) futura(s) removida(s)` : null;
}

// mantém os contratos fixos mensais sempre com 12 meses lançados à frente
async function estenderMensais() {
  let criadas = 0;
  const limite = somarMeses(hoje(), MESES_MENSAL - 1);
  for (const c of fin.contratos.filter((x) => x.tipo === "mensal" && x.situacao === "ativo" && x.valor_fixo > 0)) {
    const lancs = fin.lancamentos.filter((l) => l.contrato_id === c.id).sort((a, b) => a.vencimento.localeCompare(b.vencimento));
    const ultima = lancs[lancs.length - 1];
    if (!ultima) continue;
    let venc = somarMeses(ultima.vencimento, 1, c.dia_vencimento);
    while (venc <= limite) {
      const referencia = `mensal-${c.id}-${venc.slice(0, 7)}`;
      const existe = fin.lancamentos.some((l) => l.referencia === referencia ||
        (l.contrato_id === c.id && l.vencimento.slice(0, 7) === venc.slice(0, 7)));
      if (!existe) {
        try {
          await gravarLancamento(null, {
            natureza: "receita", descricao: descricaoParcela(c, { vencimento: venc }), valor: c.valor_fixo, vencimento: venc,
            categoria_id: ultima.categoria_id, conta_id: ultima.conta_id, cliente_nome: c.cliente_nome, cliente_id: c.cliente_id,
            processo: c.processo, atendimento_id: c.atendimento_id, contrato_id: c.id,
            parcela: (ultima.parcela || lancs.length) + criadas + 1, total_parcelas: null, referencia,
          });
          criadas++;
        } catch { return criadas; } // outra pessoa criou ao mesmo tempo: fica para a próxima carga
      }
      venc = somarMeses(venc, 1, c.dia_vencimento);
    }
  }
  return criadas;
}

function excluirContrato(c) {
  const r = resumoContrato(c);
  if (r.lancs.some((l) => l.pago_em)) {
    avisar("Este contrato já tem valores recebidos. Em vez de excluir, mude a situação para “Encerrado” ou “Cancelado”.", 6000);
    return;
  }
  if (!confirm(`Excluir o contrato de ${c.cliente_nome} e ${r.lancs.length} parcela(s) a receber? Esta ação não pode ser desfeita.`)) return;
  return executar(async () => {
    for (const l of r.lancs) {
      if (l.compromisso_id) await sincronizarVencimento(l, false);
      await apagarLancamento(l.id);
    }
    const { error } = await sb.from("fin_contratos").delete().eq("id", c.id);
    if (error) throw new Error(mensagemErro(error));
    retirar("contratos", c.id);
    return null;
  }, "Contrato excluído.");
}

function baseDoContrato(c, extra) {
  return {
    natureza: "receita", contrato_id: c.id, cliente_nome: c.cliente_nome, cliente_id: c.cliente_id,
    processo: c.processo, atendimento_id: c.atendimento_id, conta_id: contaPadrao(), ...extra,
  };
}

// ------------------------------------------------------------- alvarás e acordos (valor total com repasse)

function abrirRecebimento(a, base = {}) {
  const novo = !a?.id;
  const d = novo ? { origem: "alvara", conta_id: contaPadrao(), descontos: 0, ...base } : a;
  const contratos = fin.contratos.map((c) => [c.id, `${c.cliente_nome}${c.processo ? ` · ${c.processo}` : ""}${c.percentual_exito != null ? ` · ${percentualCampo(c.percentual_exito)}%` : ""}`]);
  const irmas = !novo && a.grupo ? fin.alvaras.filter((x) => x.grupo === a.grupo && x.id !== a.id).sort((x, y) => x.parcela - y.parcela) : [];
  const pct = d.percentual ?? (d.valor_levantado ? centavos((100 * d.honorarios) / d.valor_levantado) : null);
  abrirDialogo({
    titulo: novo ? "Novo alvará ou acordo" : `Editar ${ORIGENS[d.origem].toLowerCase()}${d.total_parcelas > 1 ? ` (parcela ${d.parcela}/${d.total_parcelas})` : ""} · ${d.cliente_nome}`,
    somenteLeitura: !pode("financeiro", 2),
    excluir: !novo && (pode("financeiro", 3) || (pode("financeiro", 2) && !d.data_levantamento)) ? () => excluirRecebimento(a) : null,
    salvar: () => salvarRecebimento(a, d),
    extras: !novo && !d.data_levantamento && d.lancamento_id && pode("financeiro", 2)
      ? `<button type="button" class="botao-sec" data-parcial="${esc(d.lancamento_id)}">Recebimento parcial</button>
         <button type="button" class="botao-sec" data-pagar-dlg="${esc(d.lancamento_id)}">Marcar recebida</button>` : "",
    corpo: `
      ${escolhas("fa-origem", Object.entries(ORIGENS), d.origem, !novo)}
      <label>Contrato de honorários (opcional)<select id="fa-contrato">${opcoes(contratos, d.contrato_id, "—")}</select></label>
      <div class="linha2">
        <label>Cliente<input id="fa-cliente" list="fin-clientes" required maxlength="200" value="${esc(d.cliente_nome || "")}"></label>
        <label>Processo<input id="fa-processo" maxlength="60" value="${esc(d.processo || "")}"></label>
      </div>
      <div class="linha3">
        <label><span id="fa-valor-rotulo">${novo && d.origem === "acordo" ? "Valor total do acordo (R$)" : "Valor total (R$)"}</span><input id="fa-levantado" inputmode="decimal" required value="${esc(valorCampo(d.valor_levantado))}"></label>
        <label>Honorários do escritório (%)<input id="fa-percentual" inputmode="decimal" value="${esc(percentualCampo(pct))}" placeholder="30"></label>
        <label>Honorários do escritório (R$)<input id="fa-honorarios" inputmode="decimal" value="${esc(valorCampo(d.honorarios))}"></label>
      </div>
      <div class="linha2">
        <label>Custas reembolsadas ao escritório (R$)<input id="fa-descontos" inputmode="decimal" value="${esc(valorCampo(d.descontos))}"></label>
        <label>Conta que recebe<select id="fa-conta">${opcoesContas(d.conta_id)}</select></label>
      </div>
      <div id="fa-acordo" ${novo && d.origem === "acordo" ? "" : "hidden"}>
        <div class="linha2">
          <label>Número de parcelas<input type="number" id="fa-parcelas" min="1" max="120" value="1"></label>
          <label>1º vencimento<input type="date" id="fa-primeiro" value="${hoje()}"></label>
        </div>
        <p class="at-sub" id="fa-previa-acordo"></p>
      </div>
      <div id="fa-datas" ${novo && d.origem === "acordo" ? "hidden" : ""}>
        <div class="linha3">
          <label>${d.origem === "acordo" ? "Vencimento" : "Data prevista"}<input type="date" id="fa-vencimento" value="${esc(d.vencimento || d.data_levantamento || hoje())}"></label>
          <label>Recebido em<input type="date" id="fa-data" value="${esc(novo ? (d.origem === "alvara" ? hoje() : "") : d.data_levantamento || "")}"></label>
          <label>Repassado ao cliente em<input type="date" id="fa-repassado" value="${esc(d.repassado_em || "")}"></label>
        </div>
      </div>
      <p class="previa" id="fa-previa"></p>
      <label>Observações<textarea id="fa-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      <p class="at-sub">Gera a receita do valor total (só a parte do escritório entra no resultado e na reserva de imposto) e o repasse ao cliente como conta a pagar.</p>
      ${irmas.length ? `<div class="bloco-dlg"><span class="rotulo">Outras parcelas deste acordo</span>
        <table class="fin mini"><tbody>${irmas.map((x) => `<tr><td>${x.parcela}/${x.total_parcelas}</td><td>${dataBR(x.vencimento)}</td>
          <td class="num valor">${moeda(x.valor_levantado)}</td><td>${x.data_levantamento ? '<span class="selo-at distribuida">recebida</span>' : x.vencimento < hoje() ? '<span class="selo-at atrasado">em atraso</span>' : '<span class="selo-at">a receber</span>'}</td>
          <td><a href="#financeiro/alvara/${esc(x.id)}">abrir</a></td></tr>`).join("")}</tbody></table></div>` : ""}
      ${rodapeAutoria(a)}`,
  });
  atualizarPreviaRecebimento();
}

function atualizarPreviaRecebimento(origemCampo) {
  if (!$("fa-previa")) return;
  const total = lerValor($("fa-levantado").value) || 0;
  if (origemCampo === "fa-percentual" || (origemCampo === "fa-levantado" && $("fa-percentual").value)) {
    const pct = lerValor($("fa-percentual").value);
    if (pct >= 0) $("fa-honorarios").value = valorCampo(centavos((total * pct) / 100));
  } else if (origemCampo === "fa-honorarios" && total > 0) {
    $("fa-percentual").value = percentualCampo(centavos((100 * (lerValor($("fa-honorarios").value) || 0)) / total));
  }
  const honorarios = lerValor($("fa-honorarios").value) || 0;
  const descontos = lerValor($("fa-descontos").value) || 0;
  const repasse = centavos(total - honorarios - descontos);
  $("fa-previa").innerHTML = total
    ? `Escritório: <strong>${moeda(honorarios + descontos)}</strong> · repasse ao cliente: <strong class="${repasse < 0 ? "atrasado" : ""}">${moeda(repasse)}</strong>` : "";
  if (!$("fa-acordo").hidden) {
    const n = Math.max(1, Number($("fa-parcelas").value) || 1);
    const p = montarParcelas({ valor: total, vencimento: $("fa-primeiro").value || hoje(), descricao: "" }, n, true);
    $("fa-previa-acordo").textContent = total ? `${n} parcela(s) de ${moeda(p[0].valor)}, de ${dataBR(p[0].vencimento)} a ${dataBR(p[n - 1].vencimento)}. Cada parcela separa honorários e repasse na mesma proporção; ajuste qualquer uma depois, abrindo-a.` : "";
  }
}

function salvarRecebimento(a, d) {
  const novo = !a?.id;
  const origem = escolhido("fa-origem") || d.origem;
  const clienteNome = $("fa-cliente").value.trim();
  const total = lerValor($("fa-levantado").value);
  const honorarios = lerValor($("fa-honorarios").value) || 0;
  const descontos = lerValor($("fa-descontos").value) || 0;
  if (!clienteNome || !(total > 0)) { avisar("Preencha cliente e valor total."); return; }
  if (honorarios + descontos > total) { avisar("Honorários e custas não podem passar do valor total."); return; }
  const cliente = clientePorNome(clienteNome);
  const pct = lerValor($("fa-percentual").value);
  const comum = {
    origem, cliente_nome: clienteNome,
    cliente_id: cliente?.id ?? (clienteNome === d.cliente_nome ? d.cliente_id : null),
    processo: $("fa-processo").value.trim() || null,
    contrato_id: $("fa-contrato").value || null,
    conta_id: $("fa-conta").value || null,
    percentual: Number.isFinite(pct) ? pct : null,
    observacoes: $("fa-obs").value.trim() || null,
  };
  let registros;
  if (novo && origem === "acordo") {
    const n = Math.max(1, Math.min(120, Number($("fa-parcelas").value) || 1));
    const primeiro = $("fa-primeiro").value;
    if (!primeiro) { avisar("Informe o 1º vencimento."); return; }
    const valores = montarParcelas({ valor: total, vencimento: primeiro, descricao: "" }, n, true);
    const hon = montarParcelas({ valor: honorarios, vencimento: primeiro, descricao: "" }, n, true);
    const grupo = n > 1 ? crypto.randomUUID() : null;
    registros = valores.map((p, i) => ({
      ...comum, valor_levantado: p.valor, honorarios: hon[i].valor, descontos: i === 0 ? descontos : 0,
      vencimento: p.vencimento, data_levantamento: null, repassado_em: null,
      parcela: n > 1 ? i + 1 : null, total_parcelas: n > 1 ? n : null, grupo,
    }));
  } else {
    const recebido = $("fa-data").value || null;
    registros = [{
      ...(novo ? {} : a), ...comum, valor_levantado: total, honorarios, descontos,
      vencimento: $("fa-vencimento").value || recebido || hoje(), data_levantamento: recebido,
      repassado_em: $("fa-repassado").value || null,
    }];
  }
  return executar(async () => {
    let aviso = null;
    for (const r of registros) aviso = (await gravarRecebimento(r)).aviso || aviso;
    return aviso;
  }, registros.length > 1 ? `Acordo salvo com ${registros.length} parcelas.` : "Salvo.");
}

// grava o alvará/parcela de acordo e mantém em dia a receita do valor total, o repasse e a reserva de imposto
async function gravarRecebimento(r) {
  const campos = ["origem", "cliente_nome", "cliente_id", "processo", "contrato_id", "conta_id", "percentual", "observacoes",
    "valor_levantado", "honorarios", "descontos", "vencimento", "data_levantamento", "repassado_em", "parcela", "total_parcelas", "grupo"];
  const dados = Object.fromEntries(campos.filter((c) => c in r).map((c) => [c, r[c]]));
  const q = r.id ? sb.from("fin_alvaras").update(dados).eq("id", r.id) : sb.from("fin_alvaras").insert(dados);
  const { data: salvo, error } = await q.select().single();
  if (error) throw new Error(mensagemErro(error));
  guardar(fin.alvaras, salvo);

  const rotulo = salvo.origem === "acordo" ? "Acordo" : "Alvará";
  const saldoDeParcial = !!fin.lancamentos.find((l) => l.id === salvo.lancamento_id)?.restante_de;
  const sufixo = (salvo.total_parcelas > 1 ? ` (${salvo.parcela}/${salvo.total_parcelas})` : "") + (saldoDeParcial ? " (saldo)" : "");
  const proc = salvo.processo ? ` · ${salvo.processo}` : "";
  const comum = { cliente_nome: salvo.cliente_nome, cliente_id: salvo.cliente_id, processo: salvo.processo, conta_id: salvo.conta_id };
  const totalLanc = await gravarLancamento(salvo.lancamento_id, {
    ...comum, natureza: "receita", descricao: `${rotulo} — ${salvo.cliente_nome}${sufixo}${proc}`,
    valor: salvo.valor_levantado, vencimento: salvo.vencimento || salvo.data_levantamento || hoje(), pago_em: salvo.data_levantamento,
    categoria_id: categoriaPorNome(salvo.origem === "acordo" ? "Parcela de Acordo – Valor Total" : "Alvará Judicial – Valor Total", "receita")?.id || null,
    contrato_id: salvo.contrato_id,
  });
  let repasseId = salvo.repasse_lancamento_id;
  let aviso = null;
  // o repasse só vira conta a pagar depois que o dinheiro entrou
  if (Number(salvo.repasse) > 0 && salvo.data_levantamento) {
    const rep = await gravarLancamento(repasseId, {
      ...comum, natureza: "despesa", descricao: `Repasse ao cliente — ${salvo.cliente_nome}${sufixo}${proc}`,
      valor: salvo.repasse, vencimento: salvo.data_levantamento || salvo.vencimento || hoje(), pago_em: salvo.repassado_em,
      categoria_id: categoriaPorNome("Repasse ao Cliente", "despesa")?.id || null,
    });
    repasseId = rep.id;
  } else if (repasseId) {
    try { await apagarLancamento(repasseId); repasseId = null; } catch (e) { aviso = `o repasse antigo continua lançado (${e.message})`; }
  }
  if (salvo.lancamento_id !== totalLanc.id || salvo.repasse_lancamento_id !== repasseId) {
    const { data: ligado } = await sb.from("fin_alvaras").update({ lancamento_id: totalLanc.id, repasse_lancamento_id: repasseId })
      .eq("id", salvo.id).select().single();
    if (ligado) guardar(fin.alvaras, ligado);
  }
  await atualizarReserva(totalLanc);
  return { aviso, registro: fin.alvaras.find((x) => x.id === salvo.id), total: totalLanc };
}

// recebimento parcial de alvará ou parcela de acordo: honorários, custas e repasse se dividem na mesma proporção
async function registrarParcialRecebimento(original, l, { pago_em, valor, conta_id, vencSaldo }) {
  const reg = { ...original }; // valores de antes da gravação
  const total = Number(reg.valor_levantado);
  const honPago = centavos((Number(reg.honorarios) * valor) / total);
  const descPago = Math.min(Number(reg.descontos), centavos(valor - honPago));
  const pago = await gravarRecebimento({
    ...reg, valor_levantado: valor, honorarios: honPago, descontos: descPago,
    data_levantamento: pago_em, conta_id: conta_id || reg.conta_id,
  });
  const saldo = await gravarRecebimento({
    origem: reg.origem, cliente_nome: reg.cliente_nome, cliente_id: reg.cliente_id, processo: reg.processo,
    contrato_id: reg.contrato_id, conta_id: reg.conta_id, percentual: reg.percentual, observacoes: reg.observacoes,
    valor_levantado: centavos(total - valor), honorarios: centavos(Number(reg.honorarios) - honPago),
    descontos: centavos(Number(reg.descontos) - descPago), vencimento: vencSaldo, data_levantamento: null, repassado_em: null,
    parcela: reg.parcela, total_parcelas: reg.total_parcelas, grupo: reg.grupo,
  });
  // liga a receita do saldo à receita recebida e marca a descrição
  await gravarLancamento(saldo.total.id, { restante_de: pago.total.id, descricao: `${saldo.total.descricao} (saldo)` });
  return pago.aviso || saldo.aviso;
}

function excluirRecebimento(a) {
  if (!confirm(`Excluir ${ORIGENS[a.origem].toLowerCase()} de ${a.cliente_nome} (${moeda(a.valor_levantado)}) com a receita e o repasse ligados a ele?`)) return;
  return executar(async () => {
    const reserva = fin.lancamentos.find((x) => x.origem_id === a.lancamento_id);
    for (const id of [a.repasse_lancamento_id, a.lancamento_id].filter(Boolean)) await apagarLancamento(id);
    if (reserva?.pago_em) await atualizarResgate(reserva.pago_em.slice(0, 7));
    const { error } = await sb.from("fin_alvaras").delete().eq("id", a.id);
    if (error) throw new Error(mensagemErro(error));
    retirar("alvaras", a.id);
    return null;
  }, "Excluído.");
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
  const resultado = linha.querySelector(".cfg-resultado");
  if (resultado) dados.resultado = resultado.checked;
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

async function salvarReserva() {
  const pct = lerValor($("cfg-imposto").value);
  const desde = $("cfg-desde").value;
  if (!(pct >= 0 && pct <= 100) || !desde) { avisar("Informe o percentual e a data."); return; }
  const { data, error } = await sb.from("fin_config").update({ percentual_imposto: pct, reserva_desde: desde }).eq("id", 1).select().single();
  if (error) { avisar(mensagemErro(error), 4000); return; }
  fin.config = data;
  renderizarFinanceiro();
  avisar("Reserva de imposto atualizada. Vale para os próximos recebimentos registrados ou editados.", 4000);
}

// ------------------------------------------------------------- exportação

function exportarFinanceiro() {
  const mes = fin.mes || hoje().slice(0, 7);
  const lista = lancamentosDoMes().sort((a, b) => (a.pago_em || a.vencimento).localeCompare(b.pago_em || b.vencimento));
  const celula = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const numero = (v) => Number(v).toFixed(2).replace(".", ",");
  const linhas = [
    ["Vencimento", "Pago/recebido em", "Tipo", "Descrição", "Categoria", "Conta", "Conta destino", "Cliente", "Processo",
      "Reembolsável", "Entra no resultado", "Valor", "Valor no resultado"],
    ...lista.map((l) => {
      const sinal = l.natureza === "despesa" ? -1 : 1;
      return [dataBR(l.vencimento), dataBR(l.pago_em), NATUREZAS[l.natureza], l.descricao,
        nomeCategoria(l.categoria_id), nomeConta(l.conta_id), nomeConta(l.conta_destino_id), l.cliente_nome, l.processo,
        l.reembolsavel ? "sim" : "", valorResultado(l) ? "sim" : "não",
        numero(l.natureza === "transferencia" ? l.valor : sinal * l.valor), numero(sinal * valorResultado(l))];
    }),
  ];
  const regs = fin.alvaras.filter((a) => (a.data_levantamento || a.vencimento || "").startsWith(mes));
  if (regs.length) {
    linhas.push([], ["Alvarás e acordos do mês"], ["Data", "Origem", "Cliente", "Processo", "Valor total", "Honorários", "Custas reembolsadas", "Repasse", "Recebido em", "Repassado em"]);
    regs.forEach((a) => linhas.push([dataBR(a.vencimento), ORIGENS[a.origem], a.cliente_nome, a.processo,
      numero(a.valor_levantado), numero(a.honorarios), numero(a.descontos), numero(a.repasse), dataBR(a.data_levantamento), dataBR(a.repassado_em)]));
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
  $("fin-nova-transferencia").addEventListener("click", () => abrirTransferencia(null));
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
    else if (t.dataset.novoRecebimento) abrirRecebimento(null, { origem: t.dataset.novoRecebimento });
    else if (t.dataset.salvarConta) salvarConfig("fin_contas", t.dataset.salvarConta, t.closest("tr"));
    else if (t.dataset.salvarCategoria) salvarConfig("fin_categorias", t.dataset.salvarCategoria, t.closest("tr"));
    else if (t.dataset.novaConta !== undefined) novaConfig("fin_contas", { nome: "Nova conta", tipo: "banco" });
    else if (t.dataset.novaCategoria) novaConfig("fin_categorias", { nome: "Nova categoria", natureza: t.dataset.novaCategoria, resultado: t.dataset.novaCategoria !== "transferencia" });
    else if (t.dataset.salvarReserva !== undefined) salvarReserva();
    else if (t.tagName === "TR") location.hash = t.dataset.ir;
  });

  $("form-fin").addEventListener("submit", (e) => { e.preventDefault(); fin.dialogo?.salvar?.(); });
  $("dfin-excluir").addEventListener("click", () => fin.dialogo?.excluir?.());
  $("dlg-fin").addEventListener("click", (e) => {
    if (e.target.closest("[data-fechar]")) { fecharDialogo(); return; }
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.pagarDlg) {
      abrirPagamento(fin.lancamentos.find((x) => x.id === t.dataset.pagarDlg));
    } else if (t.dataset.parcial) {
      abrirPagamento(fin.lancamentos.find((x) => x.id === t.dataset.parcial), true);
    } else if (t.dataset.exito) {
      const c = fin.contratos.find((x) => x.id === t.dataset.exito);
      abrirLancamento(null, baseDoContrato(c, {
        descricao: `Êxito — ${c.cliente_nome}`, pago_em: hoje(),
        categoria_id: categoriaPorNome("Honorários de êxito", "receita")?.id,
      }));
    } else if (t.dataset.recebimentoContrato) {
      const c = fin.contratos.find((x) => x.id === t.dataset.recebimentoContrato);
      abrirRecebimento(null, { origem: "alvara", contrato_id: c.id, cliente_nome: c.cliente_nome, cliente_id: c.cliente_id,
        processo: c.processo, percentual: c.percentual_exito });
    } else if (t.dataset.gerarParcelas !== undefined) {
      gerarParcelasContrato(true);
    } else if (t.dataset.maisParcela !== undefined) {
      const ps = lerParcelas();
      const ultima = ps[ps.length - 1];
      $("pc-corpo").insertAdjacentHTML("beforeend", linhaParcela({
        vencimento: ultima?.vencimento ? somarMeses(ultima.vencimento, 1) : hoje(), valor: ultima?.valor || null }, ps.length));
      $("pc-corpo").dataset.manual = "1";
      atualizarTotalParcelas();
    } else if (t.dataset.removerParcela !== undefined) {
      t.closest("tr").remove();
      $("pc-corpo").dataset.manual = "1";
      atualizarTotalParcelas();
    }
  });
  $("dlg-fin").addEventListener("input", (e) => {
    const id = e.target.id;
    if (/^fc-(valor|parcelas|vencimento)$/.test(id)) gerarParcelasContrato();
    if (e.target.closest("#pc-corpo")) { $("pc-corpo").dataset.manual = "1"; atualizarTotalParcelas(); }
    if (/^fa-/.test(id)) atualizarPreviaRecebimento(id);
    if (id === "fp-valor") atualizarPreviaPagamento();
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
      $("dfin-titulo").textContent = `${$("dfin-titulo").textContent.startsWith("Editar") ? "Editar" : "Nova"} ${receita ? "receita" : "despesa"}`;
      $("fl-categoria").innerHTML = opcoesCategorias(t.value);
      $("fl-pago-rotulo").textContent = receita ? "Recebido em" : "Pago em";
      $("fl-reembolsavel-l").hidden = receita;
    }
    if (unico?.id === "fc-tipo") {
      const mensal = t.value === "mensal";
      $("fc-fixo").hidden = t.value === "exito";
      $("fc-exito").hidden = !["exito", "fixo_exito"].includes(t.value);
      $("fc-parcelas-l").hidden = mensal;
      $("fc-valor-rotulo").textContent = mensal ? "Valor mensal (R$)" : "Valor total (R$)";
      $("fc-ajuda").textContent = mensal
        ? `Sem data de término: o sistema mantém sempre ${MESES_MENSAL} meses lançados à frente. Ao encerrar o contrato, as parcelas futuras em aberto são removidas.`
        : "Ajuste data e valor de cada parcela na tabela abaixo, se forem diferentes.";
      gerarParcelasContrato(true);
    }
    if (unico?.id === "fa-origem") {
      const acordo = t.value === "acordo";
      $("fa-acordo").hidden = !acordo;
      $("fa-datas").hidden = acordo;
      $("fa-valor-rotulo").textContent = acordo ? "Valor total do acordo (R$)" : "Valor total (R$)";
      atualizarPreviaRecebimento();
    }
    if (t.id === "fl-repetir") $("fl-vezes").disabled = !t.value;
    if (t.id === "fp-parcial") atualizarPreviaPagamento();
    if (t.id === "ft-categoria" && !$("ft-descricao").value.trim()) {
      const nome = categoria(t.value)?.nome || "";
      const poup = contaPoupanca();
      if (poup && /Resgate/.test(nome)) { $("ft-origem").value = poup.id; $("ft-destino").value = contaPadrao() || ""; }
      if (poup && /Aplicação/.test(nome)) { $("ft-origem").value = contaPadrao() || ""; $("ft-destino").value = poup.id; }
    }
    if (t.id === "fc-atendimento" && t.value) {
      const a = at.lista.find((x) => x.id === t.value);
      if (a && !$("fc-cliente").value.trim()) $("fc-cliente").value = a.cliente_nome || "";
      if (a?.processo && !$("fc-processo").value.trim()) $("fc-processo").value = a.processo;
    }
    if (t.id === "fa-contrato" && t.value) {
      const c = fin.contratos.find((x) => x.id === t.value);
      if (c && !$("fa-cliente").value.trim()) $("fa-cliente").value = c.cliente_nome;
      if (c?.processo && !$("fa-processo").value.trim()) $("fa-processo").value = c.processo;
      if (c?.percentual_exito != null && !$("fa-percentual").value) { $("fa-percentual").value = percentualCampo(c.percentual_exito); atualizarPreviaRecebimento("fa-percentual"); }
    }
    if (/^fa-/.test(t.id)) atualizarPreviaRecebimento();
  });
  $("dlg-fin").addEventListener("close", () => {
    // o evento "close" chega depois; se outra janela já foi aberta no lugar, não mexe nela
    if ($("dlg-fin").open) return;
    fin.dialogo = null;
    fin.pagamento = null;
    if (/^#financeiro\/(lancamento|contrato|alvara)\//.test(location.hash)) history.replaceState(null, "", `#financeiro/${fin.sub}`);
  });
}
