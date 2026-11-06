// Aba Permissões: quem entra no Supralex e o que cada pessoa pode fazer em cada área.
// Só quem administra permissões vê esta aba; as mesmas regras valem no banco (public.nivel),
// que também impede ficar sem nenhum administrador e guarda o histórico de alterações.
// Usa as utilidades de app.js e o diálogo genérico de financeiro.js.

const AREAS_PERM = [
  { area: "publicacoes", rotulo: "Publicações", niveis: { 0: "Não vê", 1: "Vê", 2: "Vê e marca" } },
  { area: "agenda", rotulo: "Agenda", niveis: { 0: "Não vê", 1: "Vê", 2: "Vê e edita" } },
  { area: "atendimento", rotulo: "Atendimento", niveis: { 0: "Não vê", 1: "Vê", 2: "Preenche", 3: "Preenche e conclui" } },
  { area: "processos", rotulo: "Processos", niveis: { 0: "Não vê", 1: "Vê", 2: "Vê e edita" } },
  { area: "tarefas", rotulo: "Tarefas", niveis: { 0: "Não vê", 1: "Vê", 2: "Vê e edita" } },
  { area: "financeiro", rotulo: "Financeiro", niveis: { 0: "Não vê", 1: "Vê e exporta", 2: "Lança", 3: "Administra" } },
  { area: "permissoes", rotulo: "Permissões", niveis: { 0: "Não", 3: "Administra" } },
];

const PERFIS = {
  socio: {
    rotulo: "Sócio", descricao: "Tudo, inclusive Financeiro e Permissões.",
    permissoes: { publicacoes: 2, agenda: 2, atendimento: 3, processos: 2, tarefas: 2, financeiro: 3, permissoes: 3 },
  },
  advogado: {
    rotulo: "Advogado", descricao: "Publicações, Agenda e Atendimento completos. Sem Financeiro.",
    permissoes: { publicacoes: 2, agenda: 2, atendimento: 3, processos: 2, tarefas: 2, financeiro: 0, permissoes: 0 },
  },
  secretaria: {
    rotulo: "Secretária / estagiário", descricao: "Vê publicações, cuida da agenda e preenche atendimentos.",
    permissoes: { publicacoes: 1, agenda: 2, atendimento: 2, processos: 2, tarefas: 2, financeiro: 0, permissoes: 0 },
  },
  contador: {
    rotulo: "Contador", descricao: "Só o Financeiro, para ver e exportar.",
    permissoes: { publicacoes: 0, agenda: 0, atendimento: 0, processos: 0, tarefas: 0, financeiro: 1, permissoes: 0 },
  },
  personalizado: { rotulo: "Personalizado", descricao: "Escolha área por área.", permissoes: null },
};

const perm = { historico: [] };

const rotuloPerfil = (p) => PERFIS[p]?.rotulo || "Personalizado";
const rotuloNivel = (a, n) => a.niveis[n] ?? a.niveis[0];

function perfilDasPermissoes(permissoes) {
  return Object.entries(PERFIS).find(([, p]) => p.permissoes &&
    AREAS_PERM.every(({ area }) => Number(p.permissoes[area]) === Number(permissoes[area] ?? 0)))?.[0] || "personalizado";
}

async function carregarPermissoes() {
  const { data } = await sb.from("permissoes_historico").select("*").order("quando", { ascending: false }).limit(100);
  perm.historico = data || [];
  if (abaAtual() === "permissoes") renderizarPermissoes();
}

function linhaPessoa(p) {
  return `
  <tr data-email="${esc(p.email)}" class="${p.ativo ? "" : "inativo"}">
    <td class="pessoa"><input class="p-nome" value="${esc(p.nome || "")}" maxlength="80" aria-label="Nome"><span>${esc(p.email)}${p.email === estado.eu ? " · você" : ""}</span></td>
    <td><select class="p-perfil" aria-label="Perfil">${opcoes(Object.entries(PERFIS).map(([v, x]) => [v, x.rotulo]), p.perfil)}</select></td>
    ${AREAS_PERM.map((a) => `<td><select class="p-nivel" data-area="${a.area}" aria-label="${esc(a.rotulo)}">
      ${opcoes(Object.entries(a.niveis).map(([v, r]) => [v, r]), String(p.permissoes?.[a.area] ?? 0))}</select></td>`).join("")}
    <td><label class="check"><input type="checkbox" class="p-ativo" ${p.ativo ? "checked" : ""}> ativo</label></td>
    <td><button class="botao-sec mini" data-salvar-pessoa disabled>Salvar</button></td>
  </tr>`;
}

function descreverMudanca(h) {
  const quem = h.quem ? nomePessoa(h.quem) : "Sistema";
  const alvo = h.depois?.nome || h.email;
  if (!h.antes) return `${esc(quem)} incluiu <strong>${esc(alvo)}</strong> com o perfil ${esc(rotuloPerfil(h.depois?.perfil))}`;
  const partes = [];
  if (h.antes.ativo !== h.depois.ativo) partes.push(h.depois.ativo ? "reativou o acesso" : "desativou o acesso");
  if (h.antes.nome !== h.depois.nome) partes.push(`nome “${h.antes.nome || ""}” → “${h.depois.nome || ""}”`);
  if (h.antes.perfil !== h.depois.perfil) partes.push(`perfil ${rotuloPerfil(h.antes.perfil)} → ${rotuloPerfil(h.depois.perfil)}`);
  for (const a of AREAS_PERM) {
    const x = Number(h.antes.permissoes?.[a.area] ?? 0), y = Number(h.depois.permissoes?.[a.area] ?? 0);
    if (x !== y) partes.push(`${a.rotulo}: ${rotuloNivel(a, x)} → ${rotuloNivel(a, y)}`);
  }
  return `${esc(quem)} alterou <strong>${esc(alvo)}</strong>: ${esc(partes.join("; ") || "sem mudança visível")}`;
}

function renderizarPermissoes() {
  if (!pode("permissoes", 3)) return;
  const pessoas = [...estado.pessoas].sort((a, b) => (b.ativo - a.ativo) || (a.nome || a.email).localeCompare(b.nome || b.email));
  $("perm-perfis").innerHTML = Object.entries(PERFIS).filter(([, p]) => p.permissoes)
    .map(([, p]) => `<div class="perfil"><b>${esc(p.rotulo)}</b>${esc(p.descricao)}</div>`).join("");
  $("perm-corpo").innerHTML = pessoas.map(linhaPessoa).join("");
  $("perm-cab").innerHTML = `<th>Pessoa</th><th>Perfil</th>${AREAS_PERM.map((a) => `<th>${esc(a.rotulo)}</th>`).join("")}<th>Acesso</th><th></th>`;
  $("perm-historico").innerHTML = perm.historico.length
    ? perm.historico.map((h) => `<div class="hist"><span>${new Date(h.quando).toLocaleString("pt-BR")}</span> — ${descreverMudanca(h)}</div>`).join("")
    : '<div class="at-sub">Nenhuma alteração registrada ainda.</div>';
}

function lerLinha(tr) {
  const permissoes = {};
  tr.querySelectorAll(".p-nivel").forEach((s) => { permissoes[s.dataset.area] = Number(s.value); });
  return {
    nome: tr.querySelector(".p-nome").value.trim() || null,
    perfil: tr.querySelector(".p-perfil").value,
    permissoes,
    ativo: tr.querySelector(".p-ativo").checked,
  };
}

async function salvarPessoa(tr) {
  const email = tr.dataset.email;
  const dados = lerLinha(tr);
  if (email === estado.eu && (!dados.ativo || dados.permissoes.permissoes < 3) &&
      !confirm("Você está tirando o seu próprio acesso de administrador. Continuar?")) return;
  const botao = tr.querySelector("[data-salvar-pessoa]");
  botao.disabled = true;
  const { data, error } = await sb.from("usuarios_autorizados").update(dados).eq("email", email).select().single();
  if (error) {
    renderizarPermissoes(); // volta a linha ao que está gravado
    avisar(/administrando/.test(error.message) ? "É preciso manter pelo menos uma pessoa ativa administrando as permissões."
      : mensagemErro(error), 5000);
    return;
  }
  atualizarPessoa(data);
  avisar(`${data.nome || email}: permissões salvas.`);
  await carregarPermissoes();
  if (email === estado.eu) location.reload(); // as próprias permissões mudaram: recarrega as abas
}

function atualizarPessoa(p) {
  const i = estado.pessoas.findIndex((x) => x.email === p.email);
  if (i >= 0) estado.pessoas[i] = p; else estado.pessoas.push(p);
  estado.equipe = estado.pessoas.filter((x) => x.ativo).sort((a, b) => (a.nome || a.email).localeCompare(b.nome || b.email));
  preencherFiltrosAgenda();
  renderizarPermissoes();
}

function abrirNovaPessoa() {
  abrirDialogo({
    titulo: "Adicionar pessoa",
    ok: "Adicionar",
    salvar: async () => {
      const email = $("np-email").value.trim().toLowerCase();
      const nome = $("np-nome").value.trim();
      const perfil = $("np-perfil").value;
      if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { avisar("Informe nome e e-mail válidos."); return; }
      if (estado.pessoas.some((p) => p.email === email)) { avisar("Este e-mail já está cadastrado."); return; }
      $("dfin-ok").disabled = true;
      const { data, error } = await sb.from("usuarios_autorizados")
        .insert({ email, nome, perfil, permissoes: PERFIS[perfil].permissoes, ativo: true }).select().single();
      $("dfin-ok").disabled = false;
      if (error) { avisar(mensagemErro(error), 4000); return; }
      fecharDialogo();
      atualizarPessoa(data);
      await carregarPermissoes();
      avisar(`${nome} incluído(a). Ajuste as áreas na tabela, se precisar.`, 4000);
    },
    corpo: `
      <label>Nome<input id="np-nome" required maxlength="80"></label>
      <label>E-mail<input id="np-email" type="email" required maxlength="200" autocomplete="off"></label>
      <label>Perfil<select id="np-perfil">${opcoes(Object.entries(PERFIS).filter(([, p]) => p.permissoes).map(([v, p]) => [v, `${p.rotulo} — ${p.descricao}`]), "advogado")}</select></label>
      <p class="at-sub">A pessoa entra em ${esc(location.host || "publicacoes.blpr.adv.br")} com o próprio e-mail (link de acesso, sem senha).
        Para receber compromissos no Google Agenda, ela precisa compartilhar a agenda dela com
        <strong>agenda-painel@painel-blpr.iam.gserviceaccount.com</strong> (permissão “Fazer alterações nos eventos”).</p>`,
  });
}

function prepararPermissoes() {
  $("perm-nova").addEventListener("click", abrirNovaPessoa);
  const corpo = $("perm-corpo");
  corpo.addEventListener("change", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    if (e.target.classList.contains("p-perfil")) {
      const preset = PERFIS[e.target.value].permissoes;
      if (preset) tr.querySelectorAll(".p-nivel").forEach((s) => { s.value = String(preset[s.dataset.area] ?? 0); });
    } else if (e.target.classList.contains("p-nivel")) {
      tr.querySelector(".p-perfil").value = perfilDasPermissoes(lerLinha(tr).permissoes);
    }
    tr.querySelector("[data-salvar-pessoa]").disabled = false;
  });
  corpo.addEventListener("input", (e) => {
    if (e.target.classList.contains("p-nome")) e.target.closest("tr").querySelector("[data-salvar-pessoa]").disabled = false;
  });
  corpo.addEventListener("click", (e) => {
    const b = e.target.closest("[data-salvar-pessoa]");
    if (b) salvarPessoa(b.closest("tr"));
  });
}
