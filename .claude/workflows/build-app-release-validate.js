// Событие релиза, часть 1 из 2: stage (develop → release-candidate, --ff-only)
// + релизная регрессия. Мердж в master и прод-деплой сюда НЕ входят — это
// отдельный скрипт build-app-release-publish.js, который запускается вторым,
// отдельным осознанным действием человека, после того как он посмотрел на
// releaseRegression из этого скрипта: прод-деплой с секретами остаётся за
// более долгим ручным подтверждением, чем остальной цикл (история решения —
// docs/HISTORY.md).
//
// Порядок запуска релиза: build-app-release-validate.js → (человек читает
// releaseRegression) → build-app-release-publish.js.
//
// Не привязан к одному циклу build-app-implement.js — может запускаться
// после того, как в develop влит один цикл, или после того, как их
// накопилось несколько (релизы пачками — механика та же).
//
// Исправления по найденным регрессией багам НЕ коммитятся в
// release-candidate: devops-engineer заводит fix-цикл
// cycle/<NNN>-rc-fix-<ver> от develop, разработчики чинят там, ревью и QA
// проверяют исправления, devops интегрирует fix-цикл в develop (--ff-only,
// CI) и снова продвигает develop → release-candidate (--ff-only), после чего
// регрессия повторяется. Всё течёт линейно cycle → develop →
// release-candidate → master, поэтому back-merge не нужен.
//
// args (необязателен): { version?: string } — версия релиза для имени
// fix-цикла; если не задана, devops-engineer определяет её сам.
// Результат: { stage, releaseRegression, fixCycles, blocked }

export const meta = {
  name: 'build-app-release-validate',
  description: 'Релиз, часть 1/2: develop → release-candidate + релизная регрессия. Останавливается здесь для решения человека — прод-деплой в build-app-release-publish.js.',
  phases: [
    { title: 'Stage' },
    { title: 'Validate' },
  ],
}

// Та же схема QA-вердикта, что в build-app-implement.js.
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
          preexisting: { type: 'boolean', description: 'true — известный техдолг, не связан с релизом, не блокер' },
        },
        required: ['description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом, как раньше' },
  },
  required: ['readyForDeploy', 'openBugs', 'summary'],
}

// Та же схема ревью, что в build-app-implement.js (сокращённо).
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    hasBlockingFindings: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
          area: { type: 'string', enum: ['backend', 'frontend', 'shared'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
    summary: { type: 'string', description: 'Полный отчёт человекочитаемым текстом' },
  },
  required: ['hasBlockingFindings', 'findings', 'summary'],
}

// Результат интеграции fix-цикла в develop и продвижения develop →
// release-candidate — та же манера, что INTEGRATE_SCHEMA в build-app-implement.js.
const PROMOTE_SCHEMA = {
  type: 'object',
  properties: {
    merged: { type: 'boolean', description: 'true — fix-цикл влит в develop (--ff-only, CI зелёный) и develop продвинут в release-candidate (--ff-only)' },
    sha: { type: ['string', 'null'], description: 'SHA release-candidate после продвижения (null, если не продвинут)' },
    reason: { type: 'string', description: 'Что сделано; если merged=false — почему' },
  },
  required: ['merged', 'sha', 'reason'],
}

// Общий бюджет на весь путь — см. подробный комментарий в
// build-app-implement.js. Здесь событие релиза редкое (пачками), поэтому
// проверка добавлена скорее для полноты, чем по реальной необходимости.
const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

function formatQA(qa) {
  const list = qa.openBugs.map(b =>
    `- [${b.preexisting ? 'known/preexisting' : 'new'}${b.area ? ', ' + b.area : ''}] ${b.description}`
  ).join('\n')
  return `${brief(qa.summary, 1200, 600)}\n\nОткрытые баги:\n${list || '(нет)'}`
}

function newBugs(qa) { return qa.openBugs.filter(b => !b.preexisting) }

// Экономия токенов: большие отчёты агентов не пересказываем друг другу целиком —
// код и документы лежат в репозитории, агент читает их сам.
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

const version = args && args.version ? String(args.version) : null
const VERSION_NOTE = version ? `Версия релиза: ${version}.` : 'Версию релиза определи сам (по CHANGELOG.md/тегам).'

if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта — ничего не делаем, нужен человек.')
  return { stage: null, releaseRegression: null, fixCycles: [], blocked: 'budget' }
}

// 1. devops-engineer продвигает develop в release-candidate строго --ff-only
// (создаёт ветку, если её ещё не было) — "Вызов 3" в его роли.
const stage = await agent(
  'Продвинь develop в release-candidate (--ff-only; создай release-candidate от develop, если её ещё нет) по своей роли devops-engineer ("Вызов 3 — событие релиза", шаг 1). В release-candidate ничего не коммить.',
  { label: 'devops-engineer:stage', phase: 'Stage', agentType: 'devops-engineer', effort: 'low' }
)

// 2. Полная регрессия именно на release-candidate — это не повтор регрессий
// по каждому циклу отдельно, а проверка того, что несколько независимо
// влитых циклов работают вместе.
let releaseRegression = await agent(
  `Ветка release-candidate обновлена:\n${brief(stage)}\n\nПерепрогони полную регрессию по своей роли qa-engineer ("Вызов 4 — релизная регрессия"). Баги, не связанные с этим релизом и уже известные ранее, отметь как preexisting=true.`,
  { label: 'qa-engineer:release', phase: 'Validate', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }
)

// 3. Fix-циклы: исправления идут через обычный путь cycle → develop →
// release-candidate, а не коммитами прямо в release-candidate.
const MAX_RELEASE_FIX_ATTEMPTS = 2
let attempts = 0
const fixCycles = []
// Ветка fix-цикла живёт до успешной интеграции: если попытка не прошла
// ревью/QA, следующая продолжает на той же ветке, а не начинает с нуля.
let fixBranch = null
while (newBugs(releaseRegression).length > 0 && attempts < MAX_RELEASE_FIX_ATTEMPTS && !budgetLow()) {
  attempts++
  const bugs = newBugs(releaseRegression)
  const bugsText = `Баги релизной регрессии:\n${formatQA(releaseRegression)}`

  const continuing = fixBranch != null
  if (!continuing) fixBranch = await agent(
    `${VERSION_NOTE}\n\nРелизная регрессия на release-candidate нашла баги (попытка исправления ${attempts} из ${MAX_RELEASE_FIX_ATTEMPTS}). По своей роли devops-engineer ("Вызов 1 — начало цикла") создай fix-цикл cycle/<NNN>-rc-fix-<версия> от актуального develop и запушь его. В release-candidate ничего не коммить. В ответе укажи имя ветки.`,
    { label: 'devops-engineer:rc-fix-branch', phase: 'Validate', agentType: 'devops-engineer', effort: 'low' }
  )

  await parallel(fixCalls(bugs, `Ветка fix-цикла: ${brief(fixBranch, 300, 100)}${continuing ? ' (продолжение: предыдущие исправления уже на этой ветке, не начинай с нуля)' : ''}\n\n${bugsText}\n\nЧини и коммить на текущей fix-ветке (не на release-candidate).`, 'fix-release', 'Validate'))

  if (budgetLow()) break
  const [fixReview, fixQA] = await parallel([
    () => agent(`Это автоматический вызов из workflow-скрипта, без человека на связи.\n\nПроверь по своей роли code-reviewer diff fix-цикла (вся fix-ветка относительно точки ответвления от develop) — исправления багов релизной регрессии:\n${bugsText}`,
      { label: 'code-reviewer:rc-fix', phase: 'Validate', agentType: 'code-reviewer', effort: 'medium', schema: REVIEW_SCHEMA }),
    () => agent(`На fix-ветке исправлены баги релизной регрессии:\n${bugsText}\n\nПо своей роли qa-engineer проверь именно эти баги и прогони регрессию на fix-ветке. Ранее известные баги отметь preexisting=true.`,
      { label: 'qa-engineer:rc-fix', phase: 'Validate', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA }),
  ])
  if (fixReview.hasBlockingFindings || newBugs(fixQA).length > 0) {
    log(`Fix-цикл (попытка ${attempts}) не прошёл ревью/QA — в develop не интегрируем.`)
    fixCycles.push({ branch: fixBranch, review: fixReview, qa: fixQA, promoted: null })
    // Следующая попытка (если есть) получит актуальный список проблем.
    releaseRegression = { ...fixQA, openBugs: [...fixQA.openBugs, ...fixReview.findings.filter(f => f.severity === 'blocking').map(f => ({ area: f.area, description: `[ревью] ${f.file ? f.file + ' — ' : ''}${f.description}` }))], readyForDeploy: false }
    continue
  }

  if (budgetLow()) break
  const promoted = await agent(
    `Fix-цикл прошёл ревью и QA. По своей роли devops-engineer: зафиксируй незакоммиченные документы, запушь fix-ветку, дождись зелёного CI, влей её в develop строго --ff-only ("Вызов 2", интеграция), запушь develop; затем продвинь develop в release-candidate строго --ff-only. В release-candidate напрямую ничего не коммить. Если что-то не удалось — не обходи, верни merged=false и причину.`,
    { label: 'devops-engineer:rc-fix-integrate', phase: 'Stage', agentType: 'devops-engineer', effort: 'low', schema: PROMOTE_SCHEMA }
  )
  fixCycles.push({ branch: fixBranch, review: fixReview, qa: fixQA, promoted })
  fixBranch = null
  if (!promoted.merged) {
    log(`Fix-цикл не удалось интегрировать в develop/release-candidate: ${promoted.reason}. Нужен человек.`)
    return { stage, releaseRegression, fixCycles, blocked: 'integrate' }
  }

  if (budgetLow()) break
  releaseRegression = await agent(`release-candidate продвинут до ${promoted.sha} после fix-цикла. Перепрогони полную релизную регрессию по своей роли qa-engineer ("Вызов 4").`,
    { label: 'qa-engineer:release-recheck', phase: 'Validate', agentType: 'qa-engineer', effort: 'medium', schema: QA_SCHEMA })
}
if (newBugs(releaseRegression).length > 0 || !releaseRegression.readyForDeploy) {
  log(budgetLow()
    ? 'Бюджет исчерпан во время исправлений релизной регрессии — публиковать нечего, нужен человек.'
    : `Релизная регрессия не сошлась за ${MAX_RELEASE_FIX_ATTEMPTS} попыток — релиз не публикуем без решения человека.`)
  return { stage, releaseRegression, fixCycles, blocked: budgetLow() ? 'budget' : 'release-regression' }
}

log('Релизная регрессия чистая. Прочитайте releaseRegression и, если согласны публиковать, запустите build-app-release-publish.js отдельным вызовом Workflow — этот скрипт дальше сам не идёт. Если до publish в develop будет влит новый цикл — validate нужно перезапустить.')

return { stage, releaseRegression, fixCycles, blocked: null }
