// Этап 3 из 3 цикла разработки: реализация по согласованным SPEC.md/
// ARCHITECTURE.md — код, контрактная проверка, ревью, тесты, синхронизация с
// develop, закрытие цикла (CURRENT_STATE.md, README/CHANGELOG) и интеграция
// cycle-ветки в develop с деплоем в dev/staging.
//
// Порядок запуска цикла: build-app-plan.js → build-app-architecture.js →
// build-app-implement.js. Этот скрипт запускается ПОСЛЕ того, как человек
// прочитал SPEC.md/ARCHITECTURE.md и согласен с ними (правки — прямо в файлах
// репозитория: в промпты уходит лишь выжимка, агенты читают сами файлы).
// build-app-plan.js уже подготовил cycle-ветку (devops-engineer, "Вызов 1") —
// весь этот скрипт работает внутри неё.
//
// Порядок шагов: backend ∥ frontend → контрактная проверка → code-reviewer ∥
// qa-engineer (фикс-луп) → devops: develop → cycle (sync) → если develop ушёл
// вперёд: ревью после мерджа ∥ регрессия ∥ контракт → закрытие цикла на
// cycle-ветке (codebase-analyst ∥ product-analyst "Вызов 2") → devops:
// интеграция (фиксация документов, CI, --ff-only в develop, деплой dev/staging).
//
// args: результат build-app-architecture.js —
//   { branch, spec, architecture, currentState?, firstOnboarding?, baseline?, size? }
//   firstOnboarding: true — в build-app-plan.js codebase-analyst делал полное
//   сканирование (первое подключение к существующему проекту): code-reviewer
//   дополнительно делает разовый базовый аудит всей кодовой базы.
// Результат: { branch, ..., syncedState, docsUpdate, integrated, metrics, blocked }
//   integrated — { merged, sha, deployed, reason } от devops-engineer;
//   blocked: null только при merged: true.
//
// Прод-релиз (release-candidate -> master) в этот скрипт НЕ входит — это
// отдельное, не привязанное к циклу событие, см.
// build-app-release-validate.js → build-app-release-publish.js.
// Здесь цикл заканчивается интеграцией в develop и деплоем в dev/staging.

export const meta = {
  name: 'build-app-implement',
  description: 'Этап 3 из 3: реализация по готовым SPEC.md/ARCHITECTURE.md — код, контрактная проверка, ревью, тесты, интеграция cycle-ветки в develop, синхронизация CURRENT_STATE.md и changelog',
  phases: [
    { title: 'Implementation' },
    { title: 'Review' },
    { title: 'QA' },
    { title: 'Sync' },
    { title: 'Close-out' },
    { title: 'Integrate' },
  ],
}

// Схемы структурированного ответа для решений внутри конвейера (история
// решения — docs/HISTORY.md) — вместо разбора
// текста регэкспами (hasBlockingFindings/hasOpenBugs/isReadyForDeploy раньше
// смотрели на слова вроде "блокиру", что легко ловит ложное срабатывание на
// фразе "блокирующих находок больше нет"). agent() с opts.schema заставляет
// субагента вызвать StructuredOutput с этой структурой — сам промпт роли в
// .claude/agents/*.md менять не нужно, схема — это контракт ответа именно
// для этого вызова из workflow-скрипта, отчёт человеческим языком агент
// всё равно пишет в поле summary.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviewedCommit: { type: 'string', description: 'Коммит/HEAD, по которому проведено ревью — нужен следующему recheck, чтобы считать дельту от него, а не всю ветку заново' },
    hasBlockingFindings: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
          area: { type: 'string', enum: ['backend', 'frontend', 'shared'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом, как раньше' },
  },
  required: ['hasBlockingFindings', 'findings', 'summary'],
}

const QA_SCHEMA = {
  type: 'object',
  properties: {
    readyForDeploy: { type: 'boolean' },
    openBugs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area: { type: 'string', enum: ['backend', 'frontend', 'shared'] },
          description: { type: 'string' },
          preexisting: { type: 'boolean', description: 'true — баг уже был в baseline/до этого цикла, известный техдолг, не блокер этой задачи' },
        },
        required: ['description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом, как раньше' },
  },
  required: ['readyForDeploy', 'openBugs', 'summary'],
}

// Контрактная проверка backend/frontend
// против машиночитаемой схемы, которую architect кладёт рядом с
// ARCHITECTURE.md/API_CONTRACT.md. Это готовый инструмент (schemathesis/
// dredd/openapi-core и т.п. — конкретный выбор за qa-engineer, зависит от
// формата схемы), не написанный вручную тест — поэтому дешёвая и быстрая
// проверка, которую имеет смысл гонять ДО дорогого code-reviewer (opus):
// если backend и frontend разошлись по форме интерфейса, чинить это дешевле
// сразу, а не после того как весь diff уже прошёл ревью.
const CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    contractOk: { type: 'boolean' },
    violations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          endpoint: { type: 'string' },
          method: { type: 'string' },
          area: { type: 'string', enum: ['backend', 'frontend'] },
          description: { type: 'string' },
        },
        required: ['description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом' },
  },
  required: ['contractOk', 'violations', 'summary'],
}

// Результат синхронизации develop → cycle. developMerged позволяет пропустить
// дорогие проверки после мерджа, когда мерджить было нечего.
const SYNC_SCHEMA = {
  type: 'object',
  properties: {
    developMerged: { type: 'boolean', description: 'true — в cycle-ветку реально пришли новые коммиты из develop (с конфликтом или без — неважно); false — develop не ушёл вперёд с момента ответвления, мерджить было нечего' },
    conflictsResolved: { type: 'boolean', description: 'true — были конфликты и их разрешали вручную' },
    summary: { type: 'string', description: 'Короткий отчёт: что пришло из develop, какие файлы затронуты' },
  },
  required: ['developMerged', 'summary'],
}

// Результат интеграции в develop — workflow должен знать, произошёл ли мердж
// на самом деле, а не рапортовать успех по факту того, что агент ответил.
const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean', description: 'true — cycle-ветка влита в develop (--ff-only) и develop запушен' },
    sha: { type: ['string', 'null'], description: 'SHA develop после мерджа (null, если мерджа не было)' },
    deployed: { type: 'boolean', description: 'true — develop задеплоен в dev/staging' },
    reason: { type: 'string', description: 'Что сделано; если merged=false — почему (красный CI, ff-only невозможен и т.п.)' },
  },
  required: ['merged', 'sha', 'deployed', 'reason'],
}

// Общий бюджет на весь путь (история решения — docs/HISTORY.md), а не
// только локальные лимиты попыток внутри циклов ревью/QA/контракта ниже.
// agent() и так бросает исключение, как только budget.spent() достигает
// budget.total (жёсткий потолок инструмента Workflow), но необработанный
// throw посреди чужого вызова выглядит как поломка, а не как понятная
// остановка. Проверка перед каждым новым дорогим шагом/раундом даёт скрипту
// шанс остановиться заранее, с явным логом и blocked: 'budget'. Работает
// только если лимит передан директивой вида "+500k" при запуске
// Workflow — budget.total иначе null, и это ничего не ограничивает.
const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

// Форматируют структурированный ответ в текст для следующего агента в цепочке
// (разработчику, который чинит находки, не нужен сырой JSON — нужен читаемый
// список). summary агента используем как основу, список находок — как явный
// чек-лист того, что именно нужно закрыть.
function formatReview(review) {
  const list = review.findings.map(f =>
    `- [${f.severity}${f.area ? ', ' + f.area : ''}] ${f.file ? f.file + (f.line ? ':' + f.line : '') + ' — ' : ''}${f.description}`
  ).join('\n')
  return `${brief(review.summary, 1200, 600)}\n\nНаходки:\n${list || '(нет)'}`
}

function formatQA(qa) {
  const list = qa.openBugs.map(b =>
    `- [${b.preexisting ? 'known/preexisting' : 'new'}${b.area ? ', ' + b.area : ''}] ${b.description}`
  ).join('\n')
  return `${brief(qa.summary, 1200, 600)}\n\nОткрытые баги:\n${list || '(нет)'}`
}

function formatContract(contract) {
  const list = contract.violations.map(v =>
    `- [${v.area || '?'}] ${v.method ? v.method + ' ' : ''}${v.endpoint ? v.endpoint + ' — ' : ''}${v.description}`
  ).join('\n')
  return `${brief(contract.summary, 1200, 600)}\n\nРасхождения с контрактом:\n${list || '(нет)'}`
}

function newBugs(qa) { return qa.openBugs.filter(b => !b.preexisting) }

// Экономия токенов: большие отчёты агентов не пересказываем друг другу целиком —
// SPEC.md/ARCHITECTURE.md/API_CONTRACT.md и сам код лежат в репозитории, агент
// читает их сам. Ручные правки SPEC/ARCHITECTURE вносятся в ФАЙЛЫ
// репозитория: в промпты уходит лишь сокращённая выжимка.
const DOCS = 'SPEC.md, ARCHITECTURE.md, API_CONTRACT.md (и машиночитаемая схема контракта) лежат в репозитории, в cycle-ветке — читай их сам (корень проекта; если там нет — найди через Glob).'
function brief(text, head = 1500, tail = 800) {
  const s = String(text ?? '')
  if (s.length <= head + tail + 200) return s
  return `${s.slice(0, head)}\n[…сокращено ради экономии токенов; детали — в git diff и файлах репозитория…]\n${s.slice(-tail)}`
}

// Чинить зовём только тех разработчиков, чья область реально затронута.
// Нет area / 'shared' / пустой список — на всякий случай зовём обоих.
function needsArea(items, area) {
  if (!items || items.length === 0) return true
  return items.some(i => !i.area || i.area === 'shared' || i.area === area)
}
function fixCalls(items, text, label, phase) {
  const calls = []
  for (const area of ['backend', 'frontend']) {
    if (needsArea(items, area)) {
      calls.push(() => agent(`Устрани по ${area}-части:\n${text}`,
        { label: `${area}-developer:${label}`, phase, agentType: `${area}-developer`, effort: 'medium' }))
    }
  }
  return calls
}

const { branch, spec, architecture, currentState, baseline } = args
const firstOnboarding = Boolean(args.firstOnboarding)
const size = args.size === 'small' ? 'small' : 'normal' // см. build-app-plan.js
const REVIEW_EFFORT = size === 'small' ? 'medium' : 'high'

// Метрики прогона — чтобы решения об оптимизации принимать по данным. Токены
// считаем по этапам (разница budget.spent() между контрольными точками); по
// отдельным ролям Workflow их не отдаёт. Если budget.spent() недоступен — null.
const metrics = { size, phases: {}, fixAttempts: 0, contractAttempts: 0, mergeChecksSkipped: null, totalSpent: null }
function spentNow() { try { return budget.spent() } catch (e) { return null } }
let lastSpent = spentNow()
function mark(name) {
  const now = spentNow()
  if (now != null && lastSpent != null) metrics.phases[name] = (metrics.phases[name] || 0) + (now - lastSpent)
  lastSpent = now
}

// Запись метрик в постоянный файл ВНЕ репозитория (не зависит от веток, свежих
// клонов и git clean; общий для всех параллельных рабочих копий проекта на
// машине). Скрипт Workflow сам файлы писать не умеет — делает дешёвый агент;
// из git ему нужен только read-only `git rev-parse` для имени проекта. Расход самого этого вызова в totalSpent не входит.
// Сводка по накопленному: tools/summarize_metrics.py
async function recordMetrics(result) {
  try {
    const record = {
      v: 1,
      ts: new Date().toISOString(),
      branch: String(result.branch ?? '').slice(0, 120),
      size,
      blocked: result.blocked ?? null,
      existingProject: Boolean(currentState),
      reviewFindings: result.reviewFindings ? result.reviewFindings.findings.length : null,
      qaNewBugs: result.qaVerdict ? newBugs(result.qaVerdict).length : null,
      metrics,
    }
    await agent(
      'Допиши ОДНУ строку в конец файла ~/.multiagent-metrics/<проект>.jsonl, где <проект> — вывод `basename "$(git rev-parse --show-toplevel)"` (если не получилось — `unknown`). Создай папку, если её нет. Только дописывай (>>), ничего не перезаписывай и не трогай. Из git разрешена только эта read-only команда rev-parse — никаких коммитов, переключений веток и прочих git-операций; ничего больше не меняй. Строка — ровно этот JSON, одной строкой, без переносов; записывай через heredoc с кавычками (<<\'EOF\'), чтобы не ломать экранирование. После записи проверь, что последняя строка файла парсится как JSON (python3 -c). В ответе — одна строка: путь файла и OK/ошибка.\n\n' + JSON.stringify(record),
      { label: 'metrics-recorder', phase: 'Close-out', model: 'sonnet', effort: 'low' }
    )
  } catch (e) {
    log(`Не удалось записать метрики в файл: ${e}. Скопируйте metrics из результата вручную.`)
  }
}

async function finish(result) {
  mark('last_step_or_stop')
  metrics.totalSpent = spentNow()
  log(`Метрики цикла: ${JSON.stringify(metrics)}`)
  await recordMetrics(result)
  return { ...result, metrics }
}

if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта реализации — ничего не делаем, нужен человек.')
  return await finish({ branch, spec, architecture, backend: null, frontend: null, blocked: 'budget' })
}

// backend и frontend работают параллельно по одному и тому же архитектурному плану,
// оба — в cycle-ветке, подготовленной devops-engineer. Работают в одной рабочей
// копии репозитория — это ок, пока они не трогают одни и те же файлы (см. правило
// про общие файлы в их промптах). Если в вашем проекте backend/frontend регулярно
// задевают общие файлы (общие типы, монорепо с общим конфигом) — включите
// {isolation: 'worktree'} у обоих вызовов ниже: это создаёт каждому свою git-копию
// репозитория ценой времени на подготовку и последующего ручного слияния, так что
// включайте только если конфликты реально происходят, а не "на всякий случай".
const [backend, frontend] = await parallel([
  () => agent(`Ветка: ${branch}\n\n${DOCS}\n\nКраткая выжимка архитектуры:\n${brief(architecture)}\n\nРеализуй backend по своей роли backend-developer.`,
    { label: 'backend-developer', phase: 'Implementation', agentType: 'backend-developer', effort: 'low' }),
  () => agent(`Ветка: ${branch}\n\n${DOCS}\n\nКраткая выжимка архитектуры:\n${brief(architecture)}\n\nРеализуй frontend по своей роли frontend-developer.`,
    { label: 'frontend-developer', phase: 'Implementation', agentType: 'frontend-developer', effort: 'low' }),
])

mark('implementation')

const AUTOMATED_CONTEXT = 'Это автоматический вызов из workflow-скрипта, без человека на связи — прими это как сигнал, что ты вызван как часть автоматического цикла (см. свою роль).'

// Контрактная проверка — быстрый гейт ДО code-reviewer. Если backend/frontend
// разошлись по форме интерфейса, дешевле поймать и починить это здесь
// (готовым инструментом, без ревью кода), чем платить за полное opus-ревью
// того, что всё равно не работает вместе, а потом ещё и гонять его заново.
let contractCheck = await agent(
  `${DOCS}\n\nBackend (кратко):\n${brief(backend)}\n\nFrontend (кратко):\n${brief(frontend)}\n\nПрогони контрактную проверку по своей роли qa-engineer (раздел "Контрактная проверка", первый вызов — до code-reviewer).`,
  { label: 'qa-engineer:contract', phase: 'Review', agentType: 'qa-engineer', effort: 'medium', schema: CONTRACT_SCHEMA }
)

const MAX_CONTRACT_ATTEMPTS = 2
let contractAttempts = 0
while (!contractCheck.contractOk && contractAttempts < MAX_CONTRACT_ATTEMPTS && !budgetLow()) {
  await parallel(fixCalls(contractCheck.violations, `Устрани расхождения с контрактом:\n${formatContract(contractCheck)}`, 'fix-contract', 'Review'))
  contractCheck = await agent('Повторно прогони контрактную проверку после исправлений.',
    { label: 'qa-engineer:contract-recheck', phase: 'Review', agentType: 'qa-engineer', effort: 'medium', schema: CONTRACT_SCHEMA })
  contractAttempts++
}
metrics.contractAttempts = contractAttempts
mark('contract_check')
if (!contractCheck.contractOk) {
  log(budgetLow()
    ? 'Бюджет исчерпан во время контрактных исправлений — code-reviewer не вызываем, нужен человек.'
    : `Контракт backend/frontend не сошёлся за ${MAX_CONTRACT_ATTEMPTS} попыток — code-reviewer не вызываем (нет смысла ревьюить то, что не работает вместе), нужен человек.`)
  return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings: null, qaVerdict: null, integrated: null, blocked: budgetLow() ? 'budget' : 'contract' })
}

if (budgetLow()) {
  log('Бюджет заканчивается перед code-reviewer/qa-engineer (самые дорогие оставшиеся шаги) — останавливаемся, нужен человек.')
  return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings: null, qaVerdict: null, integrated: null, blocked: 'budget' })
}

// code-reviewer и qa-engineer ("Вызов 2") гоняем параллельно, а не по очереди,
// как раньше: они смотрят на независимые входы (ревью — на diff, QA — на
// SPEC.md, explicitly "не подглядывая в реализацию") и не блокируют друг
// друга по смыслу — contractCheck выше уже отсеял базовые нестыковки формы
// интерфейса, так что смысла держать их строго последовательно нет. Фикс-луп
// объединён в один: если проблема нашлась хоть с одной стороны, чиним и
// перепроверяем оба сразу, а не гоняем два отдельных цикла с раздельными
// лимитами попыток. Раньше находки ревью уходили только backend-developer,
// хотя area находки может быть 'frontend' — заодно чиним это здесь: если
// что-то нашлось, зовём обоих разработчиков параллельно, как уже делает QA.
let [reviewFindings, qaVerdict] = await parallel([
  () => agent(
    `${AUTOMATED_CONTEXT}\n\nBackend (кратко):\n${brief(backend)}\n\nFrontend (кратко):\n${brief(frontend)}\n\nПроверь diff текущей задачи по своей роли code-reviewer (обычный вызов — вся cycle-ветка целиком относительно точки её ответвления от develop, не по отдельным коммитам).${firstOnboarding ? ' Это первое подключение к существующему проекту — дополнительно сделай отдельным разделом разовый базовый аудит всей кодовой базы.' : ''}`,
    { label: 'code-reviewer', phase: 'Review', agentType: 'code-reviewer', effort: REVIEW_EFFORT, schema: REVIEW_SCHEMA }
  ),
  () => agent(
    baseline
      ? `SPEC.md лежит в репозитории — читай сам. Выжимка:\n${brief(spec)}\n\nBaseline существующих тестов:\n${brief(baseline)}\n\nНапиши функциональные тесты на новую функциональность, прогони их и весь существующий набор, сравни с baseline — по своей роли qa-engineer ("Вызов 2 — финальная проверка"). Баги, которые уже были в baseline и не связаны с этой задачей, отметь как preexisting=true.`
      : `SPEC.md лежит в репозитории — читай сам. Выжимка:\n${brief(spec)}\n\nНапиши функциональные тесты по критериям приёмки и прогони их по своей роли qa-engineer ("Вызов 2").`,
    { label: 'qa-engineer:final', phase: 'QA', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }
  ),
])

const MAX_FIX_ATTEMPTS = 2
let fixAttempts = 0
let reviewStale = false // QA-фиксы поменяли код, а ревью после них ещё не было
while ((reviewFindings.hasBlockingFindings || newBugs(qaVerdict).length > 0) && fixAttempts < MAX_FIX_ATTEMPTS && !budgetLow()) {
  const reviewHad = reviewFindings.hasBlockingFindings
  const blocking = reviewFindings.findings.filter(f => f.severity === 'blocking')
  const qaBugs = newBugs(qaVerdict)
  const combinedIssues = [
    reviewHad ? `Находки ревью:\n${formatReview(reviewFindings)}` : null,
    qaBugs.length > 0 ? `Баги QA:\n${formatQA(qaVerdict)}` : null,
  ].filter(Boolean).join('\n\n')
  // Чиним только затронутые области (см. fixCalls).
  await parallel(fixCalls([...(reviewHad ? blocking : []), ...qaBugs], combinedIssues, 'fix', 'Review'))
  // QA перепроверяем всегда (любая правка может дать регрессию). Дорогое opus-ревью
  // перезапускаем только если у него самого были блокирующие находки; если чинили
  // одни QA-баги — ревью правок делаем один раз после цикла, а не на каждом круге.
  if (reviewHad) {
    ;[reviewFindings, qaVerdict] = await parallel([
      () => agent(`${AUTOMATED_CONTEXT}\n\nПовторно проверь diff после исправлений (recheck — дельта от коммита "${reviewFindings.reviewedCommit || '(не указан в прошлом отчёте)'}", а не вся ветка заново).`,
        { label: 'code-reviewer:recheck', phase: 'Review', agentType: 'code-reviewer', effort: REVIEW_EFFORT, schema: REVIEW_SCHEMA }),
      () => agent('Перепроверь критерии приёмки и регрессии после исправлений.',
        { label: 'qa-engineer:recheck', phase: 'QA', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }),
    ])
    reviewStale = false
  } else {
    qaVerdict = await agent('Перепроверь критерии приёмки и регрессии после исправлений.',
      { label: 'qa-engineer:recheck', phase: 'QA', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA })
    reviewStale = true
  }
  fixAttempts++
}
if (reviewStale && newBugs(qaVerdict).length === 0 && !budgetLow()) {
  reviewFindings = await agent(`${AUTOMATED_CONTEXT}\n\nПовторно проверь diff после исправлений QA-багов (recheck — дельта от коммита "${reviewFindings.reviewedCommit || '(не указан в прошлом отчёте)'}").`,
    { label: 'code-reviewer:final-delta', phase: 'Review', agentType: 'code-reviewer', effort: REVIEW_EFFORT, schema: REVIEW_SCHEMA })
}

metrics.fixAttempts = fixAttempts
mark('review_qa')
if (reviewFindings.hasBlockingFindings || !qaVerdict.readyForDeploy || newBugs(qaVerdict).length > 0) {
  log(budgetLow()
    ? 'Бюджет исчерпан во время исправлений по ревью/QA — интеграция в develop не запускалась, нужен человек.'
    : `Ревью и/или QA не сошлись за ${MAX_FIX_ATTEMPTS} попыток — дальше по конвейеру не идём без человека.`)
  return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict, integrated: null, blocked: budgetLow() ? 'budget' : (reviewFindings.hasBlockingFindings ? 'review' : 'qa') })
}

if (budgetLow()) {
  log('Бюджет заканчивается перед интеграцией в develop — QA и ревью пройдены, но останавливаемся, нужен человек.')
  return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict, integrated: null, blocked: 'budget' })
}

// Интеграция: devops-engineer сначала подтягивает develop в cycle-ветку (чтобы
// забрать параллельные изменения других веток), затем — обязательная повторная
// проверка ИМЕННО этого слияния (не всей задачи заново): code-reviewer смотрит
// diff самого мерджа, qa-engineer прогоняет полную регрессию на результате, и
// контрактную проверку — конфликт мог развести backend/frontend по
// контракту при ручном разрешении. Все три независимы друг от друга и смотрят
// на один и тот же результат мерджа — гоняем параллельно, а не по очереди.
const syncResult = await agent(
  `Ветка: ${branch}\n\nЦикл готов к интеграции (ревью и QA пройдены). Смёржи актуальный develop в эту cycle-ветку по своей роли devops-engineer (первая часть "Вызова 2" — синхронизация перед мерджем). Если возник конфликт в коде — передай его backend-developer/frontend-developer, не разрешай сам. В ответе явно укажи, пришли ли в ветку новые коммиты из develop (developMerged: true при любом реальном мердже — с конфликтами или без).`,
  { label: 'devops-engineer:sync-develop', phase: 'Sync', agentType: 'devops-engineer', effort: 'low', schema: SYNC_SCHEMA }
)

let mergeReview = null, mergeRegression = null, mergeContract = null
if (!syncResult.developMerged) {
  log('develop не ушёл вперёд с начала цикла — ревью/регрессию/контракт после мерджа пропускаем (мерджить было нечего).')
} else {
;[mergeReview, mergeRegression, mergeContract] = await parallel([
  () => agent(
    `${AUTOMATED_CONTEXT}\n\nРезультат мерджа develop в cycle-ветку:\n${brief(syncResult.summary)}\n\nПроверь по своей роли code-reviewer, режим "ревью после мерджа develop → cycle" — diff именно этого мерджа, с особым вниманием к файлам, тронутым при разрешении конфликтов.`,
    { label: 'code-reviewer:merge-review', phase: 'Sync', agentType: 'code-reviewer', effort: REVIEW_EFFORT, schema: REVIEW_SCHEMA }
  ),
  () => agent(
    `Результат мерджа develop в cycle-ветку:\n${brief(syncResult.summary)}\n\nПерепрогони полную регрессию по своей роли qa-engineer ("Вызов 3 — регрессия после интеграции develop → cycle").`,
    { label: 'qa-engineer:post-merge', phase: 'Sync', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }
  ),
  () => agent(
    `Результат мерджа develop в cycle-ветку:\n${brief(syncResult.summary)}\n\nПовторно прогони контрактную проверку по своей роли qa-engineer (раздел "Контрактная проверка", второй вызов — после мерджа develop → cycle).`,
    { label: 'qa-engineer:merge-contract', phase: 'Sync', agentType: 'qa-engineer', effort: 'medium', schema: CONTRACT_SCHEMA }
  ),
])

// Один раунд исправлений на проблемы, которые принёс именно мердж — если и после
// него не сошлось (или кончился бюджет), это блокер для человека, а не повод
// пытаться бесконечно.
if (mergeReview.hasBlockingFindings || newBugs(mergeRegression).length > 0 || !mergeContract.contractOk) {
  if (budgetLow()) {
    log('Бюджет исчерпан на проверках после мерджа develop → cycle — в develop не мерджим, нужен человек.')
    return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict, mergeReview, mergeRegression, mergeContract, integrated: null, blocked: 'budget' })
  }
  await parallel(fixCalls(
    [...mergeReview.findings.filter(f => f.severity === 'blocking'), ...newBugs(mergeRegression), ...mergeContract.violations],
    `Проблемы после интеграции develop → cycle:\nРевью:\n${formatReview(mergeReview)}\n\nРегрессия:\n${formatQA(mergeRegression)}\n\nКонтракт:\n${formatContract(mergeContract)}`,
    'fix-merge', 'Integrate'))
  ;[mergeReview, mergeRegression, mergeContract] = await parallel([
    () => agent(`${AUTOMATED_CONTEXT}\n\nПовторно проверь diff мерджа после исправлений.`,
      { label: 'code-reviewer:merge-recheck', phase: 'Sync', agentType: 'code-reviewer', effort: REVIEW_EFFORT, schema: REVIEW_SCHEMA }),
    () => agent('Перепроверь регрессию после исправлений.',
      { label: 'qa-engineer:post-merge-recheck', phase: 'Sync', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }),
    () => agent('Перепроверь контрактную проверку после исправлений.',
      { label: 'qa-engineer:merge-contract-recheck', phase: 'Sync', agentType: 'qa-engineer', effort: 'medium', schema: CONTRACT_SCHEMA }),
  ])
  if (mergeReview.hasBlockingFindings || newBugs(mergeRegression).length > 0 || !mergeContract.contractOk) {
    log('Интеграция develop → cycle не сошлась после исправления — нужен человек, в develop не мерджим.')
    return await finish({ branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict, mergeReview, mergeRegression, mergeContract, integrated: null, blocked: 'integrate' })
  }
}

}
metrics.mergeChecksSkipped = !syncResult.developMerged
mark('develop_sync_and_merge_checks')

// Закрываем цикл ДО мерджа, на cycle-ветке: пока SPEC.md/ARCHITECTURE.md/отчёты
// агентов ещё свежие — точечно обновить CURRENT_STATE.md сейчас намного
// надёжнее, чем пытаться понять то же самое по одному git diff в следующий раз;
// и в develop документация приходит вместе с кодом одним ff-only мерджем. Два
// независимых обновления, можно параллельно: codebase-analyst обновляет (или,
// если CURRENT_STATE.md ещё нет, создаёт полным сканированием — режим выбирает
// сам) CURRENT_STATE.md и сам коммитит его на cycle-ветке; product-analyst
// ("Вызов 2") обновляет "О проекте" в README.md и добавляет запись в
// "Unreleased" CHANGELOG.md — без коммита, его документы зафиксирует
// devops-engineer в начале интеграции. Версию/дату и пользовательские гайды
// technical-writer здесь НЕ трогаем: это происходит в момент релиза
// (build-app-release-publish.js). Если бюджет уже на исходе — закрытие цикла
// пропускаем с явным логом, интеграция всё равно идёт.
// Тот же формат, что в build-app-plan.js: режим codebase-analyst фиксируется
// структурированно, а не угадывается по тексту.
const STATE_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['full', 'update'], description: 'full — CURRENT_STATE.md не было, сделано полное сканирование; update — CURRENT_STATE.md был, обновлён по git diff от коммита в его шапке' },
    summary: { type: 'string', description: 'Краткая выжимка CURRENT_STATE.md человекочитаемым текстом' },
  },
  required: ['mode', 'summary'],
}
let syncedState = null
let docsUpdate = null
if (!budgetLow()) {
  ;[syncedState, docsUpdate] = await parallel([
    () => agent(
      `Цикл готов к интеграции (ревью, QA и проверки после синхронизации с develop пройдены). Ветка: ${branch}\n\nSPEC.md и ARCHITECTURE.md этого цикла лежат в репозитории.${currentState ? `\n\nПрежняя выжимка CURRENT_STATE.md:\n${brief(currentState, 800, 400)}` : ''}\n\nПо своей роли codebase-analyst приведи CURRENT_STATE.md в соответствие с текущим HEAD cycle-ветки: если файл есть — режим "Обновление" (git diff/log от коммита в его шапке, не пересканируй с нуля), если нет — "Полное сканирование", чтобы следующий цикл мог стартовать как для существующего проекта. Режим выбери сам по правилам своей роли (обычно — по наличию файла) и укажи его первой строкой отчёта ("Режим: ..."). Закоммить CURRENT_STATE.md сам на текущей cycle-ветке; ветки не переключай, в develop не мерджи и не пушь.`,
      { label: 'codebase-analyst:close-out', phase: 'Close-out', agentType: 'codebase-analyst', ...(currentState ? { model: 'sonnet' } : {}), effort: 'medium', schema: STATE_SCHEMA }
    ),
    () => agent(
      `Цикл готов к интеграции в develop. SPEC.md этого цикла лежит в репозитории — читай сам.\n\nВердикт QA:\n${formatQA(qaVerdict)}\n\nОбнови раздел "О проекте" в README.md и добавь запись в раздел "Unreleased" CHANGELOG.md по своей роли product-analyst ("Вызов 2") — по факту того, что реально было поставлено, а не по изначальному плану. Правь точечно (Edit), чужие разделы не трогай. Версию/дату не проставляй — это отдельный шаг в момент релиза. Коммитить не нужно — документы зафиксирует devops-engineer.`,
      { label: 'product-analyst:docs', phase: 'Close-out', agentType: 'product-analyst', model: 'sonnet', effort: 'low' }
    ),
  ])
  mark('close_out')
} else {
  log('Бюджет на исходе — закрытие цикла (CURRENT_STATE.md, README/CHANGELOG) пропущено, сделайте его отдельно; интеграцию в develop всё равно выполняем.')
}

// Сборка/CI и мердж cycle-ветки в develop + деплой в dev/staging (не прод —
// прод-релиз отдельным событием, см.
// build-app-release-validate.js/build-app-release-publish.js).
const integrated = await agent(
  `Ветка: ${branch}\n\nИнтеграция подтверждена (ревью, QA и проверки после синхронизации с develop чистые, документы цикла обновлены). По своей роли devops-engineer (вторая часть "Вызова 2"): зафиксируй незакоммиченные документы агентов отдельным коммитом "docs: ...", запушь cycle-ветку, дождись зелёного CI на этом SHA, влей её в develop строго --ff-only, запушь develop и задеплой в dev/staging. Если что-то из этого не удалось — не обходи, верни merged=false и причину в reason.`,
  { label: 'devops-engineer:integrate', phase: 'Integrate', agentType: 'devops-engineer', effort: 'low', schema: INTEGRATE_SCHEMA }
)
mark('integrate')

if (!integrated.merged) {
  log(`Интеграция в develop НЕ выполнена: ${integrated.reason}. Цикл не завершён — нужен человек.`)
  return await finish({
    branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict,
    mergeReview, mergeRegression, mergeContract, syncedState, docsUpdate, integrated,
    blocked: 'integrate',
  })
}
if (!integrated.deployed) {
  log(`Цикл влит в develop (${integrated.sha}), но деплой в dev/staging не выполнен: ${integrated.reason}`)
}

return await finish({
  branch, spec, architecture, backend, frontend, contractCheck, reviewFindings, qaVerdict,
  mergeReview, mergeRegression, mergeContract, syncedState, docsUpdate, integrated,
  blocked: null,
})
