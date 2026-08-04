/**
 * Generate the "Memo to idj" Apple Shortcut as an unsigned .shortcut plist.
 *
 *   bun run scripts/gen-shortcut.ts            -> public/idj-memo.unsigned.shortcut
 *
 * The capture token is NOT baked in. Action 0 is a Text action holding a
 * placeholder, and WFWorkflowImportQuestions makes iOS prompt for it at import
 * time ("Paste your idj capture token"). The URL action references that text as
 * a magic variable, so the distributed file carries no secret and the token can
 * be rotated by re-importing rather than editing the shortcut.
 *
 * Sign before distributing (macOS only):
 *   shortcuts sign --mode anyone -i idj-memo.unsigned.shortcut -o idj-memo.shortcut
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE_URL = process.env.IDJ_BASE_URL ?? 'https://idj.isozilla.com'
const OUT = process.env.OUT ?? 'public/idj-memo.unsigned.shortcut'

// Stable UUIDs so the magic-variable references resolve.
const TOKEN_UUID = 'A1B2C3D4-0000-4000-8000-000000000001'
const DICTATE_UUID = 'A1B2C3D4-0000-4000-8000-000000000002'

/** U+FFFC OBJECT REPLACEMENT CHARACTER — the placeholder a magic variable fills. */
const OBJ = '￼'

// --- minimal plist serializer (Shortcuts files are plain plists) -------------

type P = string | number | boolean | P[] | { [k: string]: P }

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function plist(v: P, indent = 1): string {
  const pad = '\t'.repeat(indent)
  if (Array.isArray(v)) {
    if (!v.length) return `${pad}<array/>`
    return `${pad}<array>\n${v.map((x) => plist(x, indent + 1)).join('\n')}\n${pad}</array>`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (!keys.length) return `${pad}<dict/>`
    const body = keys
      .map((k) => `${'\t'.repeat(indent + 1)}<key>${esc(k)}</key>\n${plist(v[k], indent + 1)}`)
      .join('\n')
    return `${pad}<dict>\n${body}\n${pad}</dict>`
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? `${pad}<integer>${v}</integer>` : `${pad}<real>${v}</real>`
  }
  if (typeof v === 'boolean') return `${pad}<${v ? 'true' : 'false'}/>`
  return `${pad}<string>${esc(v)}</string>`
}

/** A plain (no-variable) Shortcuts text token. */
const text = (s: string): P => ({
  Value: { string: s },
  WFSerializationType: 'WFTextTokenString',
})

/** A Shortcuts text token whose OBJ placeholder is filled by an action's output. */
function textWithVar(str: string, uuid: string): P {
  const idx = str.indexOf(OBJ)
  return {
    Value: {
      string: str,
      attachmentsByRange: {
        [`{${idx}, 1}`]: { OutputUUID: uuid, Type: 'ActionOutput' },
      },
    },
    WFSerializationType: 'WFTextTokenString',
  }
}

/** A Shortcuts dictionary field (used for headers and the JSON body). */
function dict(entries: Array<{ key: string; value: P }>): P {
  return {
    Value: {
      WFDictionaryFieldValueItems: entries.map((e) => ({
        WFItemType: 0, // text
        WFKey: text(e.key),
        WFValue: e.value,
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  }
}

// --- the shortcut ------------------------------------------------------------

const actions: P[] = [
  // 0 — the capture token. Import question targets this action's text.
  {
    WFWorkflowActionIdentifier: 'is.workflow.actions.gettext',
    WFWorkflowActionParameters: {
      UUID: TOKEN_UUID,
      CustomOutputName: 'idj token',
      WFTextActionText: text('PASTE_YOUR_CAPTURE_TOKEN'),
    },
  },
  // 1 — dictate the memo
  {
    WFWorkflowActionIdentifier: 'is.workflow.actions.dictatetext',
    WFWorkflowActionParameters: {
      UUID: DICTATE_UUID,
      WFSpeechLanguage: 'en-US',
      WFDictateTextStopListening: 'After Pause',
    },
  },
  // 2 — POST it to /api/capture as JSON {text: <dictated>}
  {
    WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
    WFWorkflowActionParameters: {
      WFURL: text(`${BASE_URL}/api/capture`),
      WFHTTPMethod: 'POST',
      WFHTTPBodyType: 'JSON',
      ShowHeaders: true,
      WFHTTPHeaders: dict([
        { key: 'Authorization', value: textWithVar(`Bearer ${OBJ}`, TOKEN_UUID) },
      ]),
      WFJSONValues: dict([{ key: 'text', value: textWithVar(OBJ, DICTATE_UUID) }]),
    },
  },
]

const shortcut: P = {
  WFWorkflowClientVersion: '1128.2',
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowMinimumClientVersionString: '900',
  WFWorkflowHasOutputFallback: false,
  WFWorkflowHasShortcutInputVariables: false,
  WFWorkflowIcon: {
    WFWorkflowIconStartColor: 4292093695, // amber-ish, matches the app icon
    WFWorkflowIconGlyphNumber: 59511, // microphone
  },
  WFWorkflowImportQuestions: [
    {
      ParameterKey: 'WFTextActionText',
      Category: 'Parameter',
      ActionIndex: 0,
      Text: 'Paste your idj capture token (from idj.isozilla.com/setup)',
      DefaultValue: '',
    },
  ],
  WFWorkflowInputContentItemClasses: [
    'WFAppStoreAppContentItem',
    'WFArticleContentItem',
    'WFContactContentItem',
    'WFDateContentItem',
    'WFEmailAddressContentItem',
    'WFGenericFileContentItem',
    'WFImageContentItem',
    'WFiTunesProductContentItem',
    'WFLocationContentItem',
    'WFDCMapsLinkContentItem',
    'WFAVAssetContentItem',
    'WFPDFContentItem',
    'WFPhoneNumberContentItem',
    'WFRichTextContentItem',
    'WFSafariWebPageContentItem',
    'WFStringContentItem',
    'WFURLContentItem',
  ],
  WFWorkflowTypes: ['ActionExtension', 'NCWidget'],
  WFWorkflowActions: actions,
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plist(shortcut, 0)}
</plist>
`

mkdirSync('public', { recursive: true })
writeFileSync(OUT, xml, 'utf8')
console.log(`wrote ${OUT} (${xml.length} bytes) — base url: ${BASE_URL}`)
console.log('sign with: shortcuts sign --mode anyone -i <in> -o public/idj-memo.shortcut')
