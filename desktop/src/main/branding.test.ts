import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.join(__dirname, '..', '..')
const resources = path.join(root, 'resources')

describe('Quorate branding (packaging + assets)', () => {
  it('electron-builder ships as Quorate; internal orcha identifiers unchanged', () => {
    const builder = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/^productName: Quorate$/m)
    expect(builder).toMatch(/^appId: io\.openorcha\.desktop$/m)
    expect(builder).toMatch(/schemes:\n\s+- orcha/)
    expect(builder).toMatch(/icon: resources\/icon\.icns/)
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string }
    expect(pkg.name).toBe('orcha-desktop')
  })

  it('ships the orca icon, marks and tray template images', () => {
    for (const f of ['icon.icns', 'icon.png', 'icon.svg', 'logo-mark.svg', 'logo-mark-mono.svg', 'trayTemplate.png', 'trayTemplate@2x.png']) {
      expect(readFileSync(path.join(resources, f)).length).toBeGreaterThan(100)
    }
    expect(readFileSync(path.join(resources, 'logo-mark-mono.svg'), 'utf8')).toContain('fill="currentColor"')
    // Old three-segment ring (lavender #9695F2) is gone from the masters.
    expect(readFileSync(path.join(resources, 'icon.svg'), 'utf8')).not.toContain('#9695F2')
  })

  it('dev bundle patch script names the app Quorate', () => {
    const sh = readFileSync(path.join(root, 'scripts', 'sign-dev-electron.sh'), 'utf8')
    expect(sh).toContain('Set :CFBundleName Quorate')
    expect(sh).toContain('CFBundleDisplayName Quorate')
  })
})
