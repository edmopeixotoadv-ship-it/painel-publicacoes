// Aba Tarefas: pendências da equipe em quadro (A fazer, Fazendo, Aguardando, Concluídas) ou lista.
// Histórico, data de conclusão e a próxima ocorrência das tarefas repetidas ficam a cargo do banco.
// Níveis: tarefas 1 vê, 2 edita. Lembrete opcional na agenda (função "agenda", tipo "outro").
// Usa app.js, financeiro.js (abrirDialogo, opcoes...) e processos.js (proc, dig).

const SITUACOES_TF = { a_fazer: "A fazer", fazendo: "Fazendo", aguardando: "Aguardando", concluida: "Concluídas" };
const PRIORIDADES = { urgente: "Urgente", alta: "Alta", normal: "Normal" };
const REPETICOES = { nao: "Não repete", semanal: "Toda semana", mensal: "Todo mês" };
const DIAS_CONCLUIDAS = 30; // concluídas somem do quadro depois disso (continuam na lista e na busca)

const tf = { lista: [], carregado: false, escopo: "minhas", visao: "quadro", verConcluidas: false, editando: null };

const ordemPrioridade = { urgente: 0, alta: 1, normal: 2 };
const tfAtrasada = (t) => t.situacao !== "concluida" && t.prazo && t.prazo < hoje();
const minha = (t) => (t.responsaveis || []).includes(estado.eu);

async function carregarTarefas() {
  const r = await lerTudo(() => sb.from("tarefas").select("*").order("criado_em").order("id"));
  if (r.error) {
    $("tf-conteudo").innerHTML = `<div class="vazio">Não foi possível carregar as tarefas: ${esc(r.error.message)}</div>`;
    return;
  }
  tf.lista = r.data;
  tf.carregado = true;
  const resp = $("tf-resp").value;
  $("tf-resp").innerHTML = '<option value="">Todos os responsáveis</option>' +
    estado.equipe.map((x) => `<option value="${esc(x.email)}">${esc(x.nome || x.email)}</option>`).join("");
  $("tf-resp").value = resp;
  renderizarTarefas();
}

function processoDaTarefa(t) {
  return t.processo_id && typeof proc !== "undefined" ? proc.lista.find((p) => p.id === t.processo_id) : null;
}

function vinculoTarefa(t) {
  const p = processoDaTarefa(t);
  if (p) return `<a href="#processos/${esc(p.id)}" title="${esc(p.numero)}">Proc. ${esc(p.numero.slice(0, 15))}…${p.cliente_nome ? ` · ${esc(p.cliente_nome)}` : ""}</a>`;
  if (t.cliente_nome) return `<span>${esc(t.cliente_nome)}</span>`;
  return '<span>interna</span>';
}

function iniciais(email) {
  const n = nomePessoa(email) || "?";
  return n.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();
}

function tarefasFiltradas() {
  const busca = normalizarNome($("tf-busca").value);
  const resp = $("tf-resp").value, prio = $("tf-prio").value, vinc = $("tf-vinc").value;
  return tf.lista.filter((t) => {
    if (tf.escopo === "minhas" && !minha(t)) return false;
    if (resp && !(t.responsaveis || []).includes(resp)) return false;
    if (prio && t.prioridade !== prio) return false;
    if (vinc === "processo" && !t.processo_id) return false;
    if (vinc === "cliente" && !t.cliente_nome) return false;
    if (vinc === "interna" && (t.processo_id || t.cliente_nome)) return false;
    if (busca) {
      const p = processoDaTarefa(t);
      const alvo = normalizarNome([t.titulo, t.descricao, t.cliente_nome, p?.numero, p?.cliente_nome].join(" "));
      if (!busca.split(" ").every((x) => alvo.includes(x))) return false;
    }
    return true;
  });
}

function ordenar(lista) {
  return lista.sort((a, b) => ordemPrioridade[a.prioridade] - ordemPrioridade[b.prioridade] ||
    (a.prazo || "9999").localeCompare(b.prazo || "9999") || a.criado_em.localeCompare(b.criado_em));
}

function cartaoTarefa(t) {
  const itens = t.itens || [];
  const feitos = itens.filter((i) => i.feito).length;
  const prazo = t.prazo ? (tfAtrasada(t) ? `<span class="selo-at atrasado">venceu ${dataBR(t.prazo).slice(0, 5)}</span>`
    : t.situacao === "concluida" ? "" : `<span class="selo-at ${t.prazo === hoje() ? "aguardando_distribuicao" : ""}">${t.prazo === hoje() ? "hoje" : `até ${dataBR(t.prazo).slice(0, 5)}`}</span>`) : "";
  const concl = t.situacao === "concluida" && t.concluida_em ? `<span>${dataBR(diaLocal(t.concluida_em)).slice(0, 5)} · ${esc(nomePessoa(t.concluida_por))}</span>` : "";
  return `
  <div class="tarefa ${t.prioridade} ${t.situacao === "concluida" ? "feita" : ""}" draggable="${pode("tarefas", 2)}" data-tf="${esc(t.id)}">
    <b>${esc(t.titulo)}</b>
    <div class="meta">${prazo}${concl}
      ${(t.responsaveis || []).map((e) => `<span class="av" title="${esc(nomePessoa(e))}">${esc(iniciais(e))}</span>`).join("")}
      ${vinculoTarefa(t)}${t.repetir !== "nao" ? `<span title="${REPETICOES[t.repetir]}">🔁</span>` : ""}${t.compromisso_id ? "<span>📅</span>" : ""}</div>
    ${itens.length ? `<div class="check-mini">☑ ${feitos} de ${itens.length} itens</div>` : ""}
    ${pode("tarefas", 2) && t.situacao !== "concluida" ? `<div class="tf-acoes">
      <select data-tf-mover="${esc(t.id)}" aria-label="Mover para">${Object.entries(SITUACOES_TF).map(([v, r]) =>
        `<option value="${v}" ${v === t.situacao ? "selected" : ""}>${v === t.situacao ? "mover…" : r}</option>`).join("")}</select>
      <button class="botao-sec mini" data-tf-concluir="${esc(t.id)}" title="Concluir">✓</button></div>` : ""}
  </div>`;
}

function renderizarTarefas() {
  if (!tf.carregado) return;
  const agora = hoje(), semana = somarDias(agora, 7), mes = agora.slice(0, 7);
  const minhasAbertas = tf.lista.filter((t) => minha(t) && t.situacao !== "concluida");
  $("tf-n-abertas").textContent = minhasAbertas.length;
  $("tf-n-atrasadas").textContent = minhasAbertas.filter(tfAtrasada).length;
  $("tf-n-semana").textContent = minhasAbertas.filter((t) => t.prazo && t.prazo >= agora && t.prazo <= semana).length;
  $("tf-n-concluidas").textContent = tf.lista.filter((t) => t.concluida_em && diaLocal(t.concluida_em).startsWith(mes) &&
    (tf.escopo === "equipe" || t.concluida_por === estado.eu || minha(t))).length;
  document.querySelectorAll("[data-tf-escopo]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tfEscopo === tf.escopo));
  document.querySelectorAll("[data-tf-visao]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tfVisao === tf.visao));
  $("tf-nova").hidden = !pode("tarefas", 2);
  atualizarContadorTarefas();

  const lista = tarefasFiltradas();
  const limite = somarDias(agora, -DIAS_CONCLUIDAS);
  if (tf.visao === "quadro") {
    $("tf-conteudo").innerHTML = `<div class="quadro">${Object.entries(SITUACOES_TF).map(([sit, rot]) => {
      let col = lista.filter((t) => t.situacao === sit);
      const quando = (t) => t.concluida_em || t.atualizado_em || t.criado_em;
      const ocultas = sit === "concluida" ? col.filter((t) => diaLocal(quando(t)) < limite).length : 0;
      if (sit === "concluida") col = col.filter((t) => diaLocal(quando(t)) >= limite)
        .sort((a, b) => quando(b).localeCompare(quando(a)));
      else col = ordenar(col);
      return `<div class="coluna" data-tf-coluna="${sit}"><h3>${rot} <span>${col.length}</span></h3>
        ${col.map(cartaoTarefa).join("") || '<div class="vazio pequeno">—</div>'}
        ${ocultas ? `<button class="botao-sec mini" data-tf-ver-concluidas>ver mais ${ocultas} na lista</button>` : ""}</div>`;
    }).join("")}</div>
    ${pode("tarefas", 2) ? '<p class="at-sub">Arraste os cartões entre as colunas ou use “mover…” no cartão.</p>' : ""}`;
  } else {
    const abertas = ordenar(lista.filter((t) => t.situacao !== "concluida"));
    const concluidas = lista.filter((t) => t.situacao === "concluida").sort((a, b) => (b.concluida_em || "").localeCompare(a.concluida_em || ""));
    const linha = (t) => `<tr class="clicavel ${t.situacao === "concluida" ? "feita" : ""}" data-tf="${esc(t.id)}">
      <td>${t.prazo ? `<span class="${tfAtrasada(t) ? "atrasado" : ""}">${dataBR(t.prazo)}</span>` : "—"}</td>
      <td><b>${esc(t.titulo)}</b>${t.itens?.length ? ` <span class="at-sub">(${t.itens.filter((i) => i.feito).length}/${t.itens.length})</span>` : ""}</td>
      <td><span class="tf-prio ${t.prioridade}">${PRIORIDADES[t.prioridade]}</span></td>
      <td>${SITUACOES_TF[t.situacao].replace(/s$/, "")}</td>
      <td>${esc((t.responsaveis || []).map(nomePessoa).join(", "))}</td>
      <td>${vinculoTarefa(t)}</td></tr>`;
    $("tf-conteudo").innerHTML = `
      <div class="bloco rol"><table class="fin"><thead><tr><th>Prazo</th><th>Tarefa</th><th>Prioridade</th><th>Situação</th><th>Responsáveis</th><th>Vínculo</th></tr></thead>
        <tbody>${abertas.map(linha).join("") || '<tr><td colspan="6"><div class="vazio pequeno">Nenhuma tarefa aberta com esses filtros.</div></td></tr>'}</tbody></table></div>
      <label class="check"><input type="checkbox" id="tf-ver-concl" ${tf.verConcluidas ? "checked" : ""}> Mostrar concluídas (${concluidas.length})</label>
      ${tf.verConcluidas ? `<div class="bloco rol"><table class="fin"><tbody>${concluidas.map(linha).join("")}</tbody></table></div>` : ""}`;
  }
}

// contador no menu: minhas tarefas atrasadas ou que vencem hoje
function atualizarContadorTarefas() {
  const link = document.querySelector('.abas a[data-aba="tarefas"]');
  if (!link) return;
  const n = tf.lista.filter((t) => minha(t) && t.situacao !== "concluida" && t.prazo && t.prazo <= hoje()).length;
  link.innerHTML = `Tarefas${n ? ` <span class="contador">${n}</span>` : ""}`;
}

// ------------------------------------------------------------- formulário

function opcoesVinculo() {
  const procs = typeof proc !== "undefined" ? proc.lista.map((p) => `${p.numero}${p.cliente_nome ? ` — ${p.cliente_nome}` : ""}`) : [];
  return [...procs, ...at.clientes.map((c) => c.nome)].map((v) => `<option value="${esc(v)}">`).join("");
}

function textoVinculo(t) {
  const p = processoDaTarefa(t);
  if (p) return `${p.numero}${p.cliente_nome ? ` — ${p.cliente_nome}` : ""}`;
  return t.cliente_nome || "";
}

function linhaItem(i, idx) {
  return `<div class="tf-item"><input type="checkbox" ${i.feito ? "checked" : ""} aria-label="Feito">
    <input class="tf-item-texto" value="${esc(i.texto || "")}" placeholder="Item ${idx + 1}" maxlength="200">
    <button type="button" class="botao-sec mini" data-tf-remover-item>×</button></div>`;
}

function textoHistorico(h) {
  const quem = h.quem ? nomePessoa(h.quem) : "Sistema";
  const quando = new Date(h.quando).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  if (h.acao === "criou") return `${quando} — ${esc(quem)} criou${h.responsaveis?.length ? ` para ${esc(h.responsaveis.map(nomePessoa).join(", "))}` : ""}`;
  if (h.acao === "moveu") return `${quando} — ${esc(quem)} moveu de “${SITUACOES_TF[h.de]}” para “${SITUACOES_TF[h.para]}”`;
  if (h.acao === "passou") return `${quando} — ${esc(quem)} passou para ${esc((h.responsaveis || []).map(nomePessoa).join(", ") || "ninguém")}`;
  return "";
}

function abrirTarefa(t, base = {}) {
  const novo = !t;
  const d = t || { prioridade: "normal", situacao: "a_fazer", repetir: "nao", responsaveis: [estado.eu], itens: [], ...base };
  tf.editando = d;
  const lembrete = !novo && d.compromisso_id && (estado.compromissos.find((c) => c.id === d.compromisso_id)?.situacao ?? "pendente") !== "cancelado";
  abrirDialogo({
    titulo: novo ? "Nova tarefa" : "Tarefa",
    somenteLeitura: !pode("tarefas", 2),
    excluir: !novo && pode("tarefas", 2) ? () => excluirTarefa(d) : null,
    salvar: () => salvarTarefa(t, d),
    extras: !novo && d.situacao !== "concluida" && pode("tarefas", 2) ? `<button type="button" class="botao-sec" data-tf-concluir="${esc(d.id)}">✓ Concluir</button>` : "",
    corpo: `
      <label>Título<input id="tt-titulo" required maxlength="200" value="${esc(d.titulo || "")}" placeholder="Ex.: Juntar procuração no PJe"></label>
      <label>Descrição<textarea id="tt-descricao" rows="2">${esc(d.descricao || "")}</textarea></label>
      <div class="linha3">
        <label>Prazo<input type="date" id="tt-prazo" value="${esc(d.prazo || "")}"></label>
        <label>Prioridade<select id="tt-prioridade">${opcoes(Object.entries(PRIORIDADES), d.prioridade)}</select></label>
        <label>Situação<select id="tt-situacao">${opcoes(Object.entries(SITUACOES_TF).map(([v, r]) => [v, r.replace(/s$/, "")]), d.situacao)}</select></label>
      </div>
      <div><span class="rotulo">Responsáveis</span>
        <div class="responsaveis" id="tt-resp">${estado.equipe.map((x) =>
          `<label class="check"><input type="checkbox" value="${esc(x.email)}" ${(d.responsaveis || []).includes(x.email) ? "checked" : ""}> ${esc(x.nome || x.email)}</label>`).join("")}</div></div>
      <div class="linha2">
        <label>Processo ou cliente (opcional)<input id="tt-vinculo" list="tt-vinculos" value="${esc(textoVinculo(d))}" placeholder="número do processo ou nome do cliente">
          <datalist id="tt-vinculos">${opcoesVinculo()}</datalist></label>
        <label>Repetir<select id="tt-repetir">${opcoes(Object.entries(REPETICOES), d.repetir)}</select></label>
      </div>
      <div><span class="rotulo">Itens</span>
        <div id="tt-itens">${(d.itens || []).map(linhaItem).join("")}</div>
        <button type="button" class="botao-sec mini" data-tf-mais-item>+ Item</button></div>
      ${pode("agenda", 2) ? `<label class="check"><input type="checkbox" id="tt-agenda" ${lembrete ? "checked" : ""}> Lembrar na Agenda no dia do prazo (e no Google Agenda dos responsáveis)</label>` : ""}
      ${d.repetir !== "nao" ? `<p class="at-sub">Ao concluir, a próxima ${d.repetir === "semanal" ? "semana" : "ocorrência mensal"} é criada sozinha.</p>` : ""}
      ${!novo && d.historico?.length ? `<div class="hist-tarefa">${d.historico.map(textoHistorico).filter(Boolean).join("<br>")}</div>` : ""}`,
  });
}

function lerItens() {
  return [...document.querySelectorAll("#tt-itens .tf-item")].map((el) => ({
    texto: el.querySelector(".tf-item-texto").value.trim(), feito: el.querySelector("input[type=checkbox]").checked,
  })).filter((i) => i.texto);
}

function resolverVinculo(texto) {
  const v = texto.trim();
  if (!v) return { processo_id: null, cliente_id: null, cliente_nome: null };
  const p = typeof proc !== "undefined" ? (processoPorNumero(v.split(" — ")[0]) || null) : null;
  if (p) return { processo_id: p.id, cliente_id: p.cliente_id, cliente_nome: p.cliente_nome };
  const c = clientePorNome(v);
  return { processo_id: null, cliente_id: c?.id || null, cliente_nome: c?.nome || v };
}

function salvarTarefa(t, d) {
  const novo = !t;
  const titulo = $("tt-titulo").value.trim();
  if (!titulo) { avisar("Informe o título."); return; }
  const responsaveis = [...$("tt-resp").querySelectorAll("input:checked")].map((i) => i.value);
  const dados = {
    titulo, descricao: $("tt-descricao").value.trim() || null,
    prazo: $("tt-prazo").value || null,
    prioridade: $("tt-prioridade").value, situacao: $("tt-situacao").value,
    responsaveis, repetir: $("tt-repetir").value, itens: lerItens(),
    ...resolverVinculo($("tt-vinculo").value),
  };
  const lembrar = !!$("tt-agenda")?.checked;
  if (lembrar && !dados.prazo) { avisar("Para lembrar na agenda, informe o prazo."); return; }
  if (lembrar && !responsaveis.length) { avisar("Para lembrar na agenda, escolha um responsável."); return; }
  return executar(async () => {
    const q = novo ? sb.from("tarefas").insert(dados) : sb.from("tarefas").update(dados).eq("id", t.id);
    const { data, error } = await q.select().single();
    if (error) throw new Error(mensagemErro(error));
    guardar(tf.lista, data);
    const aviso = await lembreteTarefa(data, lembrar);
    if (dados.situacao === "concluida" && (!t || t.situacao !== "concluida")) await recarregarSeRepetiu(data);
    return aviso;
  }, novo ? "Tarefa criada." : "Tarefa salva.");
}

// cria, atualiza ou cancela o lembrete na agenda
async function lembreteTarefa(t, lembrar) {
  if (!pode("agenda", 2) || (!t.compromisso_id && (!lembrar || t.situacao === "concluida"))) return null;
  const situacao = t.situacao === "concluida" ? "cumprido" : lembrar ? "pendente" : "cancelado";
  const p = processoDaTarefa(t);
  const corpo = {
    compromisso: {
      id: t.compromisso_id || undefined, tipo: "outro", titulo: `Tarefa: ${t.titulo}`, dia_inteiro: true,
      inicio: `${t.prazo || hoje()}T00:00:00-03:00`, fim: null, processo: p?.numero || null,
      descricao: [t.descricao, `Tarefa no Supralex: ${location.origin}${location.pathname}#tarefas/${t.id}`].filter(Boolean).join("\n"),
      situacao,
    },
    responsaveis: t.responsaveis,
  };
  const { data, error } = await sb.functions.invoke("agenda", { body: corpo });
  if (error || !data?.compromisso) return "não foi possível atualizar a agenda";
  guardar(estado.compromissos, data.compromisso);
  estado.compromissos.sort((a, b) => a.inicio.localeCompare(b.inicio));
  if (pode("agenda")) renderizarAgenda();
  if (!t.compromisso_id) {
    const { data: ligada } = await sb.from("tarefas").update({ compromisso_id: data.compromisso.id }).eq("id", t.id).select().single();
    if (ligada) guardar(tf.lista, ligada);
  }
  return data.compromisso.google_erro ? `Google Agenda: ${data.compromisso.google_erro}` : null;
}

// a tarefa repetida concluída gera a próxima no banco: busca de novo para mostrar
async function recarregarSeRepetiu(t) {
  if (t.repetir === "nao") return;
  const r = await lerTudo(() => sb.from("tarefas").select("*").order("criado_em").order("id"));
  if (r.data) tf.lista = r.data;
}

async function moverTarefa(id, situacao) {
  const t = tf.lista.find((x) => x.id === id);
  if (!t || t.situacao === situacao) return;
  const { data, error } = await sb.from("tarefas").update({ situacao }).eq("id", id).select().single();
  if (error) { avisar(mensagemErro(error), 4000); renderizarTarefas(); return; }
  guardar(tf.lista, data);
  if (data.compromisso_id) await lembreteTarefa(data, true);
  if (situacao === "concluida") await recarregarSeRepetiu(data);
  renderizarTarefas();
  if (typeof proc !== "undefined" && proc.aberto) renderizarProcessos();
  avisar(situacao === "concluida" ? (t.repetir !== "nao" ? "Concluída. A próxima ocorrência já foi criada." : "Tarefa concluída.") : `Movida para “${SITUACOES_TF[situacao]}”.`);
}

function excluirTarefa(t) {
  if (!confirm(`Excluir a tarefa “${t.titulo}”?`)) return;
  return executar(async () => {
    if (t.compromisso_id) await lembreteTarefa({ ...t, situacao: "a_fazer" }, false);
    const { error } = await sb.from("tarefas").delete().eq("id", t.id);
    if (error) throw new Error(mensagemErro(error));
    tf.lista = tf.lista.filter((x) => x.id !== t.id);
    return null;
  }, "Tarefa excluída.");
}

function rotearTarefas(id) {
  renderizarTarefas();
  if (id && tf.carregado) {
    const t = tf.lista.find((x) => x.id === id);
    if (t) abrirTarefa(t); else avisar("Tarefa não encontrada.");
    history.replaceState(null, "", "#tarefas");
  }
}

// bloco da ficha do processo
function blocoTarefasProcesso(p) {
  if (!pode("tarefas")) return "";
  const lista = ordenar(tf.lista.filter((t) => t.processo_id === p.id && t.situacao !== "concluida"));
  return `<div class="bloco">
    <h3>Tarefas</h3>
    ${lista.length ? lista.map((t) => `<div class="lin"><a href="#tarefas/${esc(t.id)}">${esc(t.titulo)}</a>
      <span class="${tfAtrasada(t) ? "atrasado" : "proc-sub"}">${t.prazo ? dataBR(t.prazo).slice(0, 5) : ""} ${esc((t.responsaveis || []).map(nomePessoa).join(", "))}</span></div>`).join("")
      : '<div class="vazio pequeno">Nenhuma tarefa aberta.</div>'}
    ${pode("tarefas", 2) ? `<button class="botao-sec mini" data-tf-nova-processo="${esc(p.id)}">+ Tarefa</button>` : ""}
  </div>`;
}

function prepararTarefas() {
  $("tf-nova").addEventListener("click", () => abrirTarefa(null));
  for (const id of ["tf-busca", "tf-resp", "tf-prio", "tf-vinc"]) $(id).addEventListener("input", renderizarTarefas);
  const tela = $("tela-tarefas");
  tela.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tf-escopo], [data-tf-visao], [data-tf-concluir], [data-tf-ver-concluidas], select, a, input");
    if (b?.dataset.tfEscopo) { tf.escopo = b.dataset.tfEscopo; renderizarTarefas(); return; }
    if (b?.dataset.tfVisao) { tf.visao = b.dataset.tfVisao; renderizarTarefas(); return; }
    if (b?.dataset.tfConcluir) { moverTarefa(b.dataset.tfConcluir, "concluida"); return; }
    if (b?.dataset.tfVerConcluidas !== undefined) { tf.visao = "lista"; tf.verConcluidas = true; renderizarTarefas(); return; }
    if (b) return; // selects, links e caixas não abrem a tarefa
    const c = e.target.closest("[data-tf]");
    if (c) abrirTarefa(tf.lista.find((x) => x.id === c.dataset.tf));
  });
  tela.addEventListener("change", (e) => {
    if (e.target.dataset.tfMover) moverTarefa(e.target.dataset.tfMover, e.target.value);
    if (e.target.id === "tf-ver-concl") { tf.verConcluidas = e.target.checked; renderizarTarefas(); }
  });
  // arrastar entre colunas
  tela.addEventListener("dragstart", (e) => {
    const c = e.target.closest?.("[data-tf]");
    if (c) { e.dataTransfer.setData("text/plain", c.dataset.tf); c.classList.add("arrastando"); }
  });
  tela.addEventListener("dragend", (e) => e.target.classList?.remove("arrastando"));
  tela.addEventListener("dragover", (e) => {
    const col = e.target.closest("[data-tf-coluna]");
    if (col) { e.preventDefault(); col.classList.add("alvo"); }
  });
  tela.addEventListener("dragleave", (e) => e.target.closest?.("[data-tf-coluna]")?.classList.remove("alvo"));
  tela.addEventListener("drop", (e) => {
    const col = e.target.closest("[data-tf-coluna]");
    if (!col) return;
    e.preventDefault();
    col.classList.remove("alvo");
    moverTarefa(e.dataTransfer.getData("text/plain"), col.dataset.tfColuna);
  });
  // itens do formulário e conclusão pelo rodapé
  $("dlg-fin").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tfMaisItem !== undefined) {
      $("tt-itens").insertAdjacentHTML("beforeend", linhaItem({ texto: "", feito: false }, $("tt-itens").children.length));
      $("tt-itens").lastElementChild.querySelector(".tf-item-texto").focus();
    } else if (t.dataset.tfRemoverItem !== undefined) {
      t.closest(".tf-item").remove();
    } else if (t.dataset.tfConcluir && $("tt-situacao")) {
      $("tt-situacao").value = "concluida";
      fin.dialogo?.salvar?.();
    }
  });
  // "+ Tarefa" na ficha do processo
  $("tela-processos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tf-nova-processo]");
    if (!b) return;
    const p = proc.lista.find((x) => x.id === b.dataset.tfNovaProcesso);
    abrirTarefa(null, { processo_id: p.id, cliente_id: p.cliente_id, cliente_nome: p.cliente_nome });
  });
}
