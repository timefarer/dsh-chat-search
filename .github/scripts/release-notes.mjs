import fs from 'node:fs'
import path from 'node:path'

/**
 * Turn the pushed tag into release notes.
 *
 * The CHANGELOG is the single source of truth: the section whose heading equals the version
 * becomes the release body. A tag that does not match `package.json` fails the run, because
 * that is exactly the mistake that ships a release for a version nobody can install.
 */
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? ''
if (tag === '') {
  console.error('no tag: set GITHUB_REF_NAME or pass it as the first argument')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (pkg.version !== version) {
  console.error(`tag ${tag} does not match package.json version ${pkg.version}`)
  process.exit(1)
}

const changelogPath = path.join(process.cwd(), 'CHANGELOG.md')
const changelog = fs.readFileSync(changelogPath, 'utf8')
const sections = changelog.split(/^## /m).slice(1)
const match = sections.find((section) => section.split('\n', 1)[0].trim() === version)
const notes = match === undefined ? '' : match.split('\n').slice(1).join('\n').trim()

const body = [
  notes === '' ? `Version ${version}.` : notes,
  '',
  '---',
  '',
  `Install: \`dsh plugin add dsh-chat-search\``,
  '',
  `npm: https://www.npmjs.com/package/dsh-chat-search/v/${version}`,
  '',
].join('\n')

fs.writeFileSync('.release-notes.md', body)
console.log(`wrote .release-notes.md for ${tag}`)
console.log(body)
