import { Marked, type Tokens } from 'marked'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import yaml from 'highlight.js/lib/languages/yaml'
import json from 'highlight.js/lib/languages/json'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import python from 'highlight.js/lib/languages/python'
import ini from 'highlight.js/lib/languages/ini'
import c from 'highlight.js/lib/languages/c'
import plaintext from 'highlight.js/lib/languages/plaintext'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('json', json)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('go', go)
hljs.registerLanguage('python', python)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('c', c)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerAliases(['sh', 'shell', 'console', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['toml', 'fio', 'conf'], { languageName: 'ini' })
hljs.registerAliases(['bpftrace', 'bt'], { languageName: 'c' })
hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' })

export type TocItem = { id: string; text: string; depth: number }

const CALLOUTS: Record<string, string> = {
  NOTE: '说明',
  TIP: '提示',
  WARNING: '注意',
  DANGER: '危险',
  LAB: '动手实验',
  PROD: '生产实践',
  QUEST: '闯关挑战',
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 目录文本由 React 以纯文本渲染，需要把 marked 转义过的实体还原
function decodeEntities(s: string) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function slugify(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

// 代码块 info string 形如：yaml title="pod.yaml"
function parseInfo(info = '') {
  const [lang = '', ...rest] = info.trim().split(/\s+/)
  const title = rest.join(' ').match(/title="([^"]+)"/)?.[1]
  return { lang: lang.toLowerCase(), title }
}

export function renderMarkdown(source: string) {
  const toc: TocItem[] = []
  const seen = new Map<string, number>()
  const md = new Marked({ gfm: true })

  md.use({
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        const html = this.parser.parseInline(tokens)
        let id = slugify(text)
        const n = seen.get(id) ?? 0
        seen.set(id, n + 1)
        if (n > 0) id = `${id}-${n}`
        if (depth === 2 || depth === 3) toc.push({ id, text: decodeEntities(html.replace(/<[^>]+>/g, '')), depth })
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`
      },
      code({ text, lang }: Tokens.Code) {
        const info = parseInfo(lang)
        const language = hljs.getLanguage(info.lang) ? info.lang : 'plaintext'
        const highlighted = hljs.highlight(text, { language }).value
        const label = info.title ?? (info.lang || 'text')
        return (
          `<div class="code-block"><div class="code-head"><span>${escapeHtml(label)}</span>` +
          `<button type="button" class="copy-btn" data-copy>复制</button></div>` +
          `<pre><code class="hljs language-${language}">${highlighted}</code></pre></div>\n`
        )
      },
      blockquote({ text, tokens }: Tokens.Blockquote) {
        const m = text.match(/^\[!(\w+)\][ \t]*([^\n]*)\n?/)
        if (m && CALLOUTS[m[1].toUpperCase()]) {
          const kind = m[1].toUpperCase()
          const title = m[2]?.trim() || CALLOUTS[kind]
          const body = md.parse(text.slice(m[0].length)) as string
          return `<aside class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${escapeHtml(title)}</p>${body}</aside>\n`
        }
        return `<blockquote>${this.parser.parse(tokens)}</blockquote>\n`
      },
      table(token: Tokens.Table) {
        const head = token.header.map((c) => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('')
        const rows = token.rows
          .map((r) => `<tr>${r.map((c) => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`)
          .join('')
        return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const external = /^https?:\/\//.test(href)
        const t = title ? ` title="${escapeHtml(title)}"` : ''
        return external
          ? `<a href="${href}"${t} target="_blank" rel="noreferrer">${inner}</a>`
          : `<a href="${href}"${t}>${inner}</a>`
      },
    },
  })

  // <summary> 属于 HTML 块，marked 不会解析其中的行内 Markdown（如 `code`），这里预先渲染
  const prepared = source.replace(
    /<summary>(.*?)<\/summary>/g,
    (_, inner: string) => `<summary>${md.parseInline(inner) as string}</summary>`,
  )
  const html = md.parse(prepared) as string
  return { html, toc }
}
