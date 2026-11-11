// Предметы: базовые сборки и ситуативные правила под драфт соперника.
// Базовая сборка берётся из OpenDota (популярные предметы героя), а если API недоступен —
// из списка ниже (герои из пулов команды) или из общей сборки по позиции.

window.CORE_BUILDS = {
  // керри
  clinkz: "power_treads orchid gungir black_king_bar",
  life_stealer: "phase_boots armlet sange_and_yasha basher",
  juggernaut: "phase_boots bfury manta abyssal_blade",
  bloodseeker: "power_treads maelstrom black_king_bar skadi",
  sven: "power_treads echo_sabre black_king_bar greater_crit",
  // мид
  lina: "phase_boots maelstrom black_king_bar greater_crit",
  nevermore: "power_treads black_king_bar greater_crit satanic",
  obsidian_destroyer: "power_treads hurricane_pike black_king_bar sheepstick",
  dragon_knight: "power_treads black_king_bar blink assault",
  zuus: "arcane_boots kaya aether_lens octarine_core",
  pudge: "phase_boots blink blade_mail shivas_guard",
  templar_assassin: "power_treads desolator blink black_king_bar",
  // оффлейн
  axe: "phase_boots blink blade_mail black_king_bar",
  legion_commander: "phase_boots blink blade_mail black_king_bar",
  tidehunter: "arcane_boots blink pipe refresher",
  centaur: "phase_boots blink crimson_guard pipe",
  night_stalker: "phase_boots echo_sabre black_king_bar basher",
  dawnbreaker: "phase_boots echo_sabre desolator black_king_bar",
  slardar: "phase_boots blink black_king_bar assault",
  skeleton_king: "phase_boots armlet blink black_king_bar",
  // саппорты
  grimstroke: "arcane_boots aether_lens glimmer_cape force_staff",
  tusk: "tranquil_boots blink solar_crest force_staff",
  lich: "arcane_boots glimmer_cape force_staff aether_lens",
  disruptor: "arcane_boots glimmer_cape force_staff aether_lens",
  bounty_hunter: "tranquil_boots spirit_vessel solar_crest blink",
  techies: "arcane_boots aether_lens force_staff octarine_core",
  hoodwink: "arcane_boots glimmer_cape force_staff aether_lens",
  shadow_shaman: "arcane_boots blink aether_lens ultimate_scepter",
  jakiro: "arcane_boots glimmer_cape force_staff aether_lens",
  oracle: "arcane_boots glimmer_cape force_staff holy_locket"
};

window.CORE_BY_POS = {
  1: "power_treads black_king_bar manta skadi",
  2: "power_treads black_king_bar blink sheepstick",
  3: "phase_boots blink black_king_bar pipe",
  4: "tranquil_boots glimmer_cape force_staff blink",
  5: "arcane_boots glimmer_cape force_staff aether_lens"
};

// Группы вражеских героев, на которые реагируют ситуативные предметы.
window.ENEMY_GROUPS = {
  illusion: "phantom_lancer naga_siren terrorblade chaos_knight meepo broodmother lycan arc_warden monkey_king",
  invis:    "riki clinkz bounty_hunter weaver nyx_assassin treant mirana invoker",
  evasion:  "phantom_assassin windrunner brewmaster",
  targeted: "lion shadow_shaman doom_bringer bane legion_commander batrider beastmaster grimstroke bloodseeker silencer",
  aoeInit:  "enigma tidehunter magnataur faceless_void earthshaker mars centaur axe sand_king puck dark_seer primal_beast",
  heal:     "huskar necrolyte alchemist abaddon life_stealer dazzle oracle omniknight witch_doctor undying morphling wisp chen warlock juggernaut largo",
  physCore: "sven juggernaut phantom_assassin ursa troll_warlord slark life_stealer chaos_knight faceless_void drow_ranger skeleton_king gyrocopter luna monkey_king lycan clinkz kez",
  passive:  "bristleback spectre phantom_assassin huskar viper ursa drow_ranger axe necrolyte faceless_void life_stealer slardar kunkka sniper troll_warlord",
  buffs:    "omniknight oracle ogre_magi wisp abaddon lich windrunner",
  mobile:   "storm_spirit queenofpain puck ember_spirit void_spirit antimage slark weaver morphling kez pangolier"
};

// Правила: группа → предмет по позиции (1..5) + пояснение.
// min — сколько героев группы нужно у соперника; magic — считать по магическому урону (теги).
window.ITEM_RULES = [
  { group: "magic", min: 3, why: "много магического урона",
    items: { 1: "black_king_bar", 2: "black_king_bar", 3: "pipe", 4: "glimmer_cape", 5: "glimmer_cape" } },
  { group: "targeted", min: 1, why: "направленные контроли",
    items: { 1: "sphere", 2: "sphere", 3: "lotus_orb", 4: "lotus_orb", 5: "lotus_orb" } },
  { group: "aoeInit", min: 2, why: "массовая инициация",
    items: { 1: "black_king_bar", 2: "black_king_bar", 4: "force_staff", 5: "force_staff" } },
  { group: "illusion", min: 1, why: "иллюзии и юниты",
    items: { 1: "mjollnir", 2: "mjollnir", 3: "shivas_guard" } },
  { group: "invis", min: 1, why: "невидимость",
    items: { 4: "dust", 5: "ward_sentry" } },
  { group: "evasion", min: 1, why: "уклонение",
    items: { 1: "monkey_king_bar", 2: "monkey_king_bar" } },
  { group: "heal", min: 1, why: "лечение и реген",
    items: { 1: "skadi", 3: "spirit_vessel", 4: "spirit_vessel", 5: "spirit_vessel" } },
  { group: "physCore", min: 2, why: "сильный физ. урон",
    items: { 3: "heavens_halberd", 4: "solar_crest", 5: "ghost" } },
  { group: "passive", min: 1, why: "сильные пассивки (нужен break)",
    items: { 1: "silver_edge", 2: "silver_edge" } },
  { group: "buffs", min: 1, why: "сейвы и баффы (нужен dispel)",
    items: { 1: "nullifier", 2: "nullifier" } },
  { group: "mobile", min: 1, why: "мобильные герои",
    items: { 1: "abyssal_blade", 2: "orchid", 4: "rod_of_atos" } }
];
