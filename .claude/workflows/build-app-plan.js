// Этап 1 из 3 цикла разработки: подготовка cycle-ветки, онбординг (если
// проект существующий) и анализ (SPEC.md).
//
// Порядок запуска цикла: build-app-plan.js → (человек читает SPEC.md) →
// build-app-architecture.js → (человек читает ARCHITECTURE.md/API_CONTRACT.md) →
// build-app-implement.js. Каждый следующий этап запускается отдельным вызовом
// Workflow с результатом предыдущего в качестве args.
//
// Скрипт намеренно ОСТАНАВЛИВАЕТСЯ после SPEC.md, ДО architect — чтобы неточное
// или неполное SPEC.md не досталось следующей, тоже дорогой (opus, high effort)
// роли как готовая, не подлежащая сомнению вводная. Читайте SPEC.md в
// cycle-ветке (особенно блок "Что стоит проверить с заказчиком до начала
// кодирования" — критичные предположения product-analyst). Правки вносите
// в сам файл в репозитории — следующие этапы читают его оттуда.
//
// Порядок шагов: devops-engineer (cycle-ветка; если develop ещё нет — сам
// выполняет "Вызов 0 — подготовка репозитория") → codebase-analyst (только для
// существующего проекта; режим выбирает сам) → qa-engineer (базовый прогон) →
// product-analyst (SPEC.md) → devops-engineer ("Фиксация документов": SPEC.md
// коммитится на cycle-ветку).
//
// args: { idea: string, existingProject?: boolean, size?: 'small' }
// Результат: { branch, currentState, firstOnboarding, baseline, spec, size, docsCommit, blocked }
//   firstOnboarding — true, если codebase-analyst в этом запуске делал полное
//   сканирование (первое подключение к существующему проекту); передаётся
//   дальше в build-app-implement.js, где включает базовый аудит у code-reviewer.

export const meta = {
  name: 'build-app-plan',
  description: 'Этап 1 из 3: онбординг+анализ — до архитектуры, SPEC.md для проверки человеком',
  phases: [
    { title: 'Onboarding' },
    { title: 'Analysis' },
  ],
}

// Общий бюджет на весь путь онбординг → деплой, а не только локальные лимиты
// попыток внутри циклов ревью/QA (история решения — docs/HISTORY.md). agent()
// и так бросает исключение, как только budget.spent() достигает budget.total
// (жёсткий потолок инструмента Workflow) — но необработанный throw посреди
// чужого вызова выглядит как поломка, а не как понятная остановка. Проверка
// здесь даёт скрипту шанс остановиться заранее, с явным логом и понятным
// blocked: 'budget' в результате. Работает только если лимит передан
// директивой вида "+500k" при запуске Workflow — budget.total иначе null, и
// это ничего не ограничивает.
const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта — ничего не делаем, нужен человек.')
  return { branch: null, currentState: null, firstOnboarding: false, baseline: null, spec: null, blocked: 'budget' }
}

function brief(text, head = 1500, tail = 800) {
  const s = String(text ?? '')
  if (s.length <= head + tail + 200) return s
  return `${s.slice(0, head)}\n[…сокращено ради экономии токенов; полный текст — в файле репозитория…]\n${s.slice(-tail)}`
}

// Облегчённый режим: args.size === 'small' — для правок в пределах одного модуля,
// без новой сущности в модели данных, нового сервиса, смены авторизации, ПДн и платежей.
// Короткое ТЗ/архитектура на более дешёвой модели и ревью с меньшим effort. Если
// агент сам решит, что задача не малая, он скажет об этом первой строкой — тогда
// перезапустите этап без size.
const size = args && args.size === 'small' ? 'small' : 'normal'
const sizeNote = size === 'small' ? 'РЕЖИМ small: задача малая, работай в облегчённом режиме по разделу "Облегчённый режим (small)" своей роли.\n\n' : ''

// Режим, в котором отработал codebase-analyst: агент выбирает его сам по
// наличию CURRENT_STATE.md, workflow получает выбор структурированно.
const STATE_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['full', 'update'], description: 'full — CURRENT_STATE.md не было, сделано полное сканирование; update — CURRENT_STATE.md был, обновлён по git diff от коммита в его шапке' },
    summary: { type: 'string', description: 'Краткая выжимка CURRENT_STATE.md человекочитаемым текстом' },
  },
  required: ['mode', 'summary'],
}

// Шаг 0: cycle-ветка должна существовать ДО того, как кто-либо начнёт писать
// файлы (CURRENT_STATE.md, SPEC.md) — всё, что коммитится, коммитится на
// cycle-ветке. Ветки создаёт только devops-engineer ("Вызов 1"); если
// репозиторий ещё не подготовлен (нет develop) — он сам сначала выполняет
// "Вызов 0". Остальные агенты веток не трогают.
const branch = await agent(
  `Новая задача: ${args.idea}\n\nПодготовь cycle-ветку от develop по своей роли devops-engineer ("Вызов 1 — начало цикла"). Если ветки develop ещё нет — сначала выполни "Вызов 0 — подготовка репозитория". Конвенцию именования веток определи по существующим веткам (git branch -a). В ответе укажи имя созданной ветки.`,
  { label: 'devops-engineer:branch', phase: 'Onboarding', agentType: 'devops-engineer', effort: 'low' }
)

let currentState = null
let firstOnboarding = false
let baseline = null
if (args.existingProject && !budgetLow()) {
  const state = await agent(
    `Ветка цикла: ${brief(branch, 300, 100)}\n\nПо своей роли codebase-analyst подготовь CURRENT_STATE.md: если файл уже есть — режим "Обновление" (git diff от коммита в его шапке), если нет — "Полное сканирование". Режим выбери сам по правилам своей роли (обычно — по наличию файла) и верни его в поле mode (full/update), как в первой строке отчёта ("Режим: ..."). Изменения закоммить сам на текущей cycle-ветке.`,
    { label: 'codebase-analyst', phase: 'Onboarding', agentType: 'codebase-analyst', effort: 'medium', schema: STATE_SCHEMA }
  )
  currentState = state.summary
  firstOnboarding = state.mode === 'full'
  if (budgetLow()) {
    log('Бюджет заканчивается после codebase-analyst — базовый прогон QA не запускаем, нужен человек.')
    return { branch, currentState, firstOnboarding, baseline, spec: null, size, blocked: 'budget' }
  }
  baseline = await agent(
    `CURRENT_STATE.md лежит в репозитории — читай сам (выжимка:\n${brief(currentState)}).\n\nЗапусти существующий набор функциональных/e2e-тестов и зафиксируй базовый результат ("Вызов 1 — базовый прогон") по своей роли qa-engineer.`,
    { label: 'qa-engineer:baseline', phase: 'Onboarding', agentType: 'qa-engineer', effort: 'medium' }
  )
} else if (args.existingProject && budgetLow()) {
  log('Бюджет заканчивается — пропускаем онбординг существующего проекта, нужен человек.')
  return { branch, currentState, firstOnboarding, baseline, spec: null, size, blocked: 'budget' }
}

if (budgetLow()) {
  log('Бюджет заканчивается перед product-analyst — останавливаемся, нужен человек.')
  return { branch, currentState, firstOnboarding, baseline, spec: null, size, blocked: 'budget' }
}

const spec = await agent(
  currentState
    ? `${sizeNote}CURRENT_STATE.md лежит в репозитории — читай сам (выжимка:\n${brief(currentState)}).\n\nЗадача от пользователя: ${args.idea}\n\nПодготовь SPEC.md как список недостающей/новой работы по своей роли product-analyst.`
    : `${sizeNote}Идея продукта от пользователя: ${args.idea}\n\nПодготовь SPEC.md по своей роли product-analyst.`,
  { label: 'product-analyst', phase: 'Analysis', agentType: 'product-analyst', ...(size === 'small' ? { model: 'sonnet', effort: 'medium' } : { effort: 'high' }) }
)

// product-analyst без Bash — SPEC.md (и приглашённые им юридические документы)
// коммитит devops-engineer, чтобы человек проверял уже зафиксированную версию.
let docsCommit = null
if (!budgetLow()) {
  docsCommit = await agent(
    'По своей роли devops-engineer выполни "Фиксацию документов": закоммить на текущей cycle-ветке новые/изменённые документы агентов без Bash (SPEC.md и прочие документы этого шага) отдельным коммитом "docs: ...", запушь cycle-ветку. Код не трогай.',
    { label: 'devops-engineer:docs-commit', phase: 'Analysis', agentType: 'devops-engineer', effort: 'low' }
  )
} else {
  log('Бюджет заканчивается — SPEC.md написан, но не закоммичен; зафиксируйте его вручную или фиксацию сделает devops в начале интеграции.')
}

log(`SPEC.md готов. Прочитайте его (особенно критичные предположения) перед тем, как запускать build-app-architecture.js — architect получит его как вводную без права сомневаться в ней. Передайте результат этого шага как args следующему${firstOnboarding ? ' (firstOnboarding: true — первое подключение, code-reviewer на этапе реализации сделает базовый аудит)' : ''}.`)

return { branch, currentState, firstOnboarding, baseline, spec, size, docsCommit, blocked: null }
