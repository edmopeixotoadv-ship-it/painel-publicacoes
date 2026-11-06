// Painel de publicações, agenda e atendimentos.
// Página pública, dados protegidos: só e-mails em usuarios_autorizados conseguem ler (regras no banco).
// A agenda grava pela função "agenda", que também atualiza o Google Agenda de cada responsável.
// A aba Atendimento fica em atendimento.js (fichas em fichas.js); Financeiro em financeiro.js;
// Permissões em permissoes.js. Cada pessoa tem um nível por área (regras no banco: public.nivel).

const SUPABASE_URL = "https://bmfpgicxosfshvbzntqo.supabase.co";
const SUPABASE_CHAVE_PUBLICA = "sb_publishable_F17uRoLf_Z8gR-xD0Nt7-g_qgW64XJn";
const POR_PAGINA = 50;
const FUSO = "America/Sao_Paulo";
const TIPOS = {
  prazo: "Prazo", audiencia: "Audiência", reuniao: "Reunião",
  atendimento: "Atendimento", sustentacao_oral: "Sustentação oral", distribuicao: "Distribuição", financeiro: "Financeiro", outro: "Outro",
};
const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const ABAS = ["publicacoes", "agenda", "atendimento", "processos", "financeiro", "permissoes"];

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_CHAVE_PUBLICA);
const $ = (id) => document.getElementById(id);

const estado = {
  eu: null,
  perfil: null,     // cadastro de quem está usando (com permissoes)
  equipe: [],       // pessoas ativas (responsáveis da agenda)
  pessoas: [],      // todas, inclusive desativadas
  publicacoes: [],
  compromissos: [],
  feriados: new Map(),
  situacao: "todas",
  visiveis: POR_PAGINA,
  visao: "lista",
  referencia: null,
  editando: null,
};

// ------------------------------------------------------------- utilidades

function avisar(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(avisar.tempo);
  avisar.tempo = setTimeout(() => (t.hidden = true), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function semAcento(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function dataBR(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

const formatoDia = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO });
const formatoHora = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });

function diaLocal(instante) { return formatoDia.format(new Date(instante)); }
function horaLocal(instante) { return formatoHora.format(new Date(instante)); }
function hoje() { return formatoDia.format(new Date()); }

function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function diaSemana(iso) { return new Date(`${iso}T12:00:00Z`).getUTCDay(); }

function nomeDia(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" });
}

function nomePessoa(email) {
  const p = estado.pessoas.find((e) => e.email === email);
  return p?.nome || email;
}

// ------------------------------------------------------------- login e carga

function mostrar(tela) {
  for (const t of ["tela-login", "tela-negado", ...ABAS.map((a) => `tela-${a}`)]) $(t).hidden = t !== tela;
}

// nível da pessoa logada na área (0 = não vê); as mesmas regras valem no banco
function pode(area, minimo = 1) {
  return Number(estado.perfil?.permissoes?.[area] ?? 0) >= minimo;
}

function aplicarPermissoes() {
  document.querySelectorAll(".abas a[data-aba]").forEach((a) => { a.hidden = !pode(a.dataset.aba); });
  $("ag-novo").hidden = !pode("agenda", 2);
  $("at-novo").hidden = !pode("atendimento", 2);
}

async function iniciar() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return mostrar("tela-login");
  const email = session.user.email.toLowerCase();
  estado.eu = email;
  $("usuario").textContent = email;
  $("sair").hidden = false;
  const { data: pessoas } = await sb.from("usuarios_autorizados").select("*").order("nome");
  const eu = pessoas?.find((e) => e.email === email);
  if (!eu?.ativo) {
    $("email-negado").textContent = email;
    return mostrar("tela-negado");
  }
  estado.perfil = eu;
  estado.pessoas = pessoas;
  estado.equipe = pessoas.filter((p) => p.ativo);
  $("usuario").textContent = eu.nome || email;
  $("abas").hidden = false;
  aplicarPermissoes();
  preencherFiltrosAgenda();
  mostrar(`tela-${abaAtual()}`);
  await Promise.all([
    pode("publicacoes") && carregarPublicacoes(),
    pode("agenda") && carregarAgenda(),
    (pode("atendimento") || pode("financeiro")) && carregarAtendimentos(),
    pode("financeiro") && carregarFinanceiro(),
    pode("processos") && carregarProcessos(),
    pode("permissoes", 3) && carregarPermissoes(),
  ]);
  rotear();
}

async function carregarPublicacoes() {
  $("lista").innerHTML = '<div class="vazio">Carregando…</div>';
  const { data, error } = await sb.from("publicacoes").select("*")
    .order("data", { ascending: false }).order("tribunal").limit(5000);
  if (error) {
    $("lista").innerHTML = `<div class="vazio">Não foi possível carregar: ${esc(error.message)}</div>`;
    return;
  }
  estado.publicacoes = data;
  const tribunais = [...new Set(data.map((p) => p.tribunal))].sort();
  $("f-tribunal").innerHTML = '<option value="">Todos os tribunais</option>' +
    tribunais.map((t) => `<option>${esc(t)}</option>`).join("");
  renderizarPublicacoes();
}

async function carregarAgenda() {
  const desde = somarDias(hoje(), -180);
  const [comps, feriados] = await Promise.all([
    sb.from("compromissos").select("*, compromisso_responsaveis(email, google_event_id)")
      .gte("inicio", `${desde}T00:00:00-03:00`).order("inicio").limit(5000),
    sb.from("feriados").select("*"),
  ]);
  if (comps.error) {
    $("ag-conteudo").innerHTML = `<div class="vazio">Não foi possível carregar a agenda: ${esc(comps.error.message)}</div>`;
    return;
  }
  estado.compromissos = comps.data;
  estado.feriados = new Map((feriados.data || []).map((f) => [f.data, f]));
  renderizarAgenda();
  renderizarPublicacoes();
}

function abaAtual() {
  const aba = location.hash.replace(/^#/, "").split("/")[0];
  const permitidas = ABAS.filter((a) => pode(a, a === "permissoes" ? 3 : 1));
  if (permitidas.includes(aba)) return aba;
  return permitidas[0] || "publicacoes";
}

function rotear() {
  const [, id, extra] = location.hash.replace(/^#/, "").split("/");
  const aba = abaAtual();
  // quem sai de uma ficha com alterações não perde nada: grava antes de trocar de tela
  if (fichaAlterada() && !(aba === "atendimento" && id === at.ficha.atendimento.id)) salvarFicha();
  if (estado.eu && estado.equipe.length) mostrar(`tela-${aba}`);
  if (aba !== "agenda" && $("dlg").open) $("dlg").close();
  if (!["financeiro", "permissoes", "processos"].includes(aba) && $("dlg-fin").open) $("dlg-fin").close();
  document.querySelectorAll(".abas a").forEach((a) => {
    if (a.dataset.aba === aba) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (aba === "agenda" && id) {
    const c = estado.compromissos.find((x) => x.id === id);
    if (c) abrirFormulario(c);
  }
  if (aba === "atendimento") rotearAtendimento(id, extra);
  if (aba === "financeiro") rotearFinanceiro(id, extra);
  if (aba === "processos") rotearProcessos(id);
  if (aba === "permissoes") renderizarPermissoes();
}

// ------------------------------------------------------------- publicações

function publicacoesFiltradas() {
  const texto = semAcento($("f-texto").value.trim());
  const tribunal = $("f-tribunal").value;
  const de = $("f-de").value, ate = $("f-ate").value;
  return estado.publicacoes.filter((p) => {
    if (estado.situacao === "nao-lidas" && p.lida) return false;
    if (estado.situacao === "pendentes" && p.providenciada) return false;
    if (estado.situacao === "providenciadas" && !p.providenciada) return false;
    if (tribunal && p.tribunal !== tribunal) return false;
    if (de && (p.data || "") < de) return false;
    if (ate && (p.data || "") > ate) return false;
    if (texto) {
      const alvo = semAcento([p.processo, p.orgao, p.classe, p.tipo, (p.partes || []).join(" "), p.texto, p.observacao].join(" "));
      if (!texto.split(/\s+/).every((t) => alvo.includes(t))) return false;
    }
    return true;
  });
}

function renderizarPublicacoes() {
  const pubs = estado.publicacoes;
  $("n-nao-lidas").textContent = pubs.filter((p) => !p.lida).length;
  $("n-pendentes").textContent = pubs.filter((p) => !p.providenciada).length;
  $("n-providenciadas").textContent = pubs.filter((p) => p.providenciada).length;
  $("n-todas").textContent = pubs.length;
  document.querySelectorAll(".cartao-num").forEach((b) => b.setAttribute("aria-pressed", b.dataset.situacao === estado.situacao));

  const lista = publicacoesFiltradas();
  $("contagem").textContent = `${lista.length} publicação(ões) encontrada(s)`;
  if (!lista.length) {
    $("lista").innerHTML = '<div class="vazio">Nenhuma publicação com esses filtros.</div>';
    $("mais").hidden = true;
    return;
  }
  $("lista").innerHTML = lista.slice(0, estado.visiveis).map(cartaoPublicacao).join("");
  $("mais").hidden = lista.length <= estado.visiveis;
}

function cartaoPublicacao(p) {
  const classes = ["pub", p.lida ? "lida" : "", p.providenciada ? "providenciada" : ""].join(" ");
  const selo = p.providenciada ? '<span class="selo-ok">Providenciada</span>' : (!p.lida ? '<span class="selo-nova">Nova</span>' : "");
  const agendados = estado.compromissos.filter((c) => c.publicacao_chave === p.chave && c.situacao !== "cancelado");
  const seloAgenda = agendados.length
    ? `<button class="selo-agenda" data-abrir="${esc(agendados[0].id)}">📅 ${agendados.length === 1 ? dataBR(diaLocal(agendados[0].inicio)) : `${agendados.length} compromissos`}</button>`
    : "";
  const marca = pode("publicacoes", 2) ? "" : "disabled";
  const quem = p.atualizado_por ? `Última marcação: ${esc(nomePessoa(p.atualizado_por))} em ${new Date(p.atualizado_em).toLocaleString("pt-BR")}` : "";
  return `
  <article class="${classes}" data-chave="${esc(p.chave)}">
    <div class="pub-cab">
      <div class="pub-info">
        <div class="linha1"><span class="tribunal">${esc(p.tribunal)}</span><span>${dataBR(p.data)}</span>${p.tipo ? `<span>${esc(p.tipo)}</span>` : ""}${selo}${seloAgenda}</div>
        <div class="processo">${esc(p.processo || "Sem número de processo")}${p.processo ? `<button data-copiar="${esc(p.processo)}" aria-label="Copiar número do processo">copiar</button>` : ""}</div>
        <div class="orgao">${esc([p.orgao, p.classe].filter(Boolean).join(" · "))}</div>
        ${p.partes?.length ? `<div class="partes">${esc(p.partes.join("; "))}</div>` : ""}
      </div>
      <div class="acoes">
        <label><input type="checkbox" data-campo="lida" ${p.lida ? "checked" : ""} ${marca}> Lida</label>
        <label><input type="checkbox" data-campo="providenciada" ${p.providenciada ? "checked" : ""} ${marca}> Providenciada</label>
        ${pode("agenda", 2) ? `<button class="botao-sec" data-agendar="${esc(p.chave)}">📅 Agendar</button>` : ""}
        ${linkProcesso(p.processo)}
      </div>
    </div>
    <details>
      <summary>Ver teor e anotações</summary>
      <div class="corpo">
        <div class="teor">${esc(p.texto || "(sem texto)")}</div>
        <div class="meta">
          ${p.advogados?.length ? `Advogados: ${esc(p.advogados.join("; "))}<br>` : ""}
          Fonte: ${esc(p.fonte || "")}${p.link ? ` · <a href="${esc(p.link)}" target="_blank" rel="noopener">abrir no tribunal</a>` : ""}
        </div>
        <label class="meta" for="obs-${esc(p.chave)}">Anotações da equipe</label>
        <textarea class="obs" id="obs-${esc(p.chave)}" data-campo="observacao" ${marca} placeholder="Ex.: prazo de 15 dias úteis, peça protocolada em…">${esc(p.observacao || "")}</textarea>
        <div class="quem">${quem}</div>
      </div>
    </details>
  </article>`;
}

function linkProcesso(numero) {
  if (typeof proc === "undefined" || !proc.carregado || !pode("processos")) return "";
  const p = processoPorNumero(numero);
  return p ? `<a class="botao-sec" href="#processos/${esc(p.id)}">📁 Processo${p.revisar ? " (a revisar)" : ""}</a>` : "";
}

async function salvarMarcacao(chave, campo, valor) {
  const { data, error } = await sb.from("publicacoes").update({ [campo]: valor }).eq("chave", chave)
    .select("chave, lida, providenciada, observacao, atualizado_por, atualizado_em").single();
  if (error) { avisar("Não foi possível salvar. Tente de novo."); return false; }
  Object.assign(estado.publicacoes.find((p) => p.chave === chave), data);
  return true;
}

// ------------------------------------------------------------- agenda: listagem

function preencherFiltrosAgenda() {
  const opcoes = (lista) => lista.map(([v, r]) => `<option value="${v}">${r}</option>`).join("");
  const visiveis = Object.entries(TIPOS).filter(([v]) => v !== "financeiro" || pode("financeiro"));
  $("ag-tipo").innerHTML = '<option value="">Todos os tipos</option>' + opcoes(visiveis);
  $("c-tipo").innerHTML = opcoes(visiveis.filter(([v]) => v !== "financeiro"));
  $("ag-responsavel").innerHTML = '<option value="">Todos os responsáveis</option>' +
    estado.equipe.map((p) => `<option value="${esc(p.email)}">${esc(p.nome || p.email)}</option>`).join("");
}

function compromissosFiltrados() {
  const tipo = $("ag-tipo").value;
  const situacao = $("ag-situacao").value;
  const responsavel = $("ag-meus").checked ? estado.eu : $("ag-responsavel").value;
  return estado.compromissos.filter((c) => {
    if (tipo && c.tipo !== tipo) return false;
    if (situacao && c.situacao !== situacao) return false;
    if (responsavel && !(c.compromisso_responsaveis || []).some((r) => r.email === responsavel)) return false;
    return true;
  });
}

function periodo() {
  const ref = estado.referencia || hoje();
  if (estado.visao === "lista") return { de: ref, ate: somarDias(ref, 30) };
  if (estado.visao === "semana") {
    const de = somarDias(ref, -diaSemana(ref));
    return { de, ate: somarDias(de, 6) };
  }
  const primeiro = `${ref.slice(0, 7)}-01`;
  const de = somarDias(primeiro, -diaSemana(primeiro));
  return { de, ate: somarDias(de, 41), mes: ref.slice(0, 7) };
}

function rotuloPeriodo(p) {
  if (estado.visao === "mes") {
    return new Date(`${p.mes}-15T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  }
  if (estado.visao === "semana") return `${dataBR(p.de)} a ${dataBR(p.ate)}`;
  return `Próximos 30 dias a partir de ${dataBR(p.de)}`;
}

function horario(c) {
  if (c.dia_inteiro) return "Dia inteiro";
  return c.fim ? `${horaLocal(c.inicio)}–${horaLocal(c.fim)}` : horaLocal(c.inicio);
}

function itemCompromisso(c) {
  const resp = (c.compromisso_responsaveis || []).map((r) => nomePessoa(r.email)).join(", ");
  const sub = [c.processo, c.local, resp && `Resp.: ${resp}`].filter(Boolean).map(esc).join(" · ");
  return `
  <button class="comp ${c.situacao}" style="--cor: var(--t-${c.tipo})" data-abrir="${esc(c.id)}">
    <span class="comp-hora">${horario(c)}</span>
    <span class="comp-info">
      <span class="comp-titulo"><span class="etiqueta">${TIPOS[c.tipo]}</span>${esc(c.titulo)}</span>
      ${sub ? `<span class="comp-sub" style="display:block">${sub}</span>` : ""}
      ${c.google_erro ? `<span class="alerta-google" style="display:block">⚠ Google Agenda: ${esc(c.google_erro)}</span>` : ""}
    </span>
  </button>`;
}

function chip(c) {
  return `<button class="chip ${c.situacao}" style="--cor: var(--t-${c.tipo})" data-abrir="${esc(c.id)}" title="${esc(`${TIPOS[c.tipo]} · ${horario(c)} · ${c.titulo}`)}">${c.dia_inteiro ? "" : `${horaLocal(c.inicio)} `}${esc(c.titulo)}</button>`;
}

function renderizarAgenda() {
  document.querySelectorAll("[data-visao]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.visao === estado.visao));
  const p = periodo();
  $("ag-periodo").textContent = rotuloPeriodo(p);
  const todos = compromissosFiltrados();
  const porDia = new Map();
  for (const c of todos) {
    const d = diaLocal(c.inicio);
    if (!porDia.has(d)) porDia.set(d, []);
    porDia.get(d).push(c);
  }
  const dHoje = hoje();

  const atrasados = estado.compromissos.filter((c) => c.situacao === "pendente" && diaLocal(c.inicio) < dHoje &&
    (!$("ag-meus").checked || (c.compromisso_responsaveis || []).some((r) => r.email === estado.eu)));
  $("ag-atrasados").innerHTML = atrasados.length
    ? `<div class="atrasados"><h3>⚠ ${atrasados.length} compromisso(s) vencido(s) ainda pendente(s)</h3>${atrasados.map((c) =>
        itemCompromisso({ ...c, titulo: `${c.titulo} (${dataBR(diaLocal(c.inicio))})` })).join("")}</div>`
    : "";

  if (estado.visao === "lista") {
    const dias = [...porDia.keys()].filter((d) => d >= p.de && d <= p.ate).sort();
    $("ag-conteudo").innerHTML = dias.length
      ? dias.map((d) => `<div class="dia ${d === dHoje ? "hoje" : ""}"><h3>${d === dHoje ? "Hoje · " : ""}${nomeDia(d)}</h3>${porDia.get(d).map(itemCompromisso).join("")}</div>`).join("")
      : '<div class="vazio">Nenhum compromisso neste período.</div>';
    return;
  }

  const total = estado.visao === "semana" ? 7 : 42;
  let html = DIAS_SEMANA.map((d) => `<div class="cab">${d}</div>`).join("");
  for (let i = 0; i < total; i++) {
    const d = somarDias(p.de, i);
    const classes = ["celula", d === dHoje ? "hoje" : "", p.mes && d.slice(0, 7) !== p.mes ? "fora" : ""].join(" ");
    const itens = porDia.get(d) || [];
    const feriado = estado.feriados.get(d);
    const titulo = estado.visao === "semana" ? `${DIAS_SEMANA[diaSemana(d)]} ${dataBR(d).slice(0, 5)}` : String(Number(d.slice(8)));
    html += `<div class="${classes}"><span class="num">${titulo}</span>` +
      (feriado ? `<span class="feriado" title="${esc(feriado.descricao)}">${esc(feriado.descricao)}</span>` : "") +
      `${itens.map(chip).join("")}</div>`;
  }
  $("ag-conteudo").innerHTML = `<div class="grade ${estado.visao}">${html}</div>`;
}

function navegar(sentido) {
  const ref = estado.referencia || hoje();
  if (estado.visao === "lista") estado.referencia = somarDias(ref, 30 * sentido);
  else if (estado.visao === "semana") estado.referencia = somarDias(ref, 7 * sentido);
  else {
    const d = new Date(`${ref.slice(0, 7)}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + sentido);
    estado.referencia = d.toISOString().slice(0, 10);
  }
  renderizarAgenda();
}

// ------------------------------------------------------------- cálculo de prazo (sugestão)

function emRecesso(iso) {
  const md = iso.slice(5);
  return md >= "12-20" || md <= "01-20"; // CPC, art. 220
}

function motivoNaoUtil(iso, forense) {
  const ds = diaSemana(iso);
  if (ds === 0 || ds === 6) return "fim de semana";
  const f = estado.feriados.get(iso);
  if (f && (f.abrangencia !== "forense" || forense)) return f.descricao;
  if (emRecesso(iso)) return "recesso forense (20/12 a 20/01)";
  return null;
}

function proximoUtil(iso, forense) {
  let d = somarDias(iso, 1);
  while (motivoNaoUtil(d, forense)) d = somarDias(d, 1);
  return d;
}

function calcularPrazo(disponibilizacao, dias, modo, forense) {
  const publicacao = proximoUtil(disponibilizacao, forense); // Lei 11.419/2006, art. 4º, § 3º
  const inicio = proximoUtil(publicacao, forense); // CPC, art. 224, § 3º
  const pulados = [];
  let d = inicio, contados = 1;
  while (contados < dias) {
    d = somarDias(d, 1);
    const motivo = modo === "uteis" ? motivoNaoUtil(d, forense) : (emRecesso(d) ? "recesso forense (20/12 a 20/01)" : null);
    if (motivo) { if (motivo !== "fim de semana") pulados.push([d, motivo]); }
    else contados++;
  }
  let final = d;
  while (motivoNaoUtil(final, forense)) { // CPC, art. 224, § 1º
    const motivo = motivoNaoUtil(final, forense);
    if (motivo !== "fim de semana") pulados.push([final, motivo]);
    final = somarDias(final, 1);
  }
  const ultimoFeriado = [...estado.feriados.keys()].sort().pop() || "";
  return { publicacao, inicio, final, pulados, foraDaTabela: final > ultimoFeriado };
}

function mostrarCalculo() {
  const disp = $("k-disp").value, dias = Number($("k-dias").value);
  if (!disp || !dias) { avisar("Informe a data de disponibilização e o número de dias."); return; }
  const r = calcularPrazo(disp, dias, $("k-modo").value, $("k-forense").checked);
  $("c-data").value = r.final;
  $("c-dia-inteiro").checked = true;
  atualizarHorarios();
  const recesso = r.pulados.filter(([, m]) => m.startsWith("recesso")).map(([d]) => d);
  const itens = r.pulados.filter(([, m]) => !m.startsWith("recesso")).map(([d, m]) => `${dataBR(d).slice(0, 5)} (${esc(m)})`);
  if (recesso.length) itens.push(`recesso forense de ${dataBR(recesso[0]).slice(0, 5)} a ${dataBR(recesso[recesso.length - 1]).slice(0, 5)}`);
  const pulados = itens.length ? `<br>Dias não contados: ${itens.join(", ")}.` : "";
  $("k-resultado").hidden = false;
  $("k-resultado").innerHTML =
    `Publicação considerada em ${dataBR(r.publicacao)}; contagem a partir de ${dataBR(r.inicio)}.<br>` +
    `<strong>Data final sugerida: ${dataBR(r.final)} (${nomeDia(r.final).split(",")[0]})</strong>${pulados}<br>` +
    (r.foraDaTabela ? "⚠ A data passa do último feriado cadastrado; confira o calendário. " : "") +
    "Confira feriados locais e suspensões de expediente do tribunal antes de confirmar.";
}

// ------------------------------------------------------------- agenda: formulário

function atualizarHorarios() {
  const inteiro = $("c-dia-inteiro").checked;
  $("c-hora-ini").disabled = inteiro;
  $("c-hora-fim").disabled = inteiro;
}

function atualizarTipo() {
  $("calc").hidden = $("c-tipo").value !== "prazo";
}

function abrirFormulario(c) {
  estado.editando = c?.id ? c : null;
  const novo = !c?.id;
  // vencimento do financeiro: o tipo aparece só para ele; edita-se pelo lançamento
  const tipoFin = c?.tipo === "financeiro";
  [...$("c-tipo").options].forEach((o) => { if (o.value === "financeiro") o.remove(); });
  if (tipoFin) $("c-tipo").insertAdjacentHTML("beforeend", '<option value="financeiro">Financeiro</option>');
  $("c-tipo").disabled = tipoFin;
  $("c-salvar").hidden = !(tipoFin ? pode("financeiro", 2) : pode("agenda", 2));
  $("dlg-titulo").textContent = novo ? "Novo compromisso" : "Editar compromisso";
  $("c-tipo").value = c?.tipo || "prazo";
  $("c-situacao").value = c?.situacao || "pendente";
  $("c-titulo").value = c?.titulo || "";
  $("c-data").value = c?.inicio ? diaLocal(c.inicio) : (c?.data || "");
  $("c-dia-inteiro").checked = c ? !!c.dia_inteiro : true;
  $("c-hora-ini").value = c?.inicio && !c.dia_inteiro ? horaLocal(c.inicio) : "";
  $("c-hora-fim").value = c?.fim && !c.dia_inteiro ? horaLocal(c.fim) : "";
  $("c-local").value = c?.local || "";
  $("c-processo").value = c?.processo || "";
  $("c-descricao").value = c?.descricao || "";
  $("c-vinculo").dataset.chave = c?.publicacao_chave || "";
  const pub = c?.publicacao_chave && estado.publicacoes.find((p) => p.chave === c.publicacao_chave);
  const atend = c?.id && at.lista.find((a) => a.compromisso_id === c.id);
  const lanc = tipoFin && fin.lancamentos.find((l) => l.compromisso_id === c.id);
  $("c-vinculo").hidden = !pub && !atend && !lanc;
  if (pub) {
    $("c-vinculo").innerHTML = `Vinculado à publicação de ${dataBR(pub.data)} · ${esc(pub.tribunal)} · ${esc(pub.processo || "")} ` +
      `<a href="#publicacoes" data-ver-pub="${esc(pub.chave)}">ver publicação</a>`;
  } else if (atend) {
    $("c-vinculo").innerHTML = `Vinculado ao atendimento de ${dataBR(atend.data_atendimento)} · ${esc(tituloAtendimento(atend))} ` +
      `<a href="#atendimento/${esc(atend.id)}">abrir ficha</a>` +
      (atend.situacao === "aguardando_distribuicao" ? " · registre a distribuição pela ficha, com o número do processo" : "");
  } else if (lanc) {
    $("c-vinculo").innerHTML = `Vencimento do financeiro · ${esc(lanc.descricao)} · ${moeda(lanc.valor)} ` +
      `<a href="#financeiro/lancamento/${esc(lanc.id)}">abrir lançamento</a> · data e situação mudam pelo lançamento`;
  }
  $("k-disp").value = pub?.data || "";
  $("k-resultado").hidden = true;
  const marcados = c?.compromisso_responsaveis ? c.compromisso_responsaveis.map((r) => r.email) : [estado.eu];
  $("c-responsaveis").innerHTML = estado.equipe.map((p) =>
    `<label class="check"><input type="checkbox" value="${esc(p.email)}" ${marcados.includes(p.email) ? "checked" : ""}> ${esc(p.nome || p.email)}</label>`).join("");
  const g = $("c-google");
  g.hidden = novo;
  if (!novo) {
    g.className = c.google_erro ? "google erro" : "google";
    g.textContent = c.google_erro
      ? `Google Agenda: ${c.google_erro}`
      : `Google Agenda atualizado em ${new Date(c.google_sincronizado_em).toLocaleString("pt-BR")}`;
  }
  $("c-quem").textContent = novo ? "" :
    `Criado por ${nomePessoa(c.criado_por)} em ${new Date(c.criado_em).toLocaleString("pt-BR")}` +
    (c.atualizado_por ? ` · última alteração: ${nomePessoa(c.atualizado_por)} em ${new Date(c.atualizado_em).toLocaleString("pt-BR")}` : "");
  $("c-cumprido").hidden = novo || c.situacao !== "pendente" || tipoFin || !pode("agenda", 2);
  atualizarTipo();
  atualizarHorarios();
  if (!$("dlg").open) $("dlg").showModal();
}

function dadosFormulario() {
  const data = $("c-data").value;
  const inteiro = $("c-dia-inteiro").checked;
  const ini = $("c-hora-ini").value || "09:00";
  const fim = $("c-hora-fim").value;
  if (!inteiro && fim && fim <= ini) throw new Error("O horário de fim deve ser depois do início.");
  return {
    id: estado.editando?.id,
    tipo: $("c-tipo").value,
    situacao: $("c-situacao").value,
    titulo: $("c-titulo").value.trim(),
    dia_inteiro: inteiro,
    inicio: inteiro ? `${data}T00:00:00-03:00` : `${data}T${ini}:00-03:00`,
    fim: inteiro || !fim ? null : `${data}T${fim}:00-03:00`,
    local: $("c-local").value.trim(),
    processo: $("c-processo").value.trim(),
    publicacao_chave: $("c-vinculo").dataset.chave || null,
    descricao: $("c-descricao").value.trim(),
  };
}

async function salvarCompromisso(extra = {}) {
  let compromisso;
  try { compromisso = { ...dadosFormulario(), ...extra }; } catch (e) { avisar(e.message); return; }
  const responsaveis = [...$("c-responsaveis").querySelectorAll("input:checked")].map((i) => i.value);
  if (!responsaveis.length) { avisar("Escolha pelo menos um responsável."); return; }
  $("c-salvar").disabled = true;
  const { data, error } = await sb.functions.invoke("agenda", { body: { compromisso, responsaveis } });
  $("c-salvar").disabled = false;
  if (error || !data?.compromisso) {
    let msg = "Não foi possível salvar.";
    try { msg = (await error.context.json()).erro || msg; } catch { /* resposta sem corpo */ }
    avisar(msg, 4000);
    return;
  }
  const salvo = data.compromisso;
  const i = estado.compromissos.findIndex((c) => c.id === salvo.id);
  if (i >= 0) estado.compromissos[i] = salvo; else estado.compromissos.push(salvo);
  estado.compromissos.sort((a, b) => a.inicio.localeCompare(b.inicio));
  $("dlg").close();
  if (location.hash.startsWith("#agenda/")) history.replaceState(null, "", "#agenda");
  renderizarAgenda();
  renderizarPublicacoes();
  if (abaAtual() === "processos") renderizarProcessos();
  avisar(salvo.google_erro ? `Salvo. Atenção — Google Agenda: ${salvo.google_erro}` : "Compromisso salvo e enviado ao Google Agenda.", 4500);
}

// ------------------------------------------------------------- eventos

$("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim().toLowerCase();
  const aviso = $("aviso-login");
  aviso.hidden = false;
  aviso.textContent = "Enviando…";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  aviso.textContent = error
    ? "Não foi possível enviar o link. Confira se o e-mail está cadastrado na equipe ou aguarde um minuto e tente de novo."
    : `Pronto! Abra o e-mail enviado para ${email} e clique no link de acesso.`;
});

for (const id of ["sair", "sair-negado"]) {
  $(id).addEventListener("click", async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); });
}

document.querySelectorAll(".cartao-num").forEach((b) => b.addEventListener("click", () => {
  estado.situacao = b.dataset.situacao; estado.visiveis = POR_PAGINA; renderizarPublicacoes();
}));
for (const id of ["f-texto", "f-tribunal", "f-de", "f-ate"]) {
  $(id).addEventListener("input", () => { estado.visiveis = POR_PAGINA; renderizarPublicacoes(); });
}
$("f-limpar").addEventListener("click", () => {
  for (const id of ["f-texto", "f-tribunal", "f-de", "f-ate"]) $(id).value = "";
  estado.situacao = "todas"; estado.visiveis = POR_PAGINA; renderizarPublicacoes();
});
$("mais").addEventListener("click", () => { estado.visiveis += POR_PAGINA; renderizarPublicacoes(); });

$("lista").addEventListener("change", async (e) => {
  const campo = e.target.dataset.campo;
  const art = e.target.closest("article");
  if (!campo || !art) return;
  const valor = campo === "observacao" ? e.target.value.trim() || null : e.target.checked;
  if (await salvarMarcacao(art.dataset.chave, campo, valor)) {
    if (campo === "providenciada" && valor) await salvarMarcacao(art.dataset.chave, "lida", true);
    avisar(campo === "observacao" ? "Anotação salva" : "Marcação salva");
    if (campo !== "observacao") renderizarPublicacoes();
    else art.querySelector(".quem").textContent = "Salvo agora";
  } else if (campo !== "observacao") {
    e.target.checked = !valor;
  }
});

$("lista").addEventListener("click", async (e) => {
  const alvo = e.target.closest("[data-copiar], [data-agendar], [data-abrir]");
  if (!alvo) return;
  if (alvo.dataset.copiar) {
    try { await navigator.clipboard.writeText(alvo.dataset.copiar); avisar("Número copiado"); } catch { avisar(alvo.dataset.copiar); }
  } else if (alvo.dataset.agendar) {
    const p = estado.publicacoes.find((x) => x.chave === alvo.dataset.agendar);
    abrirFormulario({
      tipo: "prazo", dia_inteiro: true, processo: p.processo, publicacao_chave: p.chave,
      titulo: `Prazo — ${p.tipo || "intimação"} (${p.tribunal})`,
    });
  } else {
    location.hash = `#agenda/${alvo.dataset.abrir}`;
  }
});

document.querySelectorAll("[data-visao]").forEach((b) => b.addEventListener("click", () => {
  estado.visao = b.dataset.visao; renderizarAgenda();
}));
$("ag-anterior").addEventListener("click", () => navegar(-1));
$("ag-proximo").addEventListener("click", () => navegar(1));
$("ag-hoje").addEventListener("click", () => { estado.referencia = null; renderizarAgenda(); });
$("ag-novo").addEventListener("click", () => abrirFormulario(null));
for (const id of ["ag-meus", "ag-tipo", "ag-situacao", "ag-responsavel"]) $(id).addEventListener("change", renderizarAgenda);
for (const id of ["ag-conteudo", "ag-atrasados"]) {
  $(id).addEventListener("click", (e) => {
    const alvo = e.target.closest("[data-abrir]");
    if (alvo) location.hash = `#agenda/${alvo.dataset.abrir}`;
  });
}

$("c-tipo").addEventListener("change", atualizarTipo);
$("c-dia-inteiro").addEventListener("change", atualizarHorarios);
$("k-calcular").addEventListener("click", mostrarCalculo);
$("form-comp").addEventListener("submit", (e) => { e.preventDefault(); salvarCompromisso(); });
$("c-cumprido").addEventListener("click", () => { $("c-situacao").value = "cumprido"; salvarCompromisso(); });
for (const id of ["c-cancelar", "dlg-fechar"]) $(id).addEventListener("click", () => $("dlg").close());
$("dlg").addEventListener("close", () => {
  if (location.hash.startsWith("#agenda/")) history.replaceState(null, "", "#agenda");
});
$("c-vinculo").addEventListener("click", (e) => {
  const chave = e.target.dataset?.verPub;
  if (!chave) return;
  $("dlg").close();
  const p = estado.publicacoes.find((x) => x.chave === chave);
  $("f-texto").value = p?.processo || "";
  estado.situacao = "todas";
  renderizarPublicacoes();
});

window.addEventListener("hashchange", rotear);
prepararAtendimento();
prepararFinanceiro();
prepararPermissoes();
prepararProcessos();
sb.auth.onAuthStateChange((evento) => { if (evento === "SIGNED_IN" && !estado.eu) iniciar(); });
iniciar();
