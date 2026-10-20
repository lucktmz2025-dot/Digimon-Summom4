import * as THREE from 'three';
import digimonData from './data/digimon.json';
import promoCodes from './data/codes.json';
import './style.css';

const digimonById = Object.fromEntries(digimonData.roster.map((digimon) => [digimon.id, digimon]));
const STORAGE_KEY = 'ressonancia-demo-profile-v1';
const pityLimit = 10;
const advantage = { Fogo: ['Planta', 'Gelo'], Planta: ['Água'], Água: ['Fogo'], Gelo: ['Planta'], Luz: ['Trevas'], Trevas: ['Luz'] };
const reverseAdvantage = Object.fromEntries(Object.entries(advantage).flatMap(([element, counters]) => counters.map((counter) => [counter, element])));

function loadProfile() {
  const defaults = {
    trainerLevel: 8,
    digimonLevel: 12,
    bond: 2,
    bits: 1200,
    fireCores: 1,
    courage: 0,
    energy: 100,
    freePulls: 0,
    pulls: 0,
    pity: 0,
    fragments: {},
    owned: ['agumon', 'gabumon', 'patamon'],
    redeemedCodes: [],
    activeForm: 'agumon',
    settings: { music: 0.35, effects: 0.55, voices: 0.4, reduceEffects: false, fastAnimations: false }
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return { ...defaults, ...saved, settings: { ...defaults.settings, ...saved?.settings } };
  } catch {
    return defaults;
  }
}

const profile = loadProfile();
let route = 'battle';
let battle = createBattle();
let selectedTarget = null;
let activeRenderer = null;
let audioContext = null;
let evolutionPreview = false;
let dexFilter = 'Todos';
let toastTimer;

function saveProfile() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

function fighterFor(id, side, index) {
  const data = digimonById[id];
  const stats = data.stats;
  const isPlayer = side === 'player';
  const levelScale = isPlayer && id === profile.activeForm ? 1 + Math.max(0, profile.digimonLevel - 12) * 0.035 : 1;
  return {
    id: `${side}-${id}-${index}`,
    digimonId: id,
    name: data.name,
    side,
    index,
    hp: Math.round(stats.hp * levelScale),
    maxHp: Math.round(stats.hp * levelScale),
    attack: Math.round(stats.attack * levelScale),
    defense: stats.defense,
    agility: stats.agility,
    energy: isPlayer && id === 'patamon' ? 3 : 2,
    maxEnergy: 4,
    status: null,
    alive: true,
    data
  };
}

function createBattle() {
  const team = digimonData.team.map((id, index) => fighterFor(id === 'agumon' ? profile.activeForm : id, 'player', index));
  const enemies = digimonData.enemies.map((id, index) => fighterFor(id, 'enemy', index));
  const fighters = [...team, ...enemies];
  return {
    fighters,
    round: 1,
    queue: fighters.filter((fighter) => fighter.alive).sort((a, b) => b.agility - a.agility).map((fighter) => fighter.id),
    currentId: null,
    log: ['A arena está pronta. A agilidade define a ordem inicial.'],
    ended: null,
    lastAction: null,
    busy: false
  };
}

function currentFighter() {
  return battle.fighters.find((fighter) => fighter.id === battle.currentId);
}

function living(side) {
  return battle.fighters.filter((fighter) => fighter.side === side && fighter.alive);
}

function effectiveAgility(fighter) {
  return Math.max(1, fighter.agility - (fighter.status?.type === 'slow' ? 5 : 0));
}

function beginBattle() {
  battle = createBattle();
  selectedTarget = null;
  nextTurn();
  render();
}

function nextTurn() {
  if (living('enemy').length === 0) {
    battle.ended = 'victory';
    battle.log.unshift('Vitória! A equipe recebeu 180 Bits e 1 Núcleo de Fogo.');
    profile.bits += 180;
    profile.fireCores += 1;
    profile.trainerLevel = Math.min(50, profile.trainerLevel + 1);
    saveProfile();
    return;
  }
  if (living('player').length === 0) {
    battle.ended = 'defeat';
    battle.log.unshift('A equipe recuou. Nenhum recurso foi perdido.');
    return;
  }

  while (battle.queue.length) {
    const nextId = battle.queue.shift();
    const next = battle.fighters.find((fighter) => fighter.id === nextId);
    if (!next?.alive) continue;
    battle.currentId = next.id;
    if (next.status?.type === 'stun') {
      battle.log.unshift(`${next.name} perdeu a ação por atordoamento.`);
      next.status = null;
      battle.busy = true;
      setTimeout(() => {
        battle.busy = false;
        render();
        nextTurn();
      }, profile.settings.fastAnimations ? 220 : 620);
      return;
    }
    if (next.status && next.status.turns <= 0) next.status = null;
    if (next.side === 'enemy') {
      battle.busy = true;
      render();
      setTimeout(() => enemyAction(next), profile.settings.fastAnimations ? 300 : 750);
    } else {
      battle.busy = false;
      render();
    }
    return;
  }

  battle.round += 1;
  battle.queue = battle.fighters.filter((fighter) => fighter.alive).sort((a, b) => effectiveAgility(b) - effectiveAgility(a)).map((fighter) => fighter.id);
  nextTurn();
}

function elementalMultiplier(attacker, target) {
  const attackElement = attacker.data.special.element || attacker.data.element;
  if (advantage[attackElement]?.includes(target.data.element)) return 1.25;
  if (reverseAdvantage[attackElement] === target.data.element) return 0.82;
  return 1;
}

function applyAction(actor, target, isSpecial) {
  const move = isSpecial ? actor.data.special : actor.data.basic;
  if (!actor.alive || !target?.alive || (isSpecial && actor.energy < move.cost)) return;
  const evasion = Math.min(25, Math.max(0, 5 + (effectiveAgility(target) - effectiveAgility(actor)) * 0.45));
  const dodged = Math.random() * 100 < evasion;
  const passiveBonus = actor.digimonId === 'kuwagamon' && target.hp / target.maxHp < 0.5 ? 1.1 : 1;
  const agumonBonus = actor.digimonId === 'agumon' && actor.hp / actor.maxHp < 0.5 ? 1.08 : 1;
  let damage = 0;
  if (!dodged) {
    const elemental = isSpecial ? elementalMultiplier(actor, target) : 1;
    let reduction = 1;
    if (target.digimonId === 'greymon') reduction = 0.92;
    if (target.digimonId === 'metalgreymon') reduction = 0.88;
    if (target.digimonId === 'devimon' && isSpecial) reduction = 0.9;
    if (target.digimonId === 'gabumon' && actor.data.element === 'Gelo') reduction = 0.9;
    damage = Math.max(4, Math.round((move.power + actor.attack * 0.42 - target.defense * 0.45) * elemental * passiveBonus * agumonBonus * reduction));
    target.hp = Math.max(0, target.hp - damage);
    target.alive = target.hp > 0;
    if (isSpecial && move.effect === 'slow') target.status = { type: 'slow', turns: 1 };
    if (isSpecial && move.effect === 'weaken') target.status = { type: 'weaken', turns: 1 };
    if (target.hp === 0 && target.digimonId === 'wargreymon' && !target.usedBraveShield) {
      target.hp = 1;
      target.alive = true;
      target.usedBraveShield = true;
    }
  }
  if (isSpecial) actor.energy -= move.cost;
  else actor.energy = Math.min(actor.maxEnergy, actor.energy + 1);
  actor.energy = Math.min(actor.maxEnergy, actor.energy + (actor.digimonId === 'patamon' && !isSpecial ? 0 : 0));
  if (actor.status?.type === 'weaken') {
    actor.attack = Math.max(1, actor.attack - 4);
    actor.status.turns -= 1;
    if (actor.status.turns <= 0) actor.status = null;
  }
  battle.lastAction = { actorId: actor.id, targetId: target.id, at: Date.now(), special: isSpecial };
  const result = dodged ? `esquivou (${Math.round(evasion)}%)` : `causou ${damage} de dano`;
  battle.log.unshift(`${actor.name}: ${move.name} ${isSpecial ? '· especial' : '· básico'}; ${target.name} ${result}.`);
  if (!dodged && isSpecial && move.effect) battle.log.unshift(`${target.name}: efeito ${move.effect === 'slow' ? 'Lentidão' : 'Ataque reduzido'} por 1 turno.`);
}

function enemyAction(actor) {
  if (battle.ended) return;
  const targets = living('player').sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  const target = actor.digimonId === 'kuwagamon' ? targets[0] : targets.find((fighter) => fighter.status?.type !== 'weaken') || targets[0];
  const useSpecial = actor.energy >= actor.data.special.cost && (actor.digimonId === 'devimon' ? !target.status : Math.random() > 0.35);
  applyAction(actor, target, useSpecial);
  battle.busy = false;
  render();
  setTimeout(nextTurn, profile.settings.fastAnimations ? 220 : 520);
}

function playerAction(isSpecial) {
  const actor = currentFighter();
  const target = battle.fighters.find((fighter) => fighter.id === (selectedTarget || living('enemy')[0]?.id));
  if (!actor || actor.side !== 'player' || battle.busy || battle.ended || !target) return;
  if (isSpecial && actor.energy < actor.data.special.cost) {
    showToast(`Energia insuficiente. ${actor.data.special.name} custa ${actor.data.special.cost}.`);
    return;
  }
  applyAction(actor, target, isSpecial);
  battle.busy = true;
  render();
  setTimeout(() => {
    battle.busy = false;
    render();
    nextTurn();
  }, profile.settings.fastAnimations ? 220 : 520);
}

function rarityWeight(rarity) {
  return ({ Comum: 55, Raro: 30, Épico: 12, Lendário: 3 })[rarity] || 0;
}

function pullOne() {
  const pool = digimonData.roster.filter((digimon) => ['agumon', 'greymon', 'gabumon', 'patamon'].includes(digimon.id));
  const isPity = profile.pity >= pityLimit - 1;
  const eligible = isPity ? pool.filter((digimon) => ['Raro', 'Épico', 'Lendário'].includes(digimon.rarity)) : pool;
  const totalWeight = eligible.reduce((sum, digimon) => sum + rarityWeight(digimon.rarity), 0);
  let roll = Math.random() * totalWeight;
  const result = eligible.find((digimon) => (roll -= rarityWeight(digimon.rarity)) <= 0) || eligible[0];
  profile.pulls += 1;
  profile.pity = isPity ? 0 : profile.pity + 1;
  if (profile.owned.includes(result.id)) {
    profile.fragments[result.id] = (profile.fragments[result.id] || 0) + 1;
    return { ...result, duplicate: true };
  }
  profile.owned.push(result.id);
  return { ...result, duplicate: false };
}

function doPull(count) {
  const freeCount = Math.min(profile.freePulls, count);
  const paidCount = count - freeCount;
  const cost = count === 10 ? 900 : 100;
  if (paidCount > 0 && profile.bits < (count === 10 ? Math.max(0, cost - freeCount * 100) : cost)) {
    showToast('Bits insuficientes. Você pode ganhar mais em batalhas e missões.');
    return;
  }
  if (count === 10 && freeCount < count) profile.bits -= Math.max(0, cost - freeCount * 100);
  else if (count === 1 && freeCount === 0) profile.bits -= cost;
  profile.freePulls -= freeCount;
  const results = Array.from({ length: count }, pullOne);
  saveProfile();
  showToast(results.map((result) => `${result.name}${result.duplicate ? ' · +1 fragmento' : ''}`).join(' / '));
  render();
}

function normalizeCode(value) {
  return value.trim().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function redeemCode(value) {
  const code = promoCodes.find((entry) => normalizeCode(entry.code) === normalizeCode(value));
  if (!code) return showToast('Código não encontrado. Confira a escrita e a validade.');
  if (profile.redeemedCodes.includes(normalizeCode(code.code))) return showToast('Este código já foi resgatado neste perfil.');
  if (new Date(`${code.expiresAt}T23:59:59`) < new Date()) return showToast('Este código expirou.');
  const reward = code.reward;
  profile.bits += reward.bits || 0;
  profile.fireCores += reward.fireCores || 0;
  profile.courage += reward.courage || 0;
  profile.energy += reward.energy || 0;
  profile.freePulls += reward.pulls || 0;
  profile.bond = Math.min(10, profile.bond + (reward.bondGift || 0));
  profile.redeemedCodes.push(normalizeCode(code.code));
  saveProfile();
  showToast(`Resgatado: ${reward.label}.`);
  render();
}

function requirementsFor(digimon) {
  if (!digimon.evolution) return [];
  const next = digimonById[digimon.evolution];
  const requiredLevel = Number(next.evolutionRequirements.find((item) => item.startsWith('Nível '))?.replace(/\D/g, '') || 1);
  const requiredBond = Number(next.evolutionRequirements.find((item) => item.startsWith('Vínculo '))?.replace(/\D/g, '') || 0);
  const requiredFire = next.evolutionRequirements.filter((item) => item.includes('Núcleo de Fogo')).length;
  const requiredTrainer = Number(next.evolutionRequirements.find((item) => item.startsWith('Treinador '))?.replace(/\D/g, '') || 1);
  return [
    { label: `Nível do Digimon ${requiredLevel}`, met: profile.digimonLevel >= requiredLevel },
    { label: `Vínculo ${requiredBond}`, met: profile.bond >= requiredBond },
    { label: `Nível do treinador ${requiredTrainer}`, met: profile.trainerLevel >= requiredTrainer },
    { label: `${requiredFire} Núcleo de Fogo`, met: profile.fireCores >= requiredFire }
  ];
}

function confirmEvolution() {
  const current = digimonById[profile.activeForm];
  const next = digimonById[current.evolution];
  if (!next || requirementsFor(current).some((item) => !item.met)) return;
  const fireCost = next.evolutionRequirements.filter((item) => item.includes('Núcleo de Fogo')).length;
  profile.fireCores -= fireCost;
  profile.activeForm = next.id;
  if (!profile.owned.includes(next.id)) profile.owned.push(next.id);
  saveProfile();
  evolutionPreview = false;
  playEvolutionSound();
  battle = createBattle();
  showToast(`${current.name} evoluiu para ${next.name}!`);
  render();
}

function trainDigimon() {
  const cost = 80 + Math.max(0, profile.digimonLevel - 12) * 12;
  if (profile.bits < cost || profile.digimonLevel >= 50) {
    showToast(profile.digimonLevel >= 50 ? 'Nível máximo alcançado.' : `Treinamento custa ${cost} Bits.`);
    return;
  }
  profile.bits -= cost;
  profile.digimonLevel += 1;
  profile.trainerLevel = Math.min(50, Math.max(profile.trainerLevel, Math.floor(profile.digimonLevel * 0.7)));
  saveProfile();
  showToast(`${digimonById[profile.activeForm].name} chegou ao nível ${profile.digimonLevel}.`);
  render();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function statRow(label, value) {
  return `<div class="stat-row"><span>${label}</span><strong>${value}</strong></div>`;
}

function icon(name) {
  const paths = {
    battle: '<path d="M7 3 3 7l5 5 4-4-5-5ZM17 21l4-4-5-5-4 4 5 5ZM14 10l-4 4M16 8l-2 2M8 16l2-2"/>',
    dex: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5v-12Z"/><path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h8M8 10h6"/>',
    evolve: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8m-7.2 7.2-2.8 2.8"/><circle cx="12" cy="12" r="3"/>',
    gacha: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8m0-12.8L5.6 18.4"/><circle cx="12" cy="12" r="8"/>',
    code: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m8 10-2 2 2 2m8-4 2 2-2 2m-3-5-2 6"/>',
    training: '<path d="M4 8v8m16-8v8M7 10v4m10-4v4M4 12h16"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a7.7 7.7 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a7.7 7.7 0 0 1-1.6-.9l-1.7.7-1.4-2.4 1.4-1.1A6 6 0 0 1 7.4 13l-1.7-.7v-2.8l1.7-.3a7.7 7.7 0 0 1 .9-1.6l-.7-1.7L10 4.5l1.1 1.4c.5-.2 1-.3 1.6-.3l.3-1.7h2.8l.3 1.7c.6.1 1.1.3 1.6.6l1.7-.7 1.4 2.4-1.4 1.1c.2.5.3 1 .3 1.6l1.7.3v2.8l-1.7.3c-.1.4-.2.7-.3 1"/>',
    spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z"/>'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.spark}</svg>`;
}

const navigation = [
  ['battle', 'battle', 'Arena'], ['dex', 'dex', 'Enciclopédia'], ['evolve', 'evolve', 'Evolução'],
  ['gacha', 'gacha', 'Recrutamento'], ['codes', 'code', 'Códigos'], ['training', 'training', 'Treinamento']
];

function shell(content) {
  return `<div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#arena" data-route="battle" aria-label="Digimon Ressonância Digital, início"><span class="brand-mark">${icon('spark')}</span><span><strong>RESONÂNCIA</strong><small>DIGITAL PROJECT · 01</small></span></a>
      <div class="profile-mini"><div class="profile-avatar">${icon('spark')}</div><div><strong>Treinador</strong><span>Nível ${profile.trainerLevel} <i>·</i> vínculo ${profile.bond}</span></div><b class="online-dot"></b></div>
      <span class="nav-label">MUNDO DIGITAL</span>
      <nav>${navigation.map(([id, iconName, label]) => `<button class="nav-item ${route === id ? 'active' : ''}" data-route="${id}">${icon(iconName)}<span>${label}</span>${id === 'gacha' && profile.freePulls ? '<small class="nav-count">1</small>' : ''}</button>`).join('')}</nav>
      <div class="sidebar-bottom">
        <button class="nav-item ${route === 'settings' ? 'active' : ''}" data-route="settings">${icon('settings')}<span>Configurações</span></button>
        <div class="prototype-stamp"><span class="stamp-dot"></span><span>BUILD 0.1 · PROTÓTIPO<br><strong>CONTEÚDO NÃO LICENCIADO</strong></span></div>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="breadcrumb"><span>REDE</span><span class="crumb-slash">/</span><strong>${navigation.find((item) => item[0] === route)?.[2] || 'Configurações'}</strong></div><div class="topbar-right"><span class="resource-chip">${icon('spark')}<strong>${profile.bits.toLocaleString('pt-BR')}</strong><small>BITS</small></span><span class="trainer-chip">T${profile.trainerLevel}</span><button class="avatar-button" data-route="settings" aria-label="Configurações">T</button></div></header>
      <div class="page-content">${content}</div>
    </main>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  </div>`;
}

function renderBattle() {
  const actor = currentFighter();
  const target = battle.fighters.find((fighter) => fighter.id === (selectedTarget || living('enemy')[0]?.id));
  const order = [actor, ...battle.queue.map((id) => battle.fighters.find((fighter) => fighter.id === id))].filter(Boolean);
  const statusLabel = (status) => status?.type === 'slow' ? 'Lentidão · 1 turno' : status?.type === 'weaken' ? 'Ataque reduzido · 1 turno' : '';
  const fighterCard = (fighter) => `<div class="unit-card ${fighter.side} ${fighter.id === actor?.id ? 'is-turn' : ''} ${!fighter.alive ? 'is-down' : ''}">
      <div class="unit-top"><span class="unit-glyph" style="--unit-color:${fighter.data.color}">${fighter.name.slice(0, 1)}</span><div class="unit-meta"><strong>${fighter.name}</strong><span>${fighter.data.role} · AGI ${effectiveAgility(fighter)}</span></div><span class="unit-level">${fighter.side === 'player' ? `Nv.${profile.digimonLevel}` : 'CPU'}</span></div>
      <div class="health-track"><span style="width:${Math.max(0, fighter.hp / fighter.maxHp * 100)}%; --health-color:${fighter.side === 'player' ? '#64b59d' : '#e8795d'}"></span></div><div class="unit-vitals"><span>${fighter.hp}/${fighter.maxHp} PV</span><span>${fighter.energy}/${fighter.maxEnergy} EN</span></div>
      <div class="energy-track"><span style="width:${fighter.energy / fighter.maxEnergy * 100}%"></span></div>
      ${statusLabel(fighter.status) ? `<span class="status-tag">${statusLabel(fighter.status)}</span>` : ''}
    </div>`;
  const resultCard = battle.ended ? `<div class="result-panel ${battle.ended}"><span class="eyebrow">FIM DO ENCONTRO</span><h2>${battle.ended === 'victory' ? 'Vitória da equipe' : 'Recuo estratégico'}</h2><p>${battle.ended === 'victory' ? 'Recompensas adicionadas ao perfil.' : 'Seu progresso e seus recursos foram preservados.'}</p><button class="button button-primary" data-action="rematch">${icon('battle')} Nova batalha</button></div>` : '';
  const moveDescription = actor?.data.special.description || '';
  return `<section class="page-heading"><div><span class="eyebrow">SETOR FLORESTA · ENCONTRO 01</span><h1>Uma equipe. Muitas eras.</h1><p>Três parceiros, um campo de treino e uma ameaça inesperada.</p></div><div class="heading-tag"><span class="live-dot"></span> BATALHA DE TESTE</div></section>
    <section class="battle-layout">
      <div class="battle-main">
        <div class="arena-frame"><canvas id="battle-canvas" aria-label="Arena tridimensional de batalha"></canvas><div class="arena-topline"><span class="arena-location">${icon('spark')} FLORESTA DE FILE · SETOR 04</span><span class="round-chip">RODADA ${battle.round.toString().padStart(2, '0')}</span></div><div class="scene-legend"><span><i class="legend-dot ally"></i>EQUIPE</span><span><i class="legend-dot foe"></i>ADVERSÁRIOS</span></div><div class="arena-bottomline"><span>ARENA 3D <i>·</i> MODELOS PROCEDURAIS</span><span>${icon('spark')} AGILIDADE DEFINE A INICIATIVA</span></div></div>
        <div class="battle-roster"><div class="roster-side"><span class="roster-label">SEU ESQUADRÃO <i>03</i></span>${living('player').map(fighterCard).join('') || '<p class="empty-note">Sem combatentes ativos.</p>'}</div><div class="roster-side enemy-roster"><span class="roster-label">AMEAÇAS <i>${living('enemy').length.toString().padStart(2, '0')}</i></span>${living('enemy').map((fighter) => `<button class="target-card ${target?.id === fighter.id ? 'selected' : ''}" data-target="${fighter.id}" ${battle.ended ? 'disabled' : ''}>${fighterCard(fighter)}<span class="target-hint">${target?.id === fighter.id ? 'ALVO SELECIONADO' : 'SELECIONAR ALVO'}</span></button>`).join('') || '<p class="empty-note">A arena está limpa.</p>'}</div></div>
      </div>
      <aside class="battle-panel">
        <div class="panel-heading"><div><span class="eyebrow">LINHA DE AÇÃO</span><h2>Próximos turnos</h2></div><span class="round-mini">R${battle.round}</span></div>
        <div class="turn-queue">${order.slice(0, 6).map((fighter, index) => `<div class="queue-item ${index === 0 ? 'queue-current' : ''} ${fighter.side}"><span class="queue-order">${index === 0 ? 'AGORA' : String(index + 1).padStart(2, '0')}</span><span class="queue-avatar" style="--unit-color:${fighter.data.color}">${fighter.name.slice(0, 1)}</span><span class="queue-name">${fighter.name}</span><span class="queue-speed">${effectiveAgility(fighter)}</span></div>`).join('') || '<p class="empty-note">Nenhum turno restante.</p>'}</div>
        <div class="turn-readout"><span class="turn-readout-icon">${icon('spark')}</span><div><small>TURNO ATUAL</small><strong>${actor?.name || (battle.ended ? 'Encontro finalizado' : 'Preparando arena')}</strong><span>${actor ? `${actor.data.role} · Agilidade ${effectiveAgility(actor)}` : 'A ordem é recalculada a cada rodada.'}</span></div></div>
        ${resultCard || `<div class="action-area"><div class="action-label"><span>AÇÕES DISPONÍVEIS</span><span>${actor?.energy ?? 0} / 4 ENERGIA</span></div><button class="move-button basic-move" data-action="basic" ${!actor || actor.side !== 'player' || battle.busy ? 'disabled' : ''}><span class="move-icon">${icon('battle')}</span><span class="move-copy"><strong>${actor?.data.basic.name || 'Golpe básico'}</strong><small>${actor?.data.basic.description || 'Ataque básico sem custo de energia.'}</small></span><span class="move-cost">GRÁTIS</span></button><button class="move-button special-move" data-action="special" ${!actor || actor.side !== 'player' || battle.busy || actor.energy < (actor.data.special.cost || 0) ? 'disabled' : ''}><span class="move-icon">${icon('spark')}</span><span class="move-copy"><strong>${actor?.data.special.name || 'Habilidade especial'}</strong><small>${moveDescription}</small></span><span class="move-cost">${actor?.data.special.cost || 0} EN</span></button><div class="element-note"><span class="element-icon">${icon('spark')}</span><span><strong>ELEMENTO E ESQUIVA</strong><small>Vantagem causa +25%; resistência reduz 18%. Esquiva: 5–25%, conforme AGI.</small></span></div><button class="text-button" data-action="rematch">Reiniciar encontro</button></div>`}
        <div class="combat-log"><div class="log-heading"><span>REGISTRO DE COMBATE</span><span>● AO VIVO</span></div><div class="log-lines">${battle.log.slice(0, 4).map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div></div>
      </aside>
    </section>
    <p class="disclaimer-line">Protótipo de fã não comercial · modelos e trilha originais de demonstração · sem afiliação oficial.</p>`;
}

function renderDex() {
  const seasons = ['Todos', ...new Set(digimonData.roster.map((digimon) => digimon.season))];
  const entries = digimonData.roster.filter((digimon) => dexFilter === 'Todos' || digimon.season === dexFilter);
  const cards = entries.map((digimon) => {
    const owned = profile.owned.includes(digimon.id);
    return `<article class="dex-entry ${owned ? '' : 'entry-locked'}"><div class="dex-art" style="--unit-color:${digimon.color}"><span class="dex-index">${digimon.stage.toUpperCase()}</span><div class="creature-seal">${digimon.name.slice(0, 1)}</div><span class="dex-status">${owned ? 'REGISTRADO' : 'OBSERVADO'}</span></div><div class="dex-copy"><div class="dex-title"><div><span class="eyebrow">${digimon.season}</span><h2>${digimon.name}</h2></div><span class="rarity rarity-${digimon.rarity.toLowerCase()}">${digimon.rarity}</span></div><p>${digimon.description}</p><div class="dex-tags"><span>${digimon.attribute}</span><span>${digimon.element}</span><span>${digimon.role}</span></div><div class="dex-stats">${statRow('PV', digimon.stats.hp)}${statRow('ATQ', digimon.stats.attack)}${statRow('DEF', digimon.stats.defense)}${statRow('AGI', digimon.stats.agility)}</div><div class="dex-skill"><span class="skill-dot"></span><div><strong>${digimon.basic.name}</strong><small>${digimon.special.name} · ${digimon.special.cost} EN</small></div></div>${digimon.evolution ? `<div class="evolution-link">LINHA <span>${digimon.name} → ${digimonById[digimon.evolution].name}</span></div>` : ''}<details><summary>Habilidades e dados</summary><p><strong>Passiva:</strong> ${digimon.passive}</p><p><strong>Especial:</strong> ${digimon.special.description}</p><p><strong>Obtenção:</strong> Arena de teste ou recrutamento (protótipo).</p></details></div></article>`;
  }).join('');
  return `<section class="page-heading"><div><span class="eyebrow">ARQUIVO DE CAMPO · CONTEÚDO DISPONÍVEL</span><h1>Enciclopédia digital</h1><p>Registros iniciais de Adventure (1999). O catálogo das quatro temporadas ainda está em expansão.</p></div><div class="heading-count"><strong>${entries.length.toString().padStart(2, '0')}</strong><span>REGISTROS</span></div></section><div class="filter-row"><div class="filter-label">ORIGEM</div><div class="filter-pills">${seasons.map((season) => `<button class="filter-pill ${dexFilter === season ? 'selected' : ''}" data-season="${escapeHtml(season)}">${season}</button>`).join('')}</div><span class="catalog-note">FUTURO · ADVENTURE 02 · TAMERS · FRONTIER</span></div><section class="dex-grid">${cards}</section><p class="disclaimer-line">Escopo atual: registros jogáveis de teste. Aliados, vilões e formas das demais temporadas estão planejados, não implementados.</p>`;
}

function renderEvolution() {
  const current = digimonById[profile.activeForm];
  const next = current.evolution ? digimonById[current.evolution] : null;
  const requirements = requirementsFor(current);
  const available = next && requirements.every((item) => item.met);
  const preview = next ? `<div class="evolution-workbench"><div class="evolution-stage"><canvas id="evolution-canvas" aria-label="Prévia tridimensional da evolução"></canvas><div class="stage-caption"><span>${current.name}</span><i>→</i><strong>${next.name}</strong></div><span class="stage-corner">PRÉVIA 3D · SEM CUSTO</span></div><div class="evolution-details"><div class="evolution-title"><span class="eyebrow">LINHA DE ADVENTURE · 1999</span><h2>Uma nova forma.</h2><p>A próxima etapa preserva a identidade de combate e desbloqueia seu próprio conjunto de golpes.</p></div><div class="form-compare"><div class="form-name current"><small>FORMA ATUAL</small><strong>${current.name}</strong><span>Nível ${profile.digimonLevel} · ${current.role}</span></div><div class="compare-arrow">→</div><div class="form-name next"><small>FORMA SEGUINTE</small><strong>${next.name}</strong><span>${next.stage} · ${next.role}</span></div></div><div class="evolution-stats"><div class="stats-head"><span>ATRIBUTO</span><span>ATUAL</span><span>NOVO</span></div>${[['PV', current.stats.hp, next.stats.hp], ['ATQ', current.stats.attack, next.stats.attack], ['DEF', current.stats.defense, next.stats.defense], ['AGI', current.stats.agility, next.stats.agility]].map(([label, oldValue, newValue]) => `<div class="stats-compare"><span>${label}</span><strong>${oldValue}</strong><b>${newValue}<i>+${newValue - oldValue}</i></b></div>`).join('')}</div><div class="unlock-preview"><span class="unlock-icon">${icon('spark')}</span><div><small>HABILIDADES DESBLOQUEADAS</small><strong>${next.basic.name} <i>· básico</i></strong><strong>${next.special.name} <i>· especial · ${next.special.cost} EN</i></strong></div></div><div class="evolution-requirements"><div class="requirements-heading"><strong>REQUISITOS</strong><span>${requirements.filter((item) => item.met).length}/${requirements.length} atendidos</span></div>${requirements.map((item) => `<div class="requirement ${item.met ? 'met' : ''}"><span>${item.met ? '✓' : '·'}</span>${item.label}</div>`).join('')}</div><div class="evolution-actions"><button class="button button-primary" data-action="preview-evolution" ${available ? '' : 'disabled'}>${icon('evolve')} Ver confirmação</button><button class="button button-quiet" data-route="training">Treinar ${current.name}</button></div></div></div><div class="audio-evolution"><div>${icon('spark')}<span><strong>TEMA DE EVOLUÇÃO</strong><small>Síntese original · gerada no dispositivo</small></span></div><button class="audio-play" data-action="play-theme" aria-label="Ouvir tema original">▶</button></div>${evolutionPreview ? `<div class="modal-backdrop" role="presentation"><section class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><span class="eyebrow">CONFIRMAÇÃO DE EVOLUÇÃO</span><h2 id="confirm-title">${current.name} → ${next.name}</h2><p>Esta ação consumirá ${next.evolutionRequirements.filter((item) => item.includes('Núcleo de Fogo')).length} Núcleo de Fogo. O vínculo e o nível serão preservados.</p><div class="confirm-cost">CUSTO <strong>${next.evolutionRequirements.filter((item) => item.includes('Núcleo de Fogo')).length} NÚCLEO DE FOGO</strong></div><div class="modal-actions"><button class="button button-quiet" data-action="cancel-evolution">Cancelar</button><button class="button button-primary" data-action="confirm-evolution">${icon('evolve')} Evoluir agora</button></div></section></div>` : ''}` : `<div class="evolution-complete"><div class="complete-art" style="--unit-color:${current.color}">${current.name.slice(0, 1)}</div><span class="eyebrow">LINHA COMPLETA</span><h2>${current.name}</h2><p>Esta forma é o estágio final disponível nesta linha do protótipo.</p><button class="button button-quiet" data-route="dex">Ver enciclopédia</button></div>`}`;
  return `<section class="page-heading"><div><span class="eyebrow">EVOLUÇÃO · CONFIRMAÇÃO SEM SURPRESAS</span><h1>O próximo estágio.</h1><p>Prévia, custos, requisitos e novas habilidades antes de confirmar.</p></div><div class="heading-tag">${icon('evolve')} LINHA AGUMON</div></section>${preview}<p class="disclaimer-line">Formas disponíveis apenas no protótipo local. Evoluções por armadura, fusões e espíritos digitais ainda não implementados.</p>`;
}

function renderGacha() {
  const rates = [['Comum', '55%'], ['Raro', '30%'], ['Épico', '12%'], ['Lendário', '3%']];
  return `<section class="page-heading"><div><span class="eyebrow">RECRUTAMENTO · TABELA ABERTA</span><h1>Encontros de dados.</h1><p>Probabilidades e garantia aparecem antes de cada tentativa. Sem compra real neste protótipo.</p></div><div class="heading-tag">${icon('gacha')} TEMPORADA · AVENTURE 1999</div></section><section class="gacha-layout"><div class="recruit-feature"><div class="recruit-art"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="recruit-mon">${icon('spark')}</div><span class="recruit-caption">SINAL DE PARCEIRO · 001</span><span class="recruit-side-caption">ARQUIVO DA REDE</span></div><div class="recruit-copy"><span class="eyebrow">POOL DE TESTE · 4 DIGIMON</span><h2>Um novo vínculo<br>pode começar aqui.</h2><p>Agumon, Greymon, Gabumon e Patamon. Duplicatas concedem 1 fragmento; nenhuma cópia é exigida para evoluir.</p><div class="pity-meter"><div class="pity-top"><span>GARANTIA RARO OU SUPERIOR</span><strong>${profile.pity}/${pityLimit}</strong></div><div class="pity-track"><span style="width:${profile.pity / pityLimit * 100}%"></span></div><small>Na 10ª tentativa sem garantia anterior. Reinicia ao conceder a raridade garantida.</small></div><div class="pull-actions"><button class="button button-primary pull-button" data-pull="1">${icon('gacha')} 1 tentativa <strong>${profile.freePulls ? 'GRÁTIS' : '100 BITS'}</strong></button><button class="button button-outline pull-button" data-pull="10">10 tentativas <strong>900 BITS</strong></button></div><small class="free-pulls">${profile.freePulls} tentativa(s) gratuita(s) · ${profile.pulls} tentativas totais</small></div></div><aside class="rates-panel"><div class="panel-heading"><div><span class="eyebrow">INFORMAÇÃO ANTES DE TENTAR</span><h2>Probabilidades</h2></div></div><div class="rate-list">${rates.map(([name, rate]) => `<div class="rate-row"><span class="rarity-dot rarity-dot-${name.toLowerCase()}"></span><strong>${name}</strong><b>${rate}</b></div>`).join('')}</div><div class="pool-list"><span>POOL ELEGÍVEL</span>${['Agumon', 'Greymon', 'Gabumon', 'Patamon'].map((name) => `<i>${name}</i>`).join('')}</div><div class="guarantee-box"><span>${icon('spark')}</span><p><strong>Garantia clara</strong><small>A 10ª tentativa concede um resultado Raro, Épico ou Lendário. O contador reinicia após a garantia.</small></p></div><p class="rate-footnote">Sem pagamento integrado. Resultados deste teste são locais e podem ser reiniciados limpando os dados do navegador.</p></aside></section><p class="disclaimer-line">Itens, taxas e pool são configuráveis em dados do protótipo. Não há transações financeiras.</p>`;
}

function renderCodes() {
  const codeRows = promoCodes.map((code) => {
    const redeemed = profile.redeemedCodes.includes(normalizeCode(code.code));
    return `<div class="code-row ${redeemed ? 'code-redeemed' : ''}"><div class="code-mark">${icon('code')}</div><div class="code-info"><strong>${escapeHtml(code.code)}</strong><span>${escapeHtml(code.reward.label)}</span></div><div class="code-expiry">ATÉ ${new Date(`${code.expiresAt}T00:00:00`).toLocaleDateString('pt-BR')}</div><span class="code-state">${redeemed ? 'RESGATADO' : 'DISPONÍVEL'}</span></div>`;
  }).join('');
  return `<section class="page-heading"><div><span class="eyebrow">RECOMPENSAS DE BOAS-VINDAS · 5 CÓDIGOS</span><h1>Um presente por conta.</h1><p>Conteúdo e validade explícitos antes do resgate. Cada código pode ser usado uma única vez neste perfil.</p></div><div class="heading-tag">${icon('code')} ${profile.redeemedCodes.length}/5 RESGATADOS</div></section><section class="codes-layout"><div class="codes-list"><div class="codes-list-head"><span>CÓDIGO</span><span>VALIDADE</span><span>STATUS</span></div>${codeRows}</div><aside class="redeem-panel"><span class="eyebrow">RESGATE DE CÓDIGO</span><div class="redeem-icon">${icon('code')}</div><h2>Resgatar recompensa</h2><p>Os códigos de teste estão listados ao lado. O conteúdo é fixo e aparece antes de confirmar.</p><form id="redeem-form"><label for="code-input">CÓDIGO PROMOCIONAL</label><div class="code-input-row"><input id="code-input" name="code" autocomplete="off" placeholder="EX.: REDE-PRIMEIRA" required /><button class="button button-primary" type="submit" aria-label="Resgatar código">${icon('spark')}</button></div></form><div class="local-warning">${icon('spark')}<span><strong>Perfil local de demonstração</strong><small>Validação no navegador não impede fraude. Resgate seguro exige servidor autenticado.</small></span></div></aside></section><p class="disclaimer-line">Administração, validade e recompensas ficam configuráveis em <code>src/data/codes.json</code>; este protótipo não implementa backend.</p>`;
}

function renderTraining() {
  const current = digimonById[profile.activeForm];
  const cost = 80 + Math.max(0, profile.digimonLevel - 12) * 12;
  const expProgress = ((profile.digimonLevel * 17) % 100);
  return `<section class="page-heading"><div><span class="eyebrow">TREINAMENTO · PROGRESSO PERMANENTE</span><h1>Força construída junto.</h1><p>Treino aumenta o nível sem exigir duplicatas. Batalhas concedem recursos e experiência de treinador.</p></div><div class="heading-tag">${icon('training')} NÍVEL ${profile.digimonLevel}</div></section><section class="training-layout"><div class="training-main"><div class="training-profile"><div class="training-mon" style="--unit-color:${current.color}">${current.name.slice(0, 1)}</div><div class="training-profile-copy"><span class="eyebrow">PARCEIRO EM FOCO · ${current.stage.toUpperCase()}</span><h2>${current.name}</h2><p>${current.role} · ${current.element} · ${current.attribute}</p></div><span class="level-seal">NV.<strong>${profile.digimonLevel}</strong></span></div><div class="xp-heading"><span>PROGRESSO DE TREINO</span><strong>${expProgress}%</strong></div><div class="xp-track"><span style="width:${expProgress}%"></span></div><div class="training-stats">${statRow('Pontos de vida', current.stats.hp + Math.max(0, profile.digimonLevel - 12) * 4)}${statRow('Ataque', current.stats.attack + Math.max(0, profile.digimonLevel - 12))}${statRow('Agilidade', current.stats.agility)}${statRow('Vínculo', `${profile.bond} / 10`)}</div><button class="button button-primary train-button" data-action="train" ${profile.bits < cost || profile.digimonLevel >= 50 ? 'disabled' : ''}>${icon('training')} Treino individual <strong>${cost} BITS</strong></button><div class="training-method"><div><span class="method-icon">01</span><span><strong>Treino individual</strong><small>+1 nível para o parceiro atual. Custo cresce gradualmente.</small></span></div><div><span class="method-icon">02</span><span><strong>Batalha de arena</strong><small>Vitórias rendem Bits, item e +1 nível de treinador.</small></span></div><div><span class="method-icon">03</span><span><strong>Vínculo</strong><small>Missões de parceiro desbloquearão requisitos alternativos.</small></span></div></div></div><aside class="training-aside"><span class="eyebrow">PRÓXIMO MARCO</span><h2>${current.evolution ? `Evoluir para ${digimonById[current.evolution].name}` : 'Forma atual completa'}</h2><p>${current.evolution ? `Nível do Digimon ${digimonById[current.evolution].evolutionRequirements.find((item) => item.startsWith('Nível '))?.replace('Nível ', '') || '—'} · vínculo · item de evolução.` : 'Esta linha ainda não tem outra forma disponível no protótipo.'}</p><div class="milestone-list">${requirementsFor(current).map((item) => `<div class="milestone ${item.met ? 'met' : ''}"><span>${item.met ? '✓' : '○'}</span><span>${item.label}</span><b>${item.met ? 'OK' : 'PENDENTE'}</b></div>`).join('')}</div><button class="button button-quiet" data-route="evolve">Abrir prévia de evolução ${icon('spark')}</button><p class="balance-note">Saldo atual <strong>${profile.bits.toLocaleString('pt-BR')} Bits</strong></p></aside></section><p class="disclaimer-line">Nível de treinador abre conteúdos por etapas; requisitos e formas futuras permanecerão visíveis na enciclopédia.</p>`;
}

function renderSettings() {
  const setting = (key, label, description, value) => `<label class="setting-row"><span><strong>${label}</strong><small>${description}</small></span><input type="range" min="0" max="100" value="${Math.round(value * 100)}" data-setting="${key}" aria-label="${label}" /><b>${Math.round(value * 100)}%</b></label>`;
  return `<section class="page-heading"><div><span class="eyebrow">PREFERÊNCIAS · ACESSIBILIDADE</span><h1>Seu ritmo de jogo.</h1><p>Áudio e efeitos visuais podem ser ajustados sem alterar as regras da batalha.</p></div><div class="heading-tag">${icon('settings')} CONFIGURAÇÕES LOCAIS</div></section><section class="settings-layout"><div class="settings-panel"><div class="panel-heading"><div><span class="eyebrow">MIXAGEM</span><h2>Áudio</h2></div></div>${setting('music', 'Música', 'Tema original sintetizado no dispositivo.', profile.settings.music)}${setting('effects', 'Efeitos', 'Golpes, interface e efeitos de evolução.', profile.settings.effects)}${setting('voices', 'Vozes e narração', 'Faixas de voz ainda não implementadas.', profile.settings.voices)}<div class="audio-license-note">${icon('spark')}<span><strong>Trilha original de demonstração</strong><small>Sem gravações, melodias ou vozes da série.</small></span></div></div><div class="settings-panel"><div class="panel-heading"><div><span class="eyebrow">CONFORTO E DESEMPENHO</span><h2>Acessibilidade</h2></div></div><label class="toggle-row"><span><strong>Reduzir efeitos visuais</strong><small>Limita partículas, flashes e brilho de habilidades.</small></span><input type="checkbox" data-toggle="reduceEffects" ${profile.settings.reduceEffects ? 'checked' : ''} /><i></i></label><label class="toggle-row"><span><strong>Acelerar animações</strong><small>Encurta movimentos e transições de combate.</small></span><input type="checkbox" data-toggle="fastAnimations" ${profile.settings.fastAnimations ? 'checked' : ''} /><i></i></label><div class="local-warning">${icon('spark')}<span><strong>Dados locais</strong><small>Este protótipo salva progresso neste navegador. Conta, nuvem e recuperação ainda não implementadas.</small></span></div></div></section><section class="scope-panel"><span class="eyebrow">ESCOPO DO PROTÓTIPO</span><p>Conteúdo implementado: arena de teste, combate, linha Agumon, gacha, códigos e enciclopédia inicial. Conteúdo futuro: catálogo completo das quatro temporadas, DNA Digivolution, armaduras, espíritos digitais, missões, eventos e conta segura.</p><p>Uso demonstrativo não comercial. Nomes e personagens pertencem aos respectivos titulares. Lançamento requer licenciamento e revisão jurídica.</p></section>`;
}

function render() {
  const content = ({ battle: renderBattle, dex: renderDex, evolve: renderEvolution, gacha: renderGacha, codes: renderCodes, training: renderTraining, settings: renderSettings })[route]();
  document.querySelector('#app').innerHTML = shell(content);
  if (route === 'battle') setupBattleScene();
  if (route === 'evolve' && digimonById[profile.activeForm].evolution) setupEvolutionScene();
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3400);
}

function audio() {
  audioContext ||= new window.AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}

function playEvolutionSound() {
  try {
    const context = audio();
    const notes = [261.63, 329.63, 392, 523.25, 659.25, 783.99];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = index > 2 ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.14);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, profile.settings.music * 0.12), context.currentTime + index * 0.14 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.14 + 0.5);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + index * 0.14);
      oscillator.stop(context.currentTime + index * 0.14 + 0.52);
    });
  } catch {
    showToast('Áudio indisponível neste navegador.');
  }
}

function playEffectSound() {
  if (!profile.settings.effects) return;
  try {
    const context = audio();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(190, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(55, context.currentTime + 0.16);
    gain.gain.setValueAtTime(profile.settings.effects * 0.08, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.17);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.18);
  } catch { /* Audio is optional. */ }
}

function makeCreature(data) {
  const group = new THREE.Group();
  const mainMaterial = new THREE.MeshStandardMaterial({ color: data.color, roughness: 0.72, flatShading: true });
  const shadowMaterial = new THREE.MeshStandardMaterial({ color: 0x17211f, roughness: 0.92 });
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0xf3e4bd, roughness: 0.5 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x26302f, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(data.model === 'dinosaur' ? 0.78 : 0.62, 1), mainMaterial);
  body.position.y = 0.95;
  body.scale.set(1, 1.15, 0.85);
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.48, 1), mainMaterial);
  head.position.set(data.model === 'wolf' ? 0.12 : 0, 1.78, 0.18);
  head.scale.set(1.08, 0.88, 1);
  head.castShadow = true;
  group.add(head);
  const eyeGeometry = new THREE.SphereGeometry(0.075, 8, 6);
  [-0.16, 0.16].forEach((x) => {
    const eye = new THREE.Mesh(eyeGeometry, lightMaterial);
    eye.position.set(x, 1.84, 0.59);
    group.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), darkMaterial);
    pupil.position.set(x, 1.84, 0.65);
    group.add(pupil);
  });
  for (let side = -1; side <= 1; side += 2) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 0.62, 5), mainMaterial);
    leg.position.set(side * 0.36, 0.34, 0.05);
    leg.rotation.z = side * -0.12;
    group.add(leg);
  }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, data.model === 'wolf' ? 0.84 : 0.67, 5), mainMaterial);
  tail.position.set(0, 0.7, -0.78);
  tail.rotation.x = -Math.PI / 2.8;
  group.add(tail);
  if (['lizard', 'dinosaur', 'cyborg', 'warrior'].includes(data.model)) {
    for (let index = 0; index < 3; index += 1) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.48, 4), index === 0 ? lightMaterial : mainMaterial);
      spike.position.set((index - 1) * 0.27, 2.15 - Math.abs(index - 1) * 0.12, 0.1);
      spike.rotation.z = index === 0 ? 0 : (index - 1) * 0.55;
      group.add(spike);
    }
  }
  if (data.model === 'wolf' || data.model === 'winged' || data.model === 'demon') {
    for (let side = -1; side <= 1; side += 2) {
      const wing = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.02, 4), data.model === 'demon' ? shadowMaterial : mainMaterial);
      wing.position.set(side * 0.85, 1.15, -0.08);
      wing.rotation.z = side * -0.8;
      wing.rotation.x = Math.PI / 2.5;
      group.add(wing);
    }
  }
  if (data.model === 'insect') {
    for (let side = -1; side <= 1; side += 2) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.95, 4), darkMaterial);
      horn.position.set(side * 0.38, 2.03, 0.42);
      horn.rotation.z = side * -0.46;
      group.add(horn);
    }
  }
  if (data.model === 'cyborg' || data.model === 'warrior') {
    const armor = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.38, 0.62), lightMaterial);
    armor.position.set(0, 1.03, 0.38);
    armor.rotation.x = -0.15;
    group.add(armor);
  }
  group.traverse((child) => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
  return group;
}

function createArena(scene) {
  scene.background = new THREE.Color('#b7c9b8');
  scene.fog = new THREE.Fog('#b7c9b8', 14, 32);
  const hemisphere = new THREE.HemisphereLight(0xe5f5df, 0x536761, 2.2);
  scene.add(hemisphere);
  const key = new THREE.DirectionalLight(0xffe8c5, 3.5);
  key.position.set(-5, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 34), new THREE.MeshStandardMaterial({ color: 0x637a66, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.3;
  ground.receiveShadow = true;
  scene.add(ground);
  const platformMaterial = new THREE.MeshStandardMaterial({ color: 0xc1b788, roughness: 0.85, flatShading: true });
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 7.4, 0.3, 12), platformMaterial);
  platform.position.y = -0.15;
  platform.receiveShadow = true;
  platform.castShadow = true;
  scene.add(platform);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(6.05, 0.055, 5, 48), new THREE.MeshStandardMaterial({ color: 0xc58f58, roughness: 0.55 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.025;
  scene.add(ring);
  for (let index = 0; index < 9; index += 1) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.38, 3.4 + (index % 3) * 0.6, 5), new THREE.MeshStandardMaterial({ color: index % 2 ? 0x46594a : 0x596b50, flatShading: true }));
    const x = (index - 4) * 3.4;
    const z = -7 - (index % 2) * 2.2;
    trunk.position.set(x, 1.45, z);
    trunk.castShadow = true;
    scene.add(trunk);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5 + (index % 3) * 0.35, 0), new THREE.MeshStandardMaterial({ color: index % 2 ? 0x789077 : 0x849a78, roughness: 1, flatShading: true }));
    crown.position.set(x, 3.7 + (index % 3) * 0.5, z);
    crown.scale.y = 1.15;
    scene.add(crown);
  }
}

function setupBattleScene() {
  const canvas = document.querySelector('#battle-canvas');
  if (!canvas) return;
  if (activeRenderer) activeRenderer.dispose();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  activeRenderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = !profile.settings.reduceEffects;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  createArena(scene);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
  camera.position.set(0, 8.7, 13.8);
  camera.lookAt(0, 0.55, 0);
  const units = new Map();
  battle.fighters.forEach((fighter) => {
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 1.12, 0.12, 8), new THREE.MeshStandardMaterial({ color: fighter.side === 'player' ? 0x4a887b : 0x9a5753, roughness: 0.6 }));
    const x = fighter.side === 'player' ? -2.55 : 2.55;
    const z = (fighter.index - (fighter.side === 'player' ? 1 : 0.5)) * 1.85;
    pedestal.position.set(x, 0.04, z);
    pedestal.receiveShadow = true;
    scene.add(pedestal);
    const model = makeCreature(fighter.data);
    model.position.set(x, fighter.alive ? 0.1 : -0.2, z);
    model.scale.setScalar(fighter.side === 'enemy' && fighter.digimonId === 'devimon' ? 0.9 : 0.78);
    scene.add(model);
    units.set(fighter.id, { model, homeX: x, homeZ: z, fighter });
  });
  const cue = battle.lastAction;
  let effect = null;
  if (cue && Date.now() - cue.at < 1200 && !profile.settings.reduceEffects) {
    const actor = units.get(cue.actorId);
    const target = units.get(cue.targetId);
    if (actor && target) {
      const geometry = cue.special ? new THREE.IcosahedronGeometry(0.2, 1) : new THREE.SphereGeometry(0.13, 7, 5);
      effect = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: cue.special ? 0xf2c864 : 0xfff0d2 }));
      scene.add(effect);
      effect.userData.start = Date.now();
      effect.userData.from = new THREE.Vector3(actor.homeX, 1.2, actor.homeZ);
      effect.userData.to = new THREE.Vector3(target.homeX, 1.15, target.homeZ);
    }
  }
  const resize = () => {
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 440;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);
  resize();
  const start = performance.now();
  let frame = 0;
  const animate = (time) => {
    frame = requestAnimationFrame(animate);
    units.forEach(({ model, homeX, fighter }) => {
      const idle = profile.settings.reduceEffects ? 0 : Math.sin(time * 0.0018 + fighter.index * 2.4) * 0.055;
      const attacking = cue?.actorId === fighter.id && Date.now() - cue.at < 380;
      const progress = attacking ? Math.max(0, 1 - (Date.now() - cue.at) / 380) : 0;
      model.position.y = fighter.alive ? 0.1 + idle + progress * 0.45 : -0.2;
      model.position.x = homeX + (attacking ? (fighter.side === 'player' ? 0.55 : -0.55) * progress : 0);
      model.rotation.y = fighter.side === 'player' ? 0.16 : Math.PI - 0.16;
    });
    if (effect) {
      const progress = Math.min(1, (Date.now() - effect.userData.start) / (profile.settings.fastAnimations ? 180 : 360));
      effect.position.lerpVectors(effect.userData.from, effect.userData.to, progress);
      effect.scale.setScalar(cue.special ? 1 + Math.sin(time * 0.025) * 0.18 : 1);
      effect.visible = progress < 1;
    }
    renderer.render(scene, camera);
    if (time - start > 5000) {
      cancelAnimationFrame(frame);
      observer.disconnect();
    }
  };
  animate(performance.now());
}

function setupEvolutionScene() {
  const canvas = document.querySelector('#evolution-canvas');
  if (!canvas) return;
  if (activeRenderer) activeRenderer.dispose();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'low-power' });
  activeRenderer = renderer;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce8dc');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6f887c, 2.6));
  const key = new THREE.DirectionalLight(0xffedc4, 3.3);
  key.position.set(-3, 7, 5);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 30);
  camera.position.set(0, 3.7, 7.4);
  camera.lookAt(0, 1, 0);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5, 40), new THREE.MeshStandardMaterial({ color: 0xb7c8b6, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.08;
  scene.add(floor);
  const forms = [profile.activeForm, digimonById[profile.activeForm].evolution];
  forms.forEach((id, index) => {
    const data = digimonById[id];
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.3, 0.18, 10), new THREE.MeshStandardMaterial({ color: index ? 0xc19d5f : 0x668f83, roughness: 0.55 }));
    platform.position.set(index ? 1.7 : -1.7, 0, 0);
    scene.add(platform);
    const model = makeCreature(data);
    model.position.set(index ? 1.7 : -1.7, 0.12, 0);
    model.scale.setScalar(index ? 0.82 : 0.68);
    scene.add(model);
  });
  const resize = () => {
    renderer.setSize(canvas.clientWidth || 640, canvas.clientHeight || 360, false);
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);
  resize();
  let frame = 0;
  const animate = (time) => {
    frame = requestAnimationFrame(animate);
    scene.children.filter((child) => child.isGroup).forEach((model, index) => {
      model.position.y = 0.12 + Math.sin(time * 0.0018 + index) * 0.045;
      model.rotation.y = Math.sin(time * 0.0005 + index) * 0.06;
    });
    renderer.render(scene, camera);
    if (time > 8000) {
      cancelAnimationFrame(frame);
      observer.disconnect();
    }
  };
  animate(performance.now());
}

document.addEventListener('click', (event) => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    event.preventDefault();
    route = routeButton.dataset.route;
    if (route === 'battle' && !battle.currentId && !battle.ended) nextTurn();
    render();
    return;
  }
  const targetButton = event.target.closest('[data-target]');
  if (targetButton) {
    selectedTarget = targetButton.dataset.target;
    render();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'basic' || action === 'special') {
    playEffectSound();
    playerAction(action === 'special');
  }
  if (action === 'rematch') beginBattle();
  if (action === 'train') trainDigimon();
  if (action === 'preview-evolution') { evolutionPreview = true; render(); }
  if (action === 'cancel-evolution') { evolutionPreview = false; render(); }
  if (action === 'confirm-evolution') confirmEvolution();
  if (action === 'play-theme') playEvolutionSound();
  const pull = event.target.closest('[data-pull]')?.dataset.pull;
  if (pull) doPull(Number(pull));
  const season = event.target.closest('[data-season]')?.dataset.season;
  if (season) { dexFilter = season; render(); }
});

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'redeem-form') return;
  event.preventDefault();
  redeemCode(new FormData(event.target).get('code'));
});

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-setting]')) {
    profile.settings[event.target.dataset.setting] = Number(event.target.value) / 100;
    event.target.nextElementSibling.textContent = `${event.target.value}%`;
    saveProfile();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-toggle]')) {
    profile.settings[event.target.dataset.toggle] = event.target.checked;
    saveProfile();
    render();
  }
});

window.addEventListener('beforeunload', () => {
  if (activeRenderer) activeRenderer.dispose();
});

if (!battle.currentId) nextTurn();
render();