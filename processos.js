// Aba Processos: carteira e ficha de cada processo, com linha do tempo que junta publicações,
// agenda, financeiro, atendimento e anotações pelo número do processo (só os dígitos).
// Processos nascem sozinhos no banco: de publicações novas ("a revisar") e da distribuição no Atendimento.
// Níveis: processos 1 vê, 2 edita (public.nivel('processos')).
// Usa app.js ($, esc, sb, estado, pode, avisar...), atendimento.js (at, normalizarNome) e
// financeiro.js (fin, abrirDialogo, moeda, opcoes, lerValor...).

const FASES = {
  conhecimento: "Conhecimento", recursal: "Recursal", cumprimento_sentenca: "Cumprimento de sentença",
  execucao: "Execução", acordo: "Acordo cumprindo", suspenso: "Suspenso", arquivado: "Arquivado",
};
const AREAS_PROC = { trabalhista: "Trabalhista", previdenciario: "Previdenciário", civel: "Cível", outra: "Outra" };
const POLOS = { ativo: "Ativo (autor / reclamante)", passivo: "Passivo (réu / reclamada)", terceiro: "Terceiro" };
const DIAS_PARADO = 90;

const proc = {
  lista: [],
  carregado: false,
  situacao: "ativos",
  aberto: null,           // id do processo com a ficha aberta
  anotacoes: new Map(),   // processo_id -> anotações
  tl: "tudo",
};

const dig = (s) => String(s ?? "").replace(/\D/g, "");

function formatarCNJ(d) {
  return d.length === 20 ? `${d.slice(0, 7)}-${d.slice(7, 9)}.${d.slice(9, 13)}.${d.slice(13, 14)}.${d.slice(14, 16)}.${d.slice(16)}` : d;
}

const processoPorNumero = (numero) => {
  const d = dig(numero);
  return d.length >= 15 ? proc.lista.find((p) => p.numero_digitos === d) : null;
};

// "FULANO DE TAL (polo ativo)" -> { nome, polo }
function lerParte(texto) {
  const m = /^(.*?)\s*\((polo ativo|polo passivo|[^)]*)\)\s*$/i.exec(texto || "");
  if (!m) return { nome: (texto || "").trim(), polo: null };
  const polo = /ativo/i.test(m[2]) ? "ativo" : /passivo/i.test(m[2]) ? "passivo" : null;
  return { nome: m[1].trim(), polo };
}

// ------------------------------------------------------------- dados ligados ao processo

const pubsDo = (p) => (estado.publicacoes || []).filter((x) => dig(x.processo) === p.numero_digitos);
const compsDo = (p) => (estado.compromissos || []).filter((c) => dig(c.processo) === p.numero_digitos);
const lancsDo = (p) => (typeof fin !== "undefined" ? fin.lancamentos : []).filter((l) => dig(l.processo) === p.numero_digitos);
const alvarasDo = (p) => (typeof fin !== "undefined" ? fin.alvaras : []).filter((a) => dig(a.processo) === p.numero_digitos);
const contratosDo = (p) => (typeof fin !== "undefined" ? fin.contratos : [])
  .filter((c) => (c.processo && dig(c.processo) === p.numero_digitos) || (p.atendimento_id && c.atendimento_id === p.atendimento_id));
const atendimentoDo = (p) => at.lista.find((a) => a.id === p.atendimento_id) ||
  at.lista.find((a) => a.processo && dig(a.processo) === p.numero_digitos);

function proximo(p, tipo) {
  const agora = hoje();
  return compsDo(p).filter((c) => c.tipo === tipo && c.situacao === "pendente" && diaLocal(c.inicio) >= agora)
    .sort((a, b) => a.inicio.localeCompare(b.inicio))[0];
}

function prazoVencido(p) {
  return compsDo(p).some((c) => c.tipo === "prazo" && c.situacao === "pendente" && diaLocal(c.inicio) < hoje());
}

function ultimaMovimentacao(p) {
  const datas = [p.ultima_movimentacao, p.distribuido_em, ...pubsDo(p).map((x) => x.data)].filter(Boolean).sort();
  return datas[datas.length - 1] || null;
}

function parado(p) {
  if (p.revisar || ["arquivado", "suspenso"].includes(p.fase)) return false;
  const ultima = ultimaMovimentacao(p);
  return !ultima || ultima < somarDias(hoje(), -DIAS_PARADO);
}

const ativo = (p) => !p.revisar && p.fase !== "arquivado";

// ------------------------------------------------------------- carga e rotas

async function carregarProcessos() {
  const r = await lerTudo(() => sb.from("processos").select("*").order("numero_digitos"));
  if (r.error) {
    $("pr-lista").innerHTML = `<div class="vazio">Não foi possível carregar os processos: ${esc(r.error.message)}</div>`;
    return;
  }
  proc.lista = r.data;
  proc.carregado = true;
  const resp = $("pr-resp").value;
  $("pr-resp").innerHTML = '<option value="">Todos os responsáveis</option>' +
    estado.equipe.map((x) => `<option value="${esc(x.email)}">${esc(x.nome || x.email)}</option>`).join("");
  $("pr-resp").value = resp;
  // quem só tem acesso a processos ainda precisa da lista de clientes para escolher
  if (!at.clientes.length) {
    const c = await sb.from("clientes").select("*").order("nome").limit(5000);
    if (c.data) at.clientes = c.data;
  }
  if (!$("fin-clientes").children.length) $("fin-clientes").innerHTML = at.clientes.map((c) => `<option value="${esc(c.nome)}">`).join("");
  renderizarProcessos();
  if (pode("publicacoes")) renderizarPublicacoes();
}

function rotearProcessos(id) {
  proc.aberto = id || null;
  if (!proc.carregado) return;
  if (id && !proc.lista.some((p) => p.id === id)) {
    avisar("Processo não encontrado.");
    history.replaceState(null, "", "#processos");
    proc.aberto = null;
  }
  renderizarProcessos();
  if (proc.aberto) { carregarAnotacoes(proc.aberto); window.scrollTo(0, 0); }
}

function renderizarProcessos() {
  if (!proc.carregado) return;
  const ficha = proc.aberto && proc.lista.find((p) => p.id === proc.aberto);
  $("pr-painel").hidden = !!ficha;
  $("pr-ficha").hidden = !ficha;
  if (ficha) return renderizarFicha(ficha);
  renderizarCarteira();
}

// ------------------------------------------------------------- carteira

function renderizarCarteira() {
  const agora = hoje(), semana = somarDias(agora, 7), mes = agora.slice(0, 7);
  const digitosCarteira = new Set(proc.lista.filter((p) => p.fase !== "arquivado").map((p) => p.numero_digitos));
  const ligados = (c) => digitosCarteira.has(dig(c.processo));
  const prazos = (estado.compromissos || []).filter((c) => c.tipo === "prazo" && c.situacao === "pendente" && ligados(c) &&
    diaLocal(c.inicio) >= agora && diaLocal(c.inicio) <= semana);
  const audiencias = (estado.compromissos || []).filter((c) => c.tipo === "audiencia" && c.situacao === "pendente" && ligados(c) &&
    diaLocal(c.inicio).startsWith(mes) && diaLocal(c.inicio) >= agora);
  const aRevisar = proc.lista.filter((p) => p.revisar);

  $("pr-n-ativos").textContent = proc.lista.filter(ativo).length;
  $("pr-n-prazos").textContent = prazos.length;
  $("pr-n-audiencias").textContent = audiencias.length;
  $("pr-n-parados").textContent = proc.lista.filter(parado).length;
  document.querySelectorAll("[data-pr-situacao]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.prSituacao === proc.situacao));
  $("pr-novo").hidden = !pode("processos", 2);

  $("pr-revisar").hidden = !aRevisar.length || proc.situacao === "revisar";
  $("pr-revisar").innerHTML = aRevisar.length
    ? `<span>🔎 <b>${aRevisar.length} processo(s)</b> criado(s) a partir das publicações aguardam revisão (cliente, área e responsável).</span>
       <button class="botao-sec" data-pr-situacao="revisar">Revisar agora</button>` : "";

  const busca = normalizarNome($("pr-busca").value);
  const buscaDig = dig($("pr-busca").value);
  const area = $("pr-area").value, fase = $("pr-fase").value, resp = $("pr-resp").value;
  const filtros = {
    ativos: ativo, revisar: (p) => p.revisar, parados: parado, arquivados: (p) => p.fase === "arquivado", todos: () => true,
    prazos: (p) => prazos.some((c) => dig(c.processo) === p.numero_digitos),
  };
  const lista = proc.lista.filter(filtros[proc.situacao] || filtros.ativos).filter((p) => {
    if (area && p.area !== area) return false;
    if (fase && p.fase !== fase) return false;
    if (resp && !(p.responsaveis || []).includes(resp)) return false;
    if (busca || buscaDig.length >= 4) {
      const alvo = normalizarNome([p.numero, p.cliente_nome, ...(p.partes_contrarias || []), ...(p.partes_publicacao || []), p.orgao, p.tribunal, p.classe].join(" "));
      const porNumero = buscaDig.length >= 4 && p.numero_digitos.includes(buscaDig);
      if (!porNumero && !(busca && busca.split(" ").every((t) => alvo.includes(t)))) return false;
    }
    return true;
  }).sort((a, b) => (ultimaMovimentacao(b) || "").localeCompare(ultimaMovimentacao(a) || ""));

  const titulos = { ativos: "ativos", revisar: "a revisar", parados: `sem movimentação há ${DIAS_PARADO} dias`, arquivados: "arquivados", todos: "", prazos: "com prazo nesta semana" };
  $("pr-contagem").textContent = `${lista.length} processo(s) ${titulos[proc.situacao] || ""} · ordenados pela última movimentação`;
  $("pr-lista").innerHTML = lista.length ? lista.map(itemProcesso).join("")
    : `<div class="vazio">${busca || area || fase || resp ? "Nenhum processo com esses filtros." : "Nenhum processo aqui."}</div>`;
}

function partesTexto(p) {
  if (p.cliente_nome) return `<b>${esc(p.cliente_nome)}</b>${p.partes_contrarias?.length ? ` × ${esc(p.partes_contrarias.join(", "))}` : ""}`;
  const partes = (p.partes_publicacao || []).map(lerParte);
  return partes.length ? esc(partes.map((x) => x.nome).join(" × ")) : '<span class="proc-sub">partes não informadas</span>';
}

function etiquetaArea(p) {
  return p.area ? `<span class="etq ${p.area}">${AREAS_PROC[p.area]}</span>` : "";
}

function itemProcesso(p) {
  const prazo = proximo(p, "prazo"), aud = proximo(p, "audiencia");
  const ultima = ultimaMovimentacao(p);
  const sub = [p.tribunal, p.orgao, FASES[p.fase], p.responsaveis?.length && `Resp.: ${p.responsaveis.map(nomePessoa).join(", ")}`]
    .filter(Boolean).map(esc).join(" · ");
  const selos = [];
  if (p.revisar) selos.push('<span class="selo-at aguardando_distribuicao">a revisar</span>');
  if (prazoVencido(p)) selos.push('<span class="selo-at atrasado">prazo vencido</span>');
  if (prazo) selos.push(`<span class="selo-at ${diaLocal(prazo.inicio) <= somarDias(hoje(), 3) ? "atrasado" : ""}">prazo ${dataBR(diaLocal(prazo.inicio)).slice(0, 5)}</span>`);
  if (aud) selos.push(`<span class="selo-at aguardando_distribuicao">audiência ${dataBR(diaLocal(aud.inicio)).slice(0, 5)}${aud.dia_inteiro ? "" : ` ${horaLocal(aud.inicio)}`}</span>`);
  if (parado(p)) selos.push(`<span class="selo-at atrasado">parado há ${ultima ? Math.round((Date.parse(hoje()) - Date.parse(ultima)) / 864e5) : "?"} dias</span>`);
  return `
  <article class="proc ${p.revisar ? "revisar" : ""} ${p.fase === "arquivado" ? "arquivado" : ""} ${parado(p) ? "parado" : ""}">
    <a class="proc-link" href="#processos/${esc(p.id)}">
      <span class="proc-info">
        <span class="proc-num">${esc(p.numero)} ${etiquetaArea(p)}</span>
        <span class="proc-partes">${partesTexto(p)}</span>
        <span class="proc-sub">${sub}</span>
      </span>
    </a>
    <span class="proc-lado">${selos.join("")}
      <span class="proc-sub">${ultima ? `últ. movimentação ${dataBR(ultima)}` : "sem movimentação registrada"}</span>
      ${p.revisar && pode("processos", 2) ? `<button class="botao-sec mini" data-pr-editar="${esc(p.id)}">Revisar</button>` : ""}
    </span>
  </article>`;
}

// ------------------------------------------------------------- ficha

async function carregarAnotacoes(id) {
  const { data } = await sb.from("processo_anotacoes").select("*").eq("processo_id", id).order("criado_em", { ascending: false });
  proc.anotacoes.set(id, data || []);
  if (proc.aberto === id) renderizarProcessos();
}

function eventosDo(p) {
  const ev = [];
  for (const x of pubsDo(p)) {
    ev.push({ tipo: "publicacao", data: x.data, cor: "var(--nova)", rotulo: "Publicação",
      quando: `${dataBR(x.data)} · ${esc(x.tribunal)}${x.tipo ? ` · ${esc(x.tipo)}` : ""} · ${x.providenciada ? "providenciada" : x.lida ? "lida" : "não lida"}`,
      texto: `${esc((x.texto || "").replace(/\s+/g, " ").slice(0, 260))}${(x.texto || "").length > 260 ? "…" : ""} <a href="#" data-pr-teor="${esc(x.chave)}">ver teor</a>` });
  }
  for (const c of compsDo(p)) {
    const d = diaLocal(c.inicio);
    ev.push({ tipo: "agenda", data: d, cor: `var(--t-${c.tipo})`, rotulo: TIPOS[c.tipo] || "Compromisso",
      quando: `${dataBR(d)}${c.dia_inteiro ? "" : ` ${horaLocal(c.inicio)}`} · ${c.situacao}${c.compromisso_responsaveis?.length ? ` · ${esc(c.compromisso_responsaveis.map((r) => nomePessoa(r.email)).join(", "))}` : ""}`,
      texto: `${esc(c.titulo)} <a href="#agenda/${esc(c.id)}">abrir na agenda</a>`, futuro: d >= hoje() && c.situacao === "pendente" });
  }
  for (const l of lancsDo(p).filter((x) => x.natureza !== "transferencia")) {
    const d = l.pago_em || l.vencimento;
    ev.push({ tipo: "financeiro", data: d, cor: l.natureza === "receita" ? "var(--ok)" : "var(--perigo)", rotulo: "Financeiro",
      quando: `${dataBR(d)} · ${l.pago_em ? (l.natureza === "receita" ? "recebido" : "pago") : "em aberto"}`,
      texto: `${esc(l.descricao)} — <b>${moeda(l.valor)}</b> <a href="#financeiro/lancamento/${esc(l.id)}">abrir</a>` });
  }
  for (const n of proc.anotacoes.get(p.id) || []) {
    const minha = n.criado_por === estado.eu && pode("processos", 2);
    ev.push({ tipo: "anotacao", data: diaLocal(n.criado_em), cor: "var(--suave)", rotulo: "Anotação",
      quando: `${new Date(n.criado_em).toLocaleString("pt-BR")} · ${esc(nomePessoa(n.criado_por))}`,
      texto: `<span class="anot-texto">${esc(n.texto)}</span>${minha ? ` <a href="#" data-pr-apagar-anot="${esc(n.id)}">apagar</a>` : ""}`,
      ordem: n.criado_em });
  }
  const a = atendimentoDo(p);
  if (a) ev.push({ tipo: "atendimento", data: a.data_atendimento, cor: "var(--t-atendimento)", rotulo: "Atendimento",
    quando: `${dataBR(a.data_atendimento)} · ${esc(nomePessoa(a.atendente))}`,
    texto: `Primeiro atendimento do cliente <a href="#atendimento/${esc(a.id)}">abrir ficha</a>` });
  if (p.distribuido_em) ev.push({ tipo: "atendimento", data: p.distribuido_em, cor: "var(--t-distribuicao)", rotulo: "Distribuição",
    quando: dataBR(p.distribuido_em), texto: "Ação distribuída" });
  return ev.sort((x, y) => (y.data || "").localeCompare(x.data || "") || (y.ordem || "").localeCompare(x.ordem || ""));
}

function blocoFinanceiro(p) {
  if (!pode("financeiro")) return "";
  const lancs = lancsDo(p).filter((l) => l.natureza !== "transferencia");
  const contratos = contratosDo(p);
  const honorarios = soma(lancs.filter((l) => l.natureza === "receita" && l.pago_em), valorResultado);
  const aReceber = soma(lancs.filter((l) => l.natureza === "receita" && !l.pago_em));
  const despesas = lancs.filter((l) => l.natureza === "despesa" && l.pago_em && !registroDoRepasse(l));
  const reembolsar = soma(despesas.filter((l) => l.reembolsavel));
  const alvaras = alvarasDo(p);
  return `
  <div class="bloco">
    <h3>Financeiro do processo</h3>
    <div class="lin"><span>Contrato</span><span>${contratos.length ? contratos.map((c) => `<a href="#financeiro/contrato/${esc(c.id)}">${esc(textoContratado(c))}</a>`).join("<br>") : "—"}</span></div>
    <div class="lin"><span>Honorários recebidos</span><span class="valor rec">${moeda(honorarios)}</span></div>
    <div class="lin"><span>A receber</span><span class="valor">${moeda(aReceber)}</span></div>
    <div class="lin"><span>Custas e despesas pagas</span><span class="valor desp">${moeda(soma(despesas))}</span></div>
    <div class="lin"><span>Reembolsáveis pelo cliente</span><span class="valor">${moeda(reembolsar)}</span></div>
    <div class="lin"><span>Alvarás e acordos</span><span>${alvaras.length ? alvaras.map((a) => `<a href="#financeiro/alvara/${esc(a.id)}">${ORIGENS[a.origem]} ${moeda(a.valor_levantado)}</a>`).join("<br>") : "—"}</span></div>
  </div>`;
}

function renderizarFicha(p) {
  const cliente = p.cliente_id && at.clientes.find((c) => c.id === p.cliente_id);
  const a = atendimentoDo(p);
  const comps = compsDo(p).filter((c) => c.situacao === "pendente" && diaLocal(c.inicio) >= somarDias(hoje(), -30))
    .sort((x, y) => x.inicio.localeCompare(y.inicio));
  const eventos = eventosDo(p);
  const filtrados = proc.tl === "tudo" ? eventos : eventos.filter((e) => e.tipo === proc.tl);
  const contagem = (t) => eventos.filter((e) => e.tipo === t).length;
  const doc = (d) => (d?.length === 11 ? `CPF ${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d?.length === 14 ? `CNPJ ${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : "");
  const edita = pode("processos", 2);

  $("pr-ficha").innerHTML = `
  <div class="ficha-barra">
    <a class="botao-sec" href="#processos">← Processos</a>
    <span class="espaco"></span>
    ${edita ? `<button class="botao-sec" data-pr-editar="${esc(p.id)}">${p.revisar ? "Revisar dados" : "Editar dados"}</button>` : ""}
    ${pode("agenda", 2) ? '<button class="botao-sec" data-pr-compromisso>+ Prazo / audiência</button>' : ""}
    ${pode("financeiro", 2) ? '<button class="botao-sec" data-pr-lancamento>+ Lançamento</button>' : ""}
    ${edita ? `<button class="botao-sec" data-pr-arquivar>${p.fase === "arquivado" ? "Reativar" : "Arquivar"}</button>` : ""}
  </div>
  ${p.revisar ? `<div class="ficha-aviso">Este processo foi criado a partir de uma publicação. ${edita ? `<a href="#" data-pr-editar="${esc(p.id)}">Revise os dados</a>` : "Revise os dados"}: cliente, área e responsável.</div>` : ""}
  <div class="ficha-cab">
    <h2>${esc(p.numero)}</h2>
    <div class="proc-partes">${partesTexto(p)}${p.polo && p.cliente_nome ? ` <span class="proc-sub">· cliente no polo ${p.polo}</span>` : ""}</div>
    <div class="linha">
      ${etiquetaArea(p)}<span class="selo-at ${p.fase === "arquivado" ? "" : "aguardando_distribuicao"}">${FASES[p.fase]}</span>
      <span class="proc-sub">${[p.distribuido_em && `Distribuído em ${dataBR(p.distribuido_em)}`,
        a && `<a href="#atendimento/${esc(a.id)}">ficha do atendimento</a>`,
        p.link && `<a href="${esc(p.link)}" target="_blank" rel="noopener">abrir no tribunal</a>`].filter(Boolean).join(" · ")}</span>
    </div>
    <div class="dados">
      <div><span>Tribunal / órgão</span>${esc([p.tribunal, p.orgao].filter(Boolean).join(" · ") || "—")}</div>
      <div><span>Classe</span>${esc(p.classe || "—")}</div>
      <div><span>Valor da causa</span>${p.valor_causa ? moeda(p.valor_causa) : "—"}</div>
      <div><span>Responsáveis</span>${esc((p.responsaveis || []).map(nomePessoa).join(", ") || "—")}</div>
      <div><span>Última movimentação</span>${ultimaMovimentacao(p) ? dataBR(ultimaMovimentacao(p)) : "—"}</div>
      ${p.observacoes ? `<div class="largo"><span>Observações</span>${esc(p.observacoes)}</div>` : ""}
    </div>
  </div>
  <div class="grade-proc">
    <div class="bloco">
      <h3>Linha do tempo</h3>
      <div class="filtro-tl">
        ${[["tudo", "Tudo", eventos.length], ["publicacao", "Publicações", contagem("publicacao")], ["agenda", "Agenda", contagem("agenda")],
          ["financeiro", "Financeiro", contagem("financeiro")], ["anotacao", "Anotações", contagem("anotacao")]]
          .map(([v, r, n]) => `<button data-pr-tl="${v}" aria-pressed="${proc.tl === v}">${r}${n ? ` (${n})` : ""}</button>`).join("")}
      </div>
      <div class="tl">${filtrados.length ? filtrados.map((e) => `
        <div class="ev ${e.futuro ? "futuro" : ""}" style="--cor:${e.cor}"><div class="q"><b>${e.rotulo}</b> ${e.quando}</div><div class="t">${e.texto}</div></div>`).join("")
        : '<div class="vazio pequeno">Nada registrado ainda.</div>'}</div>
    </div>
    <div>
      <div class="bloco">
        <h3>Próximos compromissos</h3>
        ${comps.length ? comps.map((c) => `<div class="lin"><a href="#agenda/${esc(c.id)}">${dataBR(diaLocal(c.inicio)).slice(0, 5)}${c.dia_inteiro ? "" : ` ${horaLocal(c.inicio)}`} · ${esc(TIPOS[c.tipo])}: ${esc(c.titulo)}</a>
          <span class="selo-at ${diaLocal(c.inicio) < hoje() ? "atrasado" : ""}">${diaLocal(c.inicio) < hoje() ? "vencido" : diaLocal(c.inicio) === hoje() ? "hoje" : `em ${Math.round((Date.parse(diaLocal(c.inicio)) - Date.parse(hoje())) / 864e5)} dia(s)`}</span></div>`).join("")
          : '<div class="vazio pequeno">Nenhum prazo ou audiência pendente.</div>'}
      </div>
      ${blocoFinanceiro(p)}
      <div class="bloco">
        <h3>Partes</h3>
        ${p.cliente_nome ? `<div class="lin"><span><b>${esc(p.cliente_nome)}</b> <span class="proc-sub">(cliente)</span><br>
          <span class="proc-sub">${esc([doc(cliente?.documento), cliente?.telefone, cliente?.email].filter(Boolean).join(" · "))}</span></span></div>` : ""}
        ${(p.partes_contrarias || []).map((x) => `<div class="lin"><span>${esc(x)} <span class="proc-sub">(parte contrária)</span></span></div>`).join("")}
        ${p.partes_publicacao?.length ? `<p class="at-sub">Como aparecem nas publicações: ${esc(p.partes_publicacao.join("; "))}</p>` : ""}
      </div>
      ${edita ? `<div class="bloco">
        <h3>Nova anotação</h3>
        <textarea class="anot" id="pr-anotacao" placeholder="Ex.: cliente ligou; proposta de acordo de R$ 20 mil…"></textarea>
        <button class="botao" data-pr-anotar style="margin-top:8px">Salvar anotação</button>
      </div>` : ""}
    </div>
  </div>`;
}

// ------------------------------------------------------------- edição

function abrirProcesso(p) {
  const novo = !p;
  const d = p || { fase: "conhecimento", responsaveis: [estado.eu], partes_contrarias: [], partes_publicacao: [] };
  const partes = (d.partes_publicacao || []).map(lerParte);
  abrirDialogo({
    titulo: novo ? "Novo processo" : d.revisar ? "Revisar processo" : "Editar processo",
    ok: d.revisar ? "Salvar e concluir revisão" : "Salvar",
    excluir: !novo ? () => excluirProcesso(d) : null,
    salvar: () => salvarProcesso(p, d),
    corpo: `
      <div class="linha2">
        <label>Número do processo<input id="pp-numero" required value="${esc(d.numero || "")}" ${novo ? "" : "readonly"} placeholder="0000000-00.0000.0.00.0000"></label>
        <label>Tribunal<input id="pp-tribunal" maxlength="40" value="${esc(d.tribunal || "")}" placeholder="TRT3, TJMG, TRF6…"></label>
      </div>
      <div class="linha2">
        <label>Vara / órgão<input id="pp-orgao" maxlength="200" value="${esc(d.orgao || "")}"></label>
        <label>Classe<input id="pp-classe" maxlength="200" value="${esc(d.classe || "")}"></label>
      </div>
      ${partes.length ? `<div><span class="rotulo">Partes na publicação — clique em quem é o nosso cliente</span>
        <div class="escolhas" id="pp-partes">${partes.map((x, i) => {
          const cadastrado = clientePorNome(x.nome);
          return `<button type="button" class="escolha" data-pp-parte="${i}">${esc(x.nome)}${x.polo ? ` <span class="proc-sub">(${x.polo})</span>` : ""}${cadastrado ? " ✓" : ""}</button>`;
        }).join("")}</div>
        <p class="at-sub">✓ = já está no cadastro de clientes. As demais partes viram “partes contrárias”.</p></div>` : ""}
      <div class="linha2">
        <label>Cliente<input id="pp-cliente" list="fin-clientes" maxlength="200" value="${esc(d.cliente_nome || "")}" placeholder="nome do cliente"></label>
        <label>Polo do cliente<select id="pp-polo">${opcoes(Object.entries(POLOS), d.polo, "—")}</select></label>
      </div>
      <label>Partes contrárias (uma por linha)<textarea id="pp-contrarias" rows="2">${esc((d.partes_contrarias || []).join("\n"))}</textarea></label>
      <div class="linha3">
        <label>Área<select id="pp-area">${opcoes(Object.entries(AREAS_PROC), d.area, "—")}</select></label>
        <label>Fase<select id="pp-fase">${opcoes(Object.entries(FASES), d.fase)}</select></label>
        <label>Valor da causa (R$)<input id="pp-valor" inputmode="decimal" value="${esc(valorCampo(d.valor_causa))}"></label>
      </div>
      <div class="linha2">
        <label>Distribuído em<input type="date" id="pp-distribuido" value="${esc(d.distribuido_em || "")}"></label>
        <label>Link do processo no tribunal<input id="pp-link" maxlength="500" value="${esc(d.link || "")}" placeholder="https://…"></label>
      </div>
      <div><span class="rotulo">Responsáveis</span>
        <div class="responsaveis" id="pp-resp">${estado.equipe.map((x) =>
          `<label class="check"><input type="checkbox" value="${esc(x.email)}" ${(d.responsaveis || []).includes(x.email) ? "checked" : ""}> ${esc(x.nome || x.email)}</label>`).join("")}</div></div>
      <label>Observações<textarea id="pp-obs" rows="2">${esc(d.observacoes || "")}</textarea></label>
      ${rodapeAutoria(p)}`,
  });
  proc.editando = d;
}

function salvarProcesso(p, d) {
  const novo = !p;
  const numero = $("pp-numero").value.trim();
  const digitos = dig(numero);
  if (digitos.length < 7) { avisar("Informe o número do processo."); return; }
  const existente = novo && proc.lista.find((x) => x.numero_digitos === digitos);
  if (existente) {
    avisar("Esse processo já está cadastrado; abrindo a ficha dele.", 4000);
    location.hash = `#processos/${existente.id}`;
    $("dlg-fin").close();
    return;
  }
  const clienteNome = $("pp-cliente").value.trim();
  const responsaveis = [...$("pp-resp").querySelectorAll("input:checked")].map((i) => i.value);
  const area = $("pp-area").value || null;
  if (d.revisar && (!clienteNome || !area || !responsaveis.length)) {
    avisar("Para concluir a revisão, informe cliente, área e pelo menos um responsável.", 4000);
    return;
  }
  const valor = lerValor($("pp-valor").value);
  const dados = {
    tribunal: $("pp-tribunal").value.trim() || null,
    orgao: $("pp-orgao").value.trim() || null,
    classe: $("pp-classe").value.trim() || null,
    cliente_nome: clienteNome || null,
    polo: $("pp-polo").value || null,
    partes_contrarias: $("pp-contrarias").value.split("\n").map((x) => x.trim()).filter(Boolean),
    area, fase: $("pp-fase").value,
    valor_causa: Number.isFinite(valor) ? valor : null,
    distribuido_em: $("pp-distribuido").value || null,
    link: $("pp-link").value.trim() || null,
    responsaveis,
    observacoes: $("pp-obs").value.trim() || null,
    revisar: false,
  };
  if (novo) Object.assign(dados, { numero: formatarCNJ(digitos), numero_digitos: digitos });
  return executar(async () => {
    // cliente novo entra no cadastro de clientes
    let cliente = clientePorNome(clienteNome);
    if (clienteNome && !cliente) {
      const { data, error } = await sb.from("clientes").insert({ nome: clienteNome }).select().single();
      if (error) throw new Error(`Não foi possível cadastrar o cliente: ${mensagemErro(error)}`);
      at.clientes.push(data);
      at.clientes.sort((a, b) => a.nome.localeCompare(b.nome));
      $("fin-clientes").insertAdjacentHTML("beforeend", `<option value="${esc(data.nome)}">`);
      cliente = data;
    }
    dados.cliente_id = cliente?.id || null;
    const q = novo ? sb.from("processos").insert(dados) : sb.from("processos").update(dados).eq("id", p.id);
    const { data: salvo, error } = await q.select().single();
    if (error) throw new Error(/duplicate|unique/i.test(error.message) ? "Já existe um processo com esse número." : mensagemErro(error));
    guardar(proc.lista, salvo);
    if (novo) location.hash = `#processos/${salvo.id}`;
    return null;
  }, d.revisar ? "Revisão concluída." : "Processo salvo.");
}

function excluirProcesso(p) {
  if (!confirm(`Excluir o processo ${p.numero} da carteira? Publicações, agenda e financeiro não são apagados.` +
    (p.revisar ? "\n\nSe vier nova publicação com esse número, ele volta para “a revisar”." : ""))) return;
  return executar(async () => {
    const { error } = await sb.from("processos").delete().eq("id", p.id);
    if (error) throw new Error(mensagemErro(error));
    proc.lista = proc.lista.filter((x) => x.id !== p.id);
    if (proc.aberto === p.id) { proc.aberto = null; history.replaceState(null, "", "#processos"); }
    return null;
  }, "Processo excluído da carteira.");
}

async function arquivarProcesso(p) {
  const arquivar = p.fase !== "arquivado";
  if (arquivar && !confirm(`Arquivar o processo ${p.numero}? Ele sai da lista de ativos, mas continua consultável.`)) return;
  const { data, error } = await sb.from("processos").update({ fase: arquivar ? "arquivado" : "conhecimento" }).eq("id", p.id).select().single();
  if (error) { avisar(mensagemErro(error), 4000); return; }
  guardar(proc.lista, data);
  renderizarProcessos();
  avisar(arquivar ? "Processo arquivado." : "Processo reativado (fase: conhecimento — ajuste se precisar).", 4000);
}

async function salvarAnotacao(p) {
  const texto = $("pr-anotacao").value.trim();
  if (!texto) { avisar("Escreva a anotação."); return; }
  const { data, error } = await sb.from("processo_anotacoes").insert({ processo_id: p.id, texto }).select().single();
  if (error) { avisar(mensagemErro(error), 4000); return; }
  proc.anotacoes.set(p.id, [data, ...(proc.anotacoes.get(p.id) || [])]);
  renderizarProcessos();
  avisar("Anotação salva.");
}

async function apagarAnotacao(id) {
  if (!confirm("Apagar esta anotação?")) return;
  const { error } = await sb.from("processo_anotacoes").delete().eq("id", id);
  if (error) { avisar(mensagemErro(error), 4000); return; }
  proc.anotacoes.set(proc.aberto, (proc.anotacoes.get(proc.aberto) || []).filter((n) => n.id !== id));
  renderizarProcessos();
}

function mostrarTeor(chave) {
  const x = (estado.publicacoes || []).find((y) => y.chave === chave);
  if (!x) return;
  abrirDialogo({
    titulo: `Publicação de ${dataBR(x.data)} · ${x.tribunal}`,
    somenteLeitura: true,
    corpo: `<div class="at-sub">${esc([x.orgao, x.classe, x.tipo].filter(Boolean).join(" · "))}</div>
      <div class="teor">${esc(x.texto || "(sem texto)")}</div>
      ${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">abrir no tribunal</a>` : ""}`,
  });
}

// ------------------------------------------------------------- eventos

function prepararProcessos() {
  $("pr-novo").addEventListener("click", () => abrirProcesso(null));
  for (const id of ["pr-busca", "pr-area", "pr-fase", "pr-resp"]) $(id).addEventListener("input", renderizarProcessos);
  $("tela-processos").addEventListener("click", (e) => {
    const t = e.target.closest("[data-pr-situacao], [data-pr-editar], [data-pr-tl], [data-pr-compromisso], [data-pr-lancamento], [data-pr-arquivar], [data-pr-anotar], [data-pr-teor], [data-pr-apagar-anot]");
    if (!t) return;
    const p = proc.lista.find((x) => x.id === proc.aberto);
    if (t.dataset.prSituacao) { proc.situacao = t.dataset.prSituacao; renderizarProcessos(); }
    else if (t.dataset.prEditar) { e.preventDefault(); abrirProcesso(proc.lista.find((x) => x.id === t.dataset.prEditar)); }
    else if (t.dataset.prTl) { proc.tl = t.dataset.prTl; renderizarProcessos(); }
    else if (t.dataset.prCompromisso !== undefined) {
      abrirFormulario({ tipo: "prazo", dia_inteiro: true, processo: p.numero, titulo: `Prazo — ${p.cliente_nome || p.numero}` });
    } else if (t.dataset.prLancamento !== undefined) {
      abrirLancamento(null, { natureza: "despesa", processo: p.numero, cliente_nome: p.cliente_nome, cliente_id: p.cliente_id,
        descricao: `Custas — ${p.cliente_nome || p.numero}`, reembolsavel: true });
    } else if (t.dataset.prArquivar !== undefined) arquivarProcesso(p);
    else if (t.dataset.prAnotar !== undefined) salvarAnotacao(p);
    else if (t.dataset.prTeor) { e.preventDefault(); mostrarTeor(t.dataset.prTeor); }
    else if (t.dataset.prApagarAnot) { e.preventDefault(); apagarAnotacao(t.dataset.prApagarAnot); }
  });
  // escolher o cliente entre as partes da publicação
  $("dlg-fin").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pp-parte]");
    if (!b || !proc.editando) return;
    const partes = (proc.editando.partes_publicacao || []).map(lerParte);
    const escolhida = partes[Number(b.dataset.ppParte)];
    $("pp-cliente").value = clientePorNome(escolhida.nome)?.nome || escolhida.nome;
    if (escolhida.polo) $("pp-polo").value = escolhida.polo;
    $("pp-contrarias").value = partes.filter((x) => x !== escolhida && (!escolhida.polo || x.polo !== escolhida.polo))
      .map((x) => x.nome).join("\n");
    document.querySelectorAll("[data-pp-parte]").forEach((x) => x.classList.toggle("marcada", x === b));
  });
}
