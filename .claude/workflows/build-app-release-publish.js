// Событие релиза, часть 2 из 2: закрытие CHANGELOG, пользовательские гайды,
// продвижение develop → release-candidate → master, тег версии, прод-деплой
// (с реальными секретами). Намеренно отдельный скрипт от
// build-app-release-validate.js: прод-деплой остаётся за отдельным, осознанным
// решением человека запустить именно ЭТОТ скрипт, а не автоматическим
// продолжением после зелёной регрессии (история решения — docs/HISTORY.md).
//
// Порядок запуска релиза: build-app-release-validate.js → (человек читает
// releaseRegression и решает публиковать) → build-app-release-publish.js.
//
// Предусловие: develop == release-candidate, то есть с момента validate в
// develop не влили новых циклов. Иначе скрипт останавливается — перезапустите
// validate, а не полагайтесь на старый результат.
//
// Порядок шагов: проверка предусловия → devops создаёт релизный цикл
// cycle/<NNN>-release-<ver> от develop → product-analyst ("Вызов 3")
// закрывает Unreleased в CHANGELOG.md → ПОСЛЕ этого technical-writer
// пишет/обновляет гайды по свежезакрытой записи → devops: фиксация документов,
// CI, --ff-only develop ← cycle, --ff-only release-candidate ← develop,
// --ff-only master ← release-candidate, тег v<ver>, прод-деплой.
//
// args: { version?: string, stage?, releaseRegression? } — результат
// build-app-release-validate.js (stage передаётся devops-engineer на шаге
// предусловия, чтобы сверить, что release-candidate — тот самый
// провалидированный коммит; регрессию заново не повторяет) плюс, по желанию,
// версия; без version её определяет devops-engineer.
// Результат: { precondition, releaseBranch, changelog, userDocs, published, blocked }

export const meta = {
  name: 'build-app-release-publish',
  description: 'Релиз, часть 2/2: закрытие CHANGELOG, публикация гайдов, мердж release-candidate в master, тег версии, прод-деплой. Запускать отдельно, осознанно, после build-app-release-validate.js.',
  phases: [
    { title: 'Publish' },
  ],
}

// Общий бюджет на весь путь — см. подробный комментарий в
// build-app-implement.js.
const BUDGET_MARGIN = 50_000
function budgetLow() { return budget.total != null && budget.remaining() < BUDGET_MARGIN }

function brief(text, head = 400, tail = 200) {
  const s = String(text ?? '')
  return s.length <= head + tail + 100 ? s : `${s.slice(0, head)}\n[…сокращено…]\n${s.slice(-tail)}`
}

const PRECONDITION_SCHEMA = {
  type: 'object',
  properties: {
    sameCommit: { type: 'boolean', description: 'true — develop и release-candidate (на origin) указывают на один и тот же коммит' },
    developSha: { type: ['string', 'null'] },
    releaseCandidateSha: { type: ['string', 'null'] },
    version: { type: 'string', description: 'Версия релиза (из args или определённая по CHANGELOG.md/тегам)' },
  },
  required: ['sameCommit', 'version'],
}

const PUBLISH_SCHEMA = {
  type: 'object',
  properties: {
    published: { type: 'boolean', description: 'true — master продвинут, тег поставлен и запушен' },
    tag: { type: ['string', 'null'] },
    sha: { type: ['string', 'null'], description: 'SHA master после продвижения' },
    deployed: { type: 'boolean', description: 'true — прод-деплой выполнен' },
    reason: { type: 'string', description: 'Что сделано; если published=false или deployed=false — почему' },
  },
  required: ['published', 'tag', 'sha', 'deployed', 'reason'],
}

const { stage } = args || {}
const versionArg = args && args.version ? String(args.version) : null

if (budgetLow()) {
  log('Бюджет исчерпан ещё до старта публикации — ничего не делаем, нужен человек.')
  return { precondition: null, releaseBranch: null, changelog: null, userDocs: null, published: null, blocked: 'budget' }
}

log('Публикация релиза начата явным вызовом этого скрипта — предполагается, что releaseRegression из build-app-release-validate.js уже прочитан и подтверждён человеком.')

// 1. Предусловие: валидировано ровно то, что сейчас в develop.
const precondition = await agent(
  `По своей роли devops-engineer (только чтение, ничего не меняй): сделай git fetch и сравни коммиты origin/develop и origin/release-candidate.${stage ? ` Итог валидации (build-app-release-validate.js):\n${brief(stage, 400, 150)}\nЕсли release-candidate с тех пор сдвинулся — это тоже sameCommit=false.` : ''} ${versionArg ? `Версия релиза: ${versionArg}.` : 'Определи версию релиза по CHANGELOG.md/тегам.'}`,
  { label: 'devops-engineer:precondition', phase: 'Publish', agentType: 'devops-engineer', effort: 'low', schema: PRECONDITION_SCHEMA }
)
if (!precondition.sameCommit) {
  log(`develop (${precondition.developSha}) не совпадает с release-candidate (${precondition.releaseCandidateSha}) — после валидации в develop влили новые изменения. Перезапустите validate.`)
  return { precondition, releaseBranch: null, changelog: null, userDocs: null, published: null, blocked: 'precondition' }
}
const version = precondition.version

// 2. Релизный цикл: документы релиза коммитятся на cycle-ветке, как и всё
// остальное, а не прямо в защищённые ветки.
const releaseBranch = await agent(
  `Версия релиза: ${version}. По своей роли devops-engineer создай релизный цикл cycle/<NNN>-release-${version} от актуального develop и запушь его. В ответе укажи имя ветки.`,
  { label: 'devops-engineer:release-branch', phase: 'Publish', agentType: 'devops-engineer', effort: 'low' }
)

// 3. Только теперь, когда релиз фактически подтверждён — закрываем Unreleased
// в CHANGELOG. Раньше это делать нельзя: то, что накопилось в develop, до
// этого момента ещё не было доступно реальным пользователям.
const changelog = await agent(
  `Релиз ${version} подтверждён, ветка: ${brief(releaseBranch, 200, 100)}. Перенеси накопившиеся записи из раздела "Unreleased" CHANGELOG.md под новую датированную версию по своей роли product-analyst ("Вызов 3"). Правь точечно (Edit). Коммитить не нужно — документы зафиксирует devops-engineer.`,
  { label: 'product-analyst:release', phase: 'Publish', agentType: 'product-analyst', model: 'sonnet', effort: 'medium' }
)

if (budgetLow()) {
  log('Бюджет заканчивается после закрытия CHANGELOG — гайды и публикацию не запускаем, нужен человек.')
  return { precondition, releaseBranch, changelog, userDocs: null, published: null, blocked: 'budget' }
}

// 4. Гайды — строго ПОСЛЕ закрытия CHANGELOG: technical-writer опирается на
// уже закрытую запись версии, а не на раздел, который в этот момент правят.
const userDocs = await agent(
  `Релиз ${version} подтверждён, запись версии в CHANGELOG.md уже закрыта (${brief(changelog)}). Обнови/опубликуй пользовательские гайды по своей роли technical-writer, ориентируясь на эту запись. Коммитить не нужно — документы зафиксирует devops-engineer.`,
  { label: 'technical-writer:release', phase: 'Publish', agentType: 'technical-writer', effort: 'high' }
)

if (budgetLow()) {
  log('Бюджет заканчивается перед фактическим прод-деплоем (самый чувствительный шаг из всех) — останавливаемся, нужен человек.')
  return { precondition, releaseBranch, changelog, userDocs, published: null, blocked: 'budget' }
}

// 5. Продвижение до master и тег версии — единственный шаг во всей команде,
// который трогает реальные прод-секреты и реальных пользователей.
const published = await agent(
  `Версия релиза: ${version}. Документация релиза обновлена на ветке ${brief(releaseBranch, 200, 100)}. По своей роли devops-engineer ("Вызов 3"): зафиксируй документы отдельным коммитом "docs: ...", запушь ветку, дождись зелёного CI; затем строго --ff-only: develop ← релизная cycle-ветка, release-candidate ← develop, master ← release-candidate; поставь и запушь тег v${version}; задеплой в прод. Если какой-то шаг не удался — не обходи, остановись и верни published/deployed=false с причиной.`,
  { label: 'devops-engineer:publish', phase: 'Publish', agentType: 'devops-engineer', effort: 'low', schema: PUBLISH_SCHEMA }
)

if (!published.published) {
  log(`Релиз ${version} НЕ опубликован: ${published.reason}. Нужен человек.`)
  return { precondition, releaseBranch, changelog, userDocs, published, blocked: 'publish' }
}
if (!published.deployed) {
  log(`Тег ${published.tag} поставлен, но прод-деплой не выполнен: ${published.reason}. Нужен человек.`)
  return { precondition, releaseBranch, changelog, userDocs, published, blocked: 'deploy' }
}

log(`Релиз ${version} опубликован: ${published.tag} (${published.sha}).`)

return { precondition, releaseBranch, changelog, userDocs, published, blocked: null }
