// Этап 2 из 3 цикла разработки: архитектура (ARCHITECTURE.md, API_CONTRACT.md
// и машиночитаемая схема контракта) по согласованному SPEC.md.
//
// Порядок запуска цикла: build-app-plan.js → build-app-architecture.js →
// build-app-implement.js. Этот скрипт запускается ПОСЛЕ того, как человек
// прочитал SPEC.md в cycle-ветке и согласен с ним (правки — прямо в файле
// репозитория). Специально ОТДЕЛЁН от build-app-plan.js (не согласованное
// SPEC.md не должно доставаться architect как готовая вводная) и от
// build-app-implement.js (та же логика: не согласованная архитектура не
// должна доставаться реализации) — обе точки остановки одинаково дёшевы по
// сравнению с переписыванием уже написанного кода. В конце devops-engineer
// коммитит документы architect на cycle-ветку ("Фиксация документов") —
// человек проверяет уже зафиксированную версию.
//
// args: результат build-app-plan.js —
//   { branch, spec, currentState?, firstOnboarding?, baseline?, size? }
// Результат: { branch, currentState, firstOnboarding, baseline, spec, architecture, size, docsCommit, blocked }

export const meta = {
  name: 'build-app-architecture',
  description: 'Этап 2 из 3: архитектура по согласованному SPEC.md — до реализации, для проверки человеком',
  phases: [
    { title: 'Architecture' },
  ],
}

const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

function brief(text, head = 1500, tail = 800) {
  const s = String(text ?? '')
  if (s.length <= head + tail + 200) return s
  return `${s.slice(0, head)}\n[…сокращено ради экономии токенов; полный текст — в файле репозитория…]\n${s.slice(-tail)}`
}

const { branch, currentState, baseline, spec } = args
const firstOnboarding = Boolean(args.firstOnboarding)

// Облегчённый режим: args.size === 'small' — для правок в пределах одного модуля,
// без новой сущности в модели данных, нового сервиса, смены авторизации, ПДн и платежей.
// Короткое ТЗ/архитектура на более дешёвой модели и ревью с меньшим effort. Если
// агент сам решит, что задача не малая, он скажет об этом первой строкой — тогда
// перезапустите этап без size.
const size = args && args.size === 'small' ? 'small' : 'normal'
const sizeNote = size === 'small' ? 'РЕЖИМ small: задача малая, работай в облегчённом режиме по разделу "Облегчённый режим (small)" своей роли.\n\n' : ''

// SPEC.md целиком в промпт не кладём: architect читает актуальный файл сам
// (человек мог его поправить после этапа 1), здесь — только выжимка.
const SPEC_REF = `SPEC.md лежит в репозитории, в cycle-ветке (корень проекта; если там нет — найди через Glob) — читай актуальную версию файла сам, она главнее выжимки. Выжимка:\n${brief(spec)}`

if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта архитектуры — ничего не делаем, нужен человек.')
  return { branch, currentState, firstOnboarding, baseline, spec, architecture: null, size, blocked: 'budget' }
}

const architecture = await agent(
  currentState
    ? `${sizeNote}CURRENT_STATE.md лежит в репозитории — читай сам (выжимка:\n${brief(currentState)}).\n\n${SPEC_REF}\n\nПодготовь ARCHITECTURE.md и API_CONTRACT.md (плюс машиночитаемую схему контракта) как расширение существующей системы по своей роли architect.`
    : `${sizeNote}${SPEC_REF}\n\nПодготовь ARCHITECTURE.md и API_CONTRACT.md (плюс машиночитаемую схему контракта) по своей роли architect.`,
  { label: 'architect', phase: 'Architecture', agentType: 'architect', ...(size === 'small' ? { model: 'sonnet', effort: 'medium' } : { effort: 'high' }) }
)

// architect без Bash — его документы коммитит devops-engineer.
let docsCommit = null
if (!budgetLow()) {
  docsCommit = await agent(
    'По своей роли devops-engineer выполни "Фиксацию документов": закоммить на текущей cycle-ветке новые/изменённые документы агентов без Bash (ARCHITECTURE.md, API_CONTRACT.md, машиночитаемая схема контракта, правки SPEC.md) отдельным коммитом "docs: ...", запушь cycle-ветку. Код не трогай.',
    { label: 'devops-engineer:docs-commit', phase: 'Architecture', agentType: 'devops-engineer', effort: 'low' }
  )
} else {
  log('Бюджет заканчивается — архитектура написана, но не закоммичена; фиксацию сделает devops в начале интеграции или выполните её вручную.')
}

log('Архитектура готова. Прочитайте ARCHITECTURE.md/API_CONTRACT.md перед тем, как запускать build-app-implement.js с результатом этого шага в качестве args.')

return { branch, currentState, firstOnboarding, baseline, spec, architecture, size, docsCommit, blocked: null }
