import { describe, expect, test } from 'claude-code/testing'

import { SECTION_CHARS, TOTAL_CHARS, cleanBlock, editDiff, readExcerpt, toolDetail } from './detail'
import type { DetailSection } from './detail'
import { hhmm } from './view'
import type { ToolUseSummary } from 'claude-code'

const use = (over: Partial<ToolUseSummary>): ToolUseSummary => ({
  tool_use_id: 'u1',
  tool: 'Bash',
  input: {},
  ...over,
})

const section = (sections: DetailSection[], label: string): DetailSection | undefined =>
  sections.find((s) => s.label === label || s.label.startsWith(`${label} `))

const body = (s: DetailSection | undefined): string =>
  s === undefined ? '' : s.kind === 'code' ? s.source : s.text

describe('toolDetail Bash', () => {
  test('Command is bash code and Output holds the result with ANSI stripped', () => {
    const d = toolDetail(use({ input: { command: 'ls -la' }, text: '\x1b[31mred\x1b[0m file' }), 0)
    expect(d.tool).toBe('Bash')
    const cmd = section(d.sections, 'Command')
    expect(cmd?.kind).toBe('code')
    expect(cmd?.kind === 'code' ? cmd.language : undefined).toBe('bash')
    expect(body(cmd)).toBe('ls -la')
    const out = section(d.sections, 'Output')
    expect(out?.kind).toBe('code')
    expect(out?.kind === 'code' ? out.language : 'x').toBeUndefined()
    expect(body(out)).toBe('red file')
    expect(d.isPending).toBe(false)
  })

  test('description adds a text section', () => {
    const d = toolDetail(use({ input: { command: 'ls', description: 'List files' }, text: '' }))
    const desc = d.sections.find((s) => s.kind === 'text')
    expect(body(desc)).toBe('List files')
    expect(d.sections.map((s) => s.label)).toEqual(['Description', 'Command', 'Output'])
  })

  test('a call in flight is pending with no Output', () => {
    const d = toolDetail(use({ input: { command: 'sleep 9' } }))
    expect(d.isPending).toBe(true)
    expect(section(d.sections, 'Output')).toBeUndefined()
  })
})

describe('toolDetail Edit', () => {
  const edit = (over: Record<string, unknown> = {}) =>
    toolDetail(
      use({
        tool: 'Edit',
        input: { file_path: '/a/b.ts', old_string: 'keep\nold line\ntail', new_string: 'keep\nnew line\ntail', ...over },
        text: 'The file has been updated.',
      }),
    )

  test('Change is a diff hunk with context lines', () => {
    const d = edit()
    const ch = section(d.sections, 'Change')
    expect(ch?.label).toBe('Change (line numbers relative to the edit)')
    expect(ch?.kind === 'code' ? ch.diff : undefined).toBe(true)
    const src = body(ch)
    expect(src.startsWith('@@ -1,')).toBe(true)
    expect(src).toContain('-old line')
    expect(src).toContain('+new line')
    expect(src).toContain('\n keep')
    expect(src).toContain('\n tail')
    expect(body(section(d.sections, 'File'))).toBe('/a/b.ts')
    expect(body(section(d.sections, 'Result'))).toBe('The file has been updated.')
  })

  test('replace_all shows in File', () => {
    expect(body(section(edit({ replace_all: true }).sections, 'File'))).toBe('/a/b.ts (all occurrences)')
  })

  test('MultiEdit gives one hunk per edit', () => {
    const d = toolDetail(
      use({
        tool: 'MultiEdit',
        input: {
          file_path: '/x.ts',
          edits: [
            { old_string: 'a', new_string: 'b' },
            { old_string: 'c', new_string: 'd' },
          ],
        },
        text: 'ok',
      }),
    )
    const src = body(section(d.sections, 'Change'))
    expect(src.match(/@@ -1,/g)?.length).toBe(2)
    expect(src).toContain('-a\n+b')
    expect(src).toContain('-c\n+d')
  })

  test('a diff over SECTION_CHARS falls back to Old and New code', () => {
    const big = 'x'.repeat(SECTION_CHARS)
    const d = toolDetail(use({ tool: 'Edit', input: { file_path: '/f.ts', old_string: big, new_string: `${big}y` }, text: 'ok' }))
    expect(d.sections.some((s) => s.kind === 'code' && s.diff === true)).toBe(false)
    const old = section(d.sections, 'Old')
    const neu = section(d.sections, 'New')
    expect(old?.kind).toBe('code')
    expect(neu?.kind).toBe('code')
    expect(old?.kind === 'code' ? old.path : undefined).toBe('/f.ts')
  })
})

describe('editDiff', () => {
  test('shared leading and trailing lines are context; header counts match the body', () => {
    const diff = editDiff('a\nb\nc\nd', 'a\nB\nC2\nC3\nd')
    const [header, ...lines] = diff.split('\n')
    expect(header).toBe('@@ -1,4 +1,5 @@')
    expect(lines).toEqual([' a', '-b', '-c', '+B', '+C2', '+C3', ' d'])
    const oldCount = lines.filter((l) => l[0] === ' ' || l[0] === '-').length
    const newCount = lines.filter((l) => l[0] === ' ' || l[0] === '+').length
    expect(header).toBe(`@@ -1,${oldCount} +1,${newCount} @@`)
  })

  test('prefix and suffix never overlap', () => {
    expect(editDiff('a\na', 'a\na\na')).toBe('@@ -1,2 +1,3 @@\n a\n a\n+a')
  })
})

describe('Read', () => {
  test('readExcerpt strips arrow gutters', () => {
    expect(readExcerpt('    12→a\n    13→b')).toEqual({ source: 'a\nb', startLine: 12 })
  })

  test('readExcerpt strips tab gutters', () => {
    expect(readExcerpt('    12\ta\n    13\tb')).toEqual({ source: 'a\nb', startLine: 12 })
  })

  test('readExcerpt leaves text without gutters alone', () => {
    expect(readExcerpt('File does not exist.')).toEqual({ source: 'File does not exist.' })
  })

  test('toolDetail gives File with the range and an Excerpt with path and startLine', () => {
    const d = toolDetail(use({ tool: 'Read', input: { file_path: '/r.ts', offset: 12, limit: 2 }, text: '    12→a\n    13→b' }))
    expect(body(section(d.sections, 'File'))).toBe('/r.ts lines 12–13')
    const ex = section(d.sections, 'Excerpt')
    expect(ex?.kind).toBe('code')
    if (ex?.kind !== 'code') return
    expect(ex.path).toBe('/r.ts')
    expect(ex.startLine).toBe(12)
    expect(ex.source).toBe('a\nb')
  })
})

describe('Grep and Glob', () => {
  test('Grep Pattern holds the pattern and path; Results is plain code', () => {
    const d = toolDetail(use({ tool: 'Grep', input: { pattern: 'foo.*bar', path: 'src', glob: '*.ts', output_mode: 'content' }, text: 'src/a.ts:1:foo bar' }))
    const p = section(d.sections, 'Pattern')
    expect(p?.kind).toBe('text')
    expect(body(p)).toContain('foo.*bar')
    expect(body(p)).toContain('src')
    expect(body(p)).toContain('*.ts')
    const r = section(d.sections, 'Results')
    expect(r?.kind).toBe('code')
    expect(r?.kind === 'code' ? r.language : 'x').toBeUndefined()
    expect(body(r)).toBe('src/a.ts:1:foo bar')
  })

  test('Glob reads its fields defensively', () => {
    const d = toolDetail(use({ tool: 'Glob', input: { pattern: '**/*.md', path: 42 }, text: 'a.md' }))
    expect(body(section(d.sections, 'Pattern'))).toContain('**/*.md')
    expect(body(section(d.sections, 'Pattern'))).not.toContain('42')
    expect(body(section(d.sections, 'Results'))).toBe('a.md')
  })
})

describe('Write and Agent', () => {
  test('Write gives Content code with path and startLine 1', () => {
    const d = toolDetail(use({ tool: 'Write', input: { file_path: '/w.ts', content: 'hello' }, text: 'ok' }))
    expect(body(section(d.sections, 'File'))).toBe('/w.ts')
    const c = section(d.sections, 'Content')
    expect(c?.kind).toBe('code')
    if (c?.kind !== 'code') return
    expect(c.path).toBe('/w.ts')
    expect(c.startLine).toBe(1)
    expect(c.source).toBe('hello')
  })

  test('Agent gives Task text, Prompt markdown and Result markdown', () => {
    const d = toolDetail(use({ tool: 'Agent', input: { description: 'do it', subagent_type: 'Explore', prompt: '# Go' }, text: '**done**' }))
    expect(body(section(d.sections, 'Task'))).toContain('do it')
    expect(body(section(d.sections, 'Task'))).toContain('Explore')
    expect(section(d.sections, 'Prompt')?.kind).toBe('markdown')
    expect(body(section(d.sections, 'Prompt'))).toBe('# Go')
    expect(section(d.sections, 'Result')?.kind).toBe('markdown')
    expect(body(section(d.sections, 'Result'))).toBe('**done**')
  })
})

describe('other tools, errors and time', () => {
  test('an unknown tool gives pretty JSON Input and a Result', () => {
    const input = { a: 1, b: ['x'] }
    const d = toolDetail(use({ tool: 'mcp__s__t', input, text: 'r' }))
    const i = section(d.sections, 'Input')
    expect(i?.kind === 'code' ? i.language : undefined).toBe('json')
    expect(body(i)).toBe(JSON.stringify(input, null, 2))
    expect(section(d.sections, 'Result')?.kind).toBe('code')
    expect(body(section(d.sections, 'Result'))).toBe('r')
  })

  test('an error result sets isError', () => {
    expect(toolDetail(use({ input: { command: 'x' }, text: 'boom', isError: true })).isError).toBe(true)
    expect(toolDetail(use({ input: { command: 'x' }, text: 'fine' })).isError).toBe(false)
  })

  test('time is hhmm(t), or --:-- without t', () => {
    const t = Date.UTC(2026, 9, 11, 9, 7)
    expect(toolDetail(use({ input: { command: 'x' } }), t).time).toBe(hhmm(t))
    expect(toolDetail(use({ input: { command: 'x' } })).time).toBe('--:--')
  })
})

describe('caps and cleaning', () => {
  test('cleanBlock keeps only newline and tab among control characters', () => {
    expect(cleanBlock('a\x1b[1;32mb\x1b[0m\tc\r\nd\x07e\x00f\x9b')).toBe('ab\tc\ndef')
  })

  test('a 50,000-character output is capped to SECTION_CHARS plus a note', () => {
    const d = toolDetail(use({ input: { command: 'yes' }, text: 'y'.repeat(50_000) }))
    const out = body(section(d.sections, 'Output'))
    expect(out.length).toBeLessThanOrEqual(SECTION_CHARS + 40)
    expect(out.endsWith('more characters)')).toBe(true)
    expect(out).toContain(`(${50_000 - SECTION_CHARS} more characters)`)
  })

  test('the sum of all sources stays within TOTAL_CHARS and no other control character survives', () => {
    const huge = `\x1b[31m${'z\x01'.repeat(40_000)}`
    const edits = Array.from({ length: 6 }, () => ({ old_string: huge, new_string: `${huge}q` }))
    const all = [
      toolDetail(use({ tool: 'MultiEdit', input: { file_path: '/m', edits }, text: huge })),
      toolDetail(use({ tool: 'Agent', input: { description: huge, prompt: huge }, text: huge })),
      toolDetail(use({ tool: 'Grep', input: { pattern: huge, path: huge }, text: huge })),
      toolDetail(use({ input: { command: huge, description: huge }, text: huge })),
      toolDetail(use({ tool: 'Zed', input: { a: huge, b: huge, c: huge }, text: huge })),
    ]
    for (const d of all) {
      const total = d.sections.reduce((n, s) => n + body(s).length, 0)
      expect(total).toBeLessThanOrEqual(TOTAL_CHARS)
      for (const s of d.sections) {
        expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body(s))).toBe(false)
        expect(body(s).length).toBeLessThanOrEqual(SECTION_CHARS + 40)
      }
    }
  })
})

describe('review fixes', () => {
  test('readExcerpt strips gutters from CRLF output and keeps startLine', () => {
    expect(readExcerpt('    12→a\r\n    13→b\r\n')).toEqual({ source: 'a\nb', startLine: 12 })
  })

  test('a null text and an undefined input do not throw and read as pending', () => {
    const odd = { tool_use_id: 'u', tool: 'Bash', input: undefined, text: null } as unknown as ToolUseSummary
    const d = toolDetail(odd)
    expect(d.isPending).toBe(true)
    expect(section(d.sections, 'Output')).toBeUndefined()
    expect(toolDetail({ ...odd, tool: 'Zed' }).sections.length).toBeGreaterThan(0)
  })

  test('editDiff counts an empty side as zero lines', () => {
    expect(editDiff('', 'a')).toBe('@@ -1,0 +1,1 @@\n+a')
    expect(editDiff('a', '')).toBe('@@ -1,1 +1,0 @@\n-a')
    expect(editDiff('', '')).toBe('@@ -1,0 +1,0 @@')
  })

  test('editDiff of identical text is all context', () => {
    expect(editDiff('a\nb', 'a\nb')).toBe('@@ -1,2 +1,2 @@\n a\n b')
  })

  test('editDiff splits CRLF lines without a stray carriage return', () => {
    expect(editDiff('a\r\nb', 'a\r\nc')).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c')
  })

  test('cleanBlock strips the one-byte CSI form', () => {
    expect(cleanBlock('\x9b31mred\x9b0m')).toBe('red')
  })

  test('sections dropped past TOTAL_CHARS are counted in a closing note', () => {
    const huge = 'h'.repeat(30_000)
    const d = toolDetail(use({ tool: 'Edit', input: { file_path: huge, old_string: huge, new_string: `${huge}q` }, text: huge }))
    const last = d.sections[d.sections.length - 1]
    expect(last?.kind).toBe('text')
    expect(body(last)).toBe('… (1 more section)')
    const total = d.sections.reduce((n, s) => n + body(s).length, 0)
    expect(total).toBeLessThanOrEqual(TOTAL_CHARS)
  })
})
