// Быстрый флоу для маленькой фичи, которая не требует проработки: один запуск
// без остановок на человека, без SPEC.md/ARCHITECTURE.md и без отдельных
// этапов плана и архитектуры. Подходит для правки в пределах уже
// существующего модуля: поменять поведение, добавить поле в форму или ответ
// без смены модели данных, поправить текст/валидацию/вёрстку и т.п.
//
// Чем отличается от size: 'small' в build-app-plan.js: small сохраняет три
// этапа и две остановки на человека (короткие SPEC.md/ARCHITECTURE.md);
// quick заменяет оба документа карточкой задачи из триажа и идёт до develop
// одним прогоном. Защита от того, чтобы через quick не проскочила «большая»
// задача, — не человек, а явные критерии допуска (см. TRIAGE_SCHEMA) и право
// любого агента по ходу эскалировать: «Задача не малая, нужен полный режим».
//
// Порядок шагов: product-analyst (триаж, только чтение) → devops-engineer
// (cycle-ветка cycle/<NNN>-quick-<slug>) → backend и/или frontend по
// карточке → code-reviewer ∥ qa-engineer (тесты по критериям + регрессия
// затронутой области) ∥ product-analyst (строка в "Unreleased" CHANGELOG.md)
// → не больше одного круга исправлений → devops: develop → cycle (sync) →
// если develop ушёл вперёд: регрессия QA (+ ревью мерджа, если были
// конфликты) → devops: интеграция (фиксация документов, CI, --ff-only в
// develop, деплой dev/staging).
//
// Что сознательно пропускается: SPEC.md, ARCHITECTURE.md, контрактная
// проверка (изменение API-контракта — критерий НЕдопуска), базовый аудит,
// обновление CURRENT_STATE.md (следующий полный цикл в режиме "Обновление"
// подхватит изменения quick-циклов через git diff от коммита в шапке файла),
// README «О проекте» (маленькая фича его не меняет).
//
// args: { idea: string, existingProject?: boolean }
// Результат: { branch, triage, implementation, reviewFindings, qaVerdict,
//   changelog, syncResult, mergeChecks, integrated, metrics, blocked }
//   blocked: null | 'budget' | 'not-quick' | 'escalate' | 'review' | 'qa' | 'integrate'
//   'not-quick' / 'escalate' — задача не прошла критерии быстрого флоу: запустите
//   обычный цикл (build-app-plan.js, при необходимости с size: 'small').

export const meta = {
  name: 'build-app-quick',
  description: 'Быстрый флоу для маленькой фичи без проработки: триаж → ветка → реализация → ревью и QA → интеграция в develop, одним прогоном без остановок',
  phases: [
    { title: 'Triage' },
    { title: 'Implementation' },
    { title: 'Review' },
    { title: 'Sync' },
    { title: 'Integrate' },
  ],
}

// Критерии допуска — единые для триажа и для эскалации по ходу работы.
const QUICK_CRITERIA = `Критерии быстрого флоу (все должны выполняться):
- правка в пределах уже существующего модуля/экрана, ориентировочно до нескольких файлов на сторону;
- без новой сущности или изменения модели данных и без миграций БД;
- без изменения API-контракта (новые/изменённые эндпоинты, поля запросов/ответов, коды ошибок);
- без авторизации/прав доступа, персональных данных, платежей, безопасности;
- без новых внешних зависимостей и сервисов, без изменения инфраструктуры/CI;
- требования однозначны: критерии приёмки можно записать без вопросов к заказчику.`

const ESCALATE = 'Если по ходу работы выясняется, что задача не проходит эти критерии, — ничего не коммить, верни escalate=true и причину: задача уйдёт в обычный цикл.'

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    eligible: { type: 'boolean', description: 'true — задача проходит ВСЕ критерии быстрого флоу' },
    reason: { type: 'string', description: 'Почему подходит или какой критерий нарушен' },
    slug: { type: 'string', description: 'Короткий kebab-case идентификатор задачи латиницей, 2–4 слова' },
    area: { type: 'string', enum: ['backend', 'frontend', 'both'] },
    acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '2–5 проверяемых критериев приёмки' },
    outOfScope: { type: 'array', items: { type: 'string' }, description: 'Что явно не входит' },
    changelogEntry: { type: 'string', description: 'Одна строка для "Unreleased" в CHANGELOG.md — языком пользователя, не разработчика' },
  },
  required: ['eligible', 'reason', 'slug', 'area', 'acceptanceCriteria', 'outOfScope', 'changelogEntry'],
}

const DEV_SCHEMA = {
  type: 'object',
  properties: {
    escalate: { type: 'boolean', description: 'true — задача не проходит критерии быстрого флоу, ничего не закоммичено' },
    reason: { type: 'string' },
    summary: { type: 'string', description: 'Что сделано: файлы, коммиты, unit-тесты' },
  },
  required: ['escalate', 'summary'],
}

// Схемы ниже — те же, что в build-app-implement.js (история решения —
// docs/HISTORY.md).
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviewedCommit: { type: 'string', description: 'Коммит/HEAD, по которому проведено ревью' },
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
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом' },
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
          preexisting: { type: 'boolean', description: 'true — баг был до этой задачи, известный техдолг, не блокер' },
        },
        required: ['description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом' },
  },
  required: ['readyForDeploy', 'openBugs', 'summary'],
}

const SYNC_SCHEMA = {
  type: 'object',
  properties: {
    developMerged: { type: 'boolean', description: 'true — в cycle-ветку реально пришли новые коммиты из develop (с конфликтом или без)' },
    conflictsResolved: { type: 'boolean', description: 'true — были конфликты и их разрешали вручную' },
    summary: { type: 'string', description: 'Что пришло из develop, какие файлы затронуты' },
  },
  required: ['developMerged', 'summary'],
}

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean', description: 'true — cycle-ветка влита в develop (--ff-only) и develop запушен' },
    sha: { type: ['string', 'null'], description: 'SHA develop после мерджа (null, если мерджа не было)' },
    deployed: { type: 'boolean', description: 'true — develop задеплоен в dev/staging' },
    reason: { type: 'string', description: 'Что сделано; если merged=false — почему' },
  },
  required: ['merged', 'sha', 'deployed', 'reason'],
}

const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

function brief(text, head = 1500, tail = 800) {
  const s = String(text ?? '')
  if (s.length <= head + tail + 200) return s
  return `${s.slice(0, head)}\n[…сокращено ради экономии токенов; детали — в git diff и файлах репозитория…]\n${s.slice(-tail)}`
}

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

function newBugs(qa) { return qa.openBugs.filter(b => !b.preexisting) }

const AUTOMATED_CONTEXT = 'Это автоматический вызов из workflow-скрипта, без человека на связи — прими это как сигнал, что ты вызван как часть автоматического цикла (см. свою роль).'
const QUICK_NOTE = 'РЕЖИМ quick: маленькая задача без SPEC.md/ARCHITECTURE.md, работай по разделу "Быстрый режим (quick)" своей роли. Вместо SPEC.md — карточка задачи ниже.'

// Метрики — в тот же файл, что и у build-app-implement.js, с size: 'quick',
// чтобы tools/summarize_metrics.py сравнивал быстрый флоу с обычным.
const metrics = { size: 'quick', phases: {}, fixAttempts: 0, mergeChecksSkipped: null, totalSpent: null }
function spentNow() { try { return budget.spent() } catch (e) { return null } }
let lastSpent = spentNow()
function mark(name) {
  const now = spentNow()
  if (now != null && lastSpent != null) metrics.phases[name] = (metrics.phases[name] || 0) + (now - lastSpent)
  lastSpent = now
}

async function finish(result) {
  mark('last_step_or_stop')
  metrics.totalSpent = spentNow()
  log(`Метрики quick-цикла: ${JSON.stringify(metrics)}`)
  try {
    const record = {
      v: 1,
      ts: new Date().toISOString(),
      branch: String(result.branch ?? '').slice(0, 120),
      size: 'quick',
      blocked: result.blocked ?? null,
      existingProject: Boolean(args && args.existingProject),
      reviewFindings: result.reviewFindings ? result.reviewFindings.findings.length : null,
      qaNewBugs: result.qaVerdict ? newBugs(result.qaVerdict).length : null,
      metrics,
    }
    await agent(
      'Допиши ОДНУ строку в конец файла ~/.multiagent-metrics/<проект>.jsonl, где <проект> — вывод `basename "$(git rev-parse --show-toplevel)"` (если не получилось — `unknown`). Создай папку, если её нет. Только дописывай (>>), ничего не перезаписывай и не трогай. Из git разрешена только эта read-only команда rev-parse — никаких коммитов, переключений веток и прочих git-операций; ничего больше не меняй. Строка — ровно этот JSON, одной строкой, без переносов; записывай через heredoc с кавычками (<<\'EOF\'), чтобы не ломать экранирование. После записи проверь, что последняя строка файла парсится как JSON (python3 -c). В ответе — одна строка: путь файла и OK/ошибка.\n\n' + JSON.stringify(record),
      { label: 'metrics-recorder', phase: 'Integrate', model: 'sonnet', effort: 'low' }
    )
  } catch (e) {
    log(`Не удалось записать метрики в файл: ${e}. Скопируйте metrics из результата вручную.`)
  }
  return { ...result, metrics }
}

const idea = args && args.idea
if (!idea) {
  log('Не передана задача: запустите с args { idea: "..." }.')
  return { branch: null, triage: null, blocked: 'not-quick' }
}
if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта — ничего не делаем.')
  return { branch: null, triage: null, blocked: 'budget' }
}

// 1. Триаж — дешёвый вызов только на чтение: решает, подходит ли задача для
// быстрого флоу, и сразу формирует карточку задачи вместо SPEC.md. Ветку
// создаём ПОСЛЕ триажа: неподходящая задача не оставляет пустой cycle-ветки.
const triage = await agent(
  `${QUICK_NOTE}\n\nЗадача: ${idea}\n\n${QUICK_CRITERIA}\n\nПо своей роли product-analyst проведи триаж (раздел "Быстрый режим (quick)"): загляни в код/CURRENT_STATE.md ровно настолько, чтобы честно оценить критерии; ничего не пиши и не меняй. Если хоть один критерий не выполняется или требования неоднозначны — eligible=false.`,
  { label: 'product-analyst:triage', phase: 'Triage', agentType: 'product-analyst', model: 'sonnet', effort: 'medium', schema: TRIAGE_SCHEMA }
)
mark('triage')

if (!triage.eligible) {
  log(`Задача не подходит для быстрого флоу: ${triage.reason}. Запустите обычный цикл: build-app-plan.js (при необходимости с size: 'small').`)
  return await finish({ branch: null, triage, blocked: 'not-quick' })
}

const card = [
  `Карточка задачи (quick): ${idea}`,
  `Критерии приёмки:\n${triage.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`,
  triage.outOfScope.length ? `Не входит:\n${triage.outOfScope.map(c => `- ${c}`).join('\n')}` : null,
].filter(Boolean).join('\n\n')

// 2. Ветка — обычный "Вызов 1" devops-engineer, с префиксом quick в slug,
// чтобы такие циклы было видно в истории веток.
const branch = await agent(
  `Новая задача (быстрый флоу): ${idea}\n\nПодготовь cycle-ветку от develop по своей роли devops-engineer ("Вызов 1 — начало цикла"; если develop ещё нет — сначала "Вызов 0"). Slug ветки: quick-${triage.slug}. В ответе — имя ветки и коммит, от которого она создана.`,
  { label: 'devops-engineer:branch', phase: 'Triage', agentType: 'devops-engineer', effort: 'low' }
)

// 3. Реализация — только нужные стороны. Разработчик может эскалировать.
const areas = triage.area === 'both' ? ['backend', 'frontend'] : [triage.area]
const devResults = await parallel(areas.map(area => () => agent(
  `${QUICK_NOTE}\n\nВетка: ${brief(branch, 300, 100)}\n\n${card}\n\n${QUICK_CRITERIA}\n\n${ESCALATE}\n\nРеализуй ${area}-часть по своей роли ${area}-developer: код, unit-тесты на изменённую логику, коммиты на текущей cycle-ветке.`,
  { label: `${area}-developer`, phase: 'Implementation', agentType: `${area}-developer`, effort: 'low', schema: DEV_SCHEMA }
)))
const implementation = Object.fromEntries(areas.map((a, i) => [a, devResults[i]]))
mark('implementation')

const escalated = devResults.find(r => r.escalate)
if (escalated) {
  log(`Разработчик эскалировал задачу: ${escalated.reason || escalated.summary}. Ветка ${brief(branch, 200, 0)} остаётся как есть (в develop не влита); запустите обычный цикл.`)
  return await finish({ branch, triage, implementation, blocked: 'escalate' })
}

const implSummary = areas.map(a => `${a}:\n${brief(implementation[a].summary, 800, 300)}`).join('\n\n')

// Чинить зовём только тех, чья область затронута и кто вообще участвует в задаче.
function fixCalls(items, text, label) {
  return areas
    .filter(area => !items || items.length === 0 || items.some(i => !i.area || i.area === 'shared' || i.area === area))
    .map(area => () => agent(`${QUICK_NOTE}\n\n${card}\n\nУстрани по ${area}-части:\n${text}\n\n${ESCALATE}`,
      { label: `${area}-developer:${label}`, phase: 'Review', agentType: `${area}-developer`, effort: 'medium', schema: DEV_SCHEMA }))
}

if (budgetLow()) {
  log('Бюджет заканчивается перед ревью/QA — останавливаемся, ветка с реализацией осталась.')
  return await finish({ branch, triage, implementation, blocked: 'budget' })
}

// 4. Ревью ∥ QA ∥ строка в CHANGELOG — независимые входы, гоняем параллельно.
// Строка CHANGELOG пишется сейчас, а не в конце: маленькая фича почти не
// расходится с карточкой, а при неудаче ветка всё равно не попадёт в develop.
let [reviewFindings, qaVerdict, changelog] = await parallel([
  () => agent(
    `${AUTOMATED_CONTEXT}\n\n${QUICK_NOTE}\n\n${card}\n\nРеализация (кратко):\n${implSummary}\n\nПроверь по своей роли code-reviewer diff всей cycle-ветки относительно точки её ответвления от develop. Отдельно проверь, что изменение действительно укладывается в критерии быстрого флоу (нет изменений модели данных, API-контракта, авторизации, ПДн, платежей, зависимостей) — нарушение критериев оформи как blocking-находку с пометкой "[не quick]".\n\n${QUICK_CRITERIA}`,
    { label: 'code-reviewer', phase: 'Review', agentType: 'code-reviewer', effort: 'medium', schema: REVIEW_SCHEMA }
  ),
  () => agent(
    `${QUICK_NOTE}\n\n${card}\n\nПо своей роли qa-engineer (раздел "Быстрый режим (quick)"): напиши функциональные тесты по критериям приёмки из карточки, прогони их и существующие тесты затронутой области. Баги, которые были до этой задачи, отметь preexisting=true.`,
    { label: 'qa-engineer:quick', phase: 'Review', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }
  ),
  () => agent(
    `${QUICK_NOTE}\n\nДобавь в раздел "Unreleased" CHANGELOG.md (создай файл по своей роли, если его нет) одну запись по своей роли product-analyst:\n${triage.changelogEntry}\n\nПравь точечно (Edit), чужие разделы и README не трогай, версию/дату не ставь. Коммитить не нужно — документы зафиксирует devops-engineer.`,
    { label: 'product-analyst:changelog', phase: 'Review', agentType: 'product-analyst', model: 'sonnet', effort: 'low' }
  ),
])

// 5. Не больше одного круга исправлений: если маленькая задача не сходится с
// первого раза — это сигнал, что она не такая маленькая, и дальше её должен
// смотреть человек или обычный цикл, а не бесконечный фикс-луп.
const quickViolation = reviewFindings.findings.some(f => f.severity === 'blocking' && /\[не quick\]/i.test(f.description))
if (quickViolation) {
  log('code-reviewer нашёл выход за критерии быстрого флоу — в develop не вливаем, запустите обычный цикл.')
  return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, blocked: 'escalate' })
}

if ((reviewFindings.hasBlockingFindings || newBugs(qaVerdict).length > 0) && !budgetLow()) {
  metrics.fixAttempts = 1
  const reviewHad = reviewFindings.hasBlockingFindings
  const blocking = reviewFindings.findings.filter(f => f.severity === 'blocking')
  const qaBugs = newBugs(qaVerdict)
  const issues = [
    reviewHad ? `Находки ревью:\n${formatReview(reviewFindings)}` : null,
    qaBugs.length > 0 ? `Баги QA:\n${formatQA(qaVerdict)}` : null,
  ].filter(Boolean).join('\n\n')
  const fixes = await parallel(fixCalls([...(reviewHad ? blocking : []), ...qaBugs], issues, 'fix'))
  const fixEscalated = fixes.find(r => r.escalate)
  if (fixEscalated) {
    log(`При исправлении задача эскалирована: ${fixEscalated.reason || fixEscalated.summary}. Запустите обычный цикл.`)
    return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, blocked: 'escalate' })
  }
  // Ревью перепроверяем всегда: после правок QA-багов в quick-флоу нет
  // отдельного финального дельта-ревью, это единственный шанс.
  ;[reviewFindings, qaVerdict] = await parallel([
    () => agent(`${AUTOMATED_CONTEXT}\n\nПовторно проверь diff после исправлений (recheck — дельта от коммита "${reviewFindings.reviewedCommit || '(не указан в прошлом отчёте)'}").`,
      { label: 'code-reviewer:recheck', phase: 'Review', agentType: 'code-reviewer', effort: 'medium', schema: REVIEW_SCHEMA }),
    () => agent(`${card}\n\nПерепроверь критерии приёмки и тесты затронутой области после исправлений.`,
      { label: 'qa-engineer:recheck', phase: 'Review', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }),
  ])
}
mark('review_qa')

if (reviewFindings.hasBlockingFindings || !qaVerdict.readyForDeploy || newBugs(qaVerdict).length > 0) {
  log(budgetLow()
    ? 'Бюджет исчерпан во время ревью/QA — в develop не вливаем, нужен человек.'
    : 'Ревью и/или QA не сошлись за один круг исправлений — для быстрого флоу это сигнал, что задача сложнее, чем казалась. В develop не вливаем: посмотрите отчёты и продолжите вручную или обычным циклом на этой же ветке.')
  return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, blocked: budgetLow() ? 'budget' : (reviewFindings.hasBlockingFindings ? 'review' : 'qa') })
}

if (budgetLow()) {
  log('Бюджет заканчивается перед интеграцией — ревью и QA пройдены, но останавливаемся.')
  return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, blocked: 'budget' })
}

// 6. Синхронизация с develop. Если develop ушёл вперёд — QA перепрогоняет
// тесты затронутой области на результате мерджа; ревью мерджа — только если
// разрешались конфликты (без конфликтов чужие изменения уже прошли своё ревью
// в своих циклах, а пересечение с маленькой правкой ловит регрессия).
const syncResult = await agent(
  `Ветка: ${brief(branch, 300, 100)}\n\nQuick-цикл готов к интеграции (ревью и QA пройдены). Смёржи актуальный develop в эту cycle-ветку по своей роли devops-engineer (первая часть "Вызова 2"). Если возник конфликт в коде — передай его backend-developer/frontend-developer, не разрешай сам. Явно укажи developMerged и conflictsResolved.`,
  { label: 'devops-engineer:sync-develop', phase: 'Sync', agentType: 'devops-engineer', effort: 'low', schema: SYNC_SCHEMA }
)

let mergeChecks = null
metrics.mergeChecksSkipped = !syncResult.developMerged
if (syncResult.developMerged) {
  const [mergeRegression, mergeReview] = await parallel([
    () => agent(`Результат мерджа develop в cycle-ветку:\n${brief(syncResult.summary)}\n\n${card}\n\nПо своей роли qa-engineer перепрогони тесты по критериям карточки и регрессию затронутой области на результате мерджа.`,
      { label: 'qa-engineer:post-merge', phase: 'Sync', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }),
    ...(syncResult.conflictsResolved ? [() => agent(
      `${AUTOMATED_CONTEXT}\n\nРезультат мерджа develop в cycle-ветку:\n${brief(syncResult.summary)}\n\nПроверь по своей роли code-reviewer, режим "ревью после мерджа develop → cycle" — с особым вниманием к файлам, тронутым при разрешении конфликтов.`,
      { label: 'code-reviewer:merge-review', phase: 'Sync', agentType: 'code-reviewer', effort: 'medium', schema: REVIEW_SCHEMA })] : []),
  ])
  mergeChecks = { mergeRegression, mergeReview: mergeReview ?? null }
  if (newBugs(mergeRegression).length > 0 || (mergeReview && mergeReview.hasBlockingFindings)) {
    log('После мерджа develop → cycle есть проблемы — в develop не вливаем, нужен человек (в quick-флоу отдельного круга исправлений после мерджа нет).')
    return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, syncResult, mergeChecks, blocked: 'integrate' })
  }
}
mark('sync')

// 7. Интеграция — тот же "Вызов 2" devops-engineer, что и в обычном цикле.
const integrated = await agent(
  `Ветка: ${brief(branch, 300, 100)}\n\nQuick-цикл: ревью, QA и проверки после синхронизации с develop чистые, запись в CHANGELOG.md добавлена. По своей роли devops-engineer (вторая часть "Вызова 2"): зафиксируй незакоммиченные документы агентов отдельным коммитом "docs: ...", запушь cycle-ветку, дождись зелёного CI на этом SHA, влей её в develop строго --ff-only, запушь develop и задеплой в dev/staging. Если что-то не удалось — не обходи, верни merged=false и причину в reason.`,
  { label: 'devops-engineer:integrate', phase: 'Integrate', agentType: 'devops-engineer', effort: 'low', schema: INTEGRATE_SCHEMA }
)
mark('integrate')

if (!integrated.merged) {
  log(`Интеграция в develop НЕ выполнена: ${integrated.reason}. Нужен человек.`)
  return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, syncResult, mergeChecks, integrated, blocked: 'integrate' })
}
if (!integrated.deployed) {
  log(`Quick-цикл влит в develop (${integrated.sha}), но деплой в dev/staging не выполнен: ${integrated.reason}`)
}

return await finish({ branch, triage, implementation, reviewFindings, qaVerdict, changelog, syncResult, mergeChecks, integrated, blocked: null })
