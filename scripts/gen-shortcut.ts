/**
 * Generate the "Record to idj" Apple Shortcut as an unsigned .shortcut plist.
 *
 *   bun run shortcut:build        -> build/record-to-idj.unsigned.shortcut
 *   bun run shortcut:sign         -> public/record-to-idj.shortcut (signed, on the mini)
 *
 * What it does on the phone:
 *   1. Records audio (Normal quality, starts at once, stops on tap).
 *   2. If you stopped within 2 seconds, asks for typed text instead and POSTs
 *      {text} as JSON; otherwise saves the recording to iCloud Drive
 *      (Shortcuts/idj/) and POSTs the file.
 *   3. Shows "Saved to idj" if the server answered with an item id, or the
 *      server's answer (the error) if not.
 *
 * The capture token is NOT in the file. Action 0 is a Text action, and an
 * import question makes iOS ask for its value at install time ("paste the
 * Header value from idj.isozilla.com/setup"), so the signed file is safe to
 * serve publicly and rotating the token means re-installing.
 *
 * Signing needs a Mac signed into iCloud (iOS imports only Apple-signed
 * files); scripts/sign-shortcut.sh uses the Mac mini (ssh alias `mini`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE_URL = process.env.IDJ_BASE_URL ?? 'https://idj.isozilla.com'
const OUT = process.env.OUT ?? 'build/record-to-idj.unsigned.shortcut'
/** Stopping the recorder within this many seconds means "I want to type". */
const TYPE_INSTEAD_SECONDS = 2

/** U+FFFC OBJECT REPLACEMENT CHARACTER: where a variable goes inside text. */
const OBJ = '￼'

// --- minimal plist serializer (Shortcuts files are plain plists) -------------

type P = string | number | boolean | P[] | { [k: string]: P }

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
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

// --- Shortcuts value helpers -------------------------------------------------

/** An action's output, referenced by the action's UUID and output name. */
type Output = { uuid: string; name: string }

const ref = (o: Output) => ({ OutputUUID: o.uuid, Type: 'ActionOutput', OutputName: o.name })

/** Plain text, no variables. */
const text = (s: string): P => ({ Value: { string: s }, WFSerializationType: 'WFTextTokenString' })

/** Text containing one variable at the OBJ placeholder. */
function textWith(str: string, o: Output): P {
  return {
    Value: { string: str, attachmentsByRange: { [`{${str.indexOf(OBJ)}, 1}`]: ref(o) } },
    WFSerializationType: 'WFTextTokenString',
  }
}

/** A whole variable as an action input. */
const attach = (o: Output): P => ({ Value: ref(o), WFSerializationType: 'WFTextTokenAttachment' })

/** A dictionary field (headers, JSON body): text keys, text values. */
function dict(entries: Array<{ key: string; value: P }>): P {
  return {
    Value: {
      WFDictionaryFieldValueItems: entries.map((e) => ({
        WFItemType: 0,
        WFKey: text(e.key),
        WFValue: e.value,
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  }
}

const action = (id: string, params: { [k: string]: P }): P => ({
  WFWorkflowActionIdentifier: `is.workflow.actions.${id}`,
  WFWorkflowActionParameters: params,
})

// Stable ids: magic-variable references point at these.
const id = (n: number) => `1D1D1D1D-0000-4000-8000-${String(n).padStart(12, '0')}`
const TOKEN: Output = { uuid: id(1), name: 'Text' }
const START: Output = { uuid: id(2), name: 'Date' }
const AUDIO: Output = { uuid: id(3), name: 'Recorded Audio' }
const ELAPSED: Output = { uuid: id(4), name: 'Time Between Dates' }
const TYPED: Output = { uuid: id(5), name: 'Provided Input' }
const IF_RESULT: Output = { uuid: id(6), name: 'If Result' }
const ITEM_ID: Output = { uuid: id(7), name: 'Dictionary Value' }
const BRANCH = id(100)
const CHECK = id(101)

// Shortcuts' WFCondition codes.
const IS_BETWEEN = 1003
const HAS_ANY_VALUE = 100

const capture = (body: { [k: string]: P }): P =>
  action('downloadurl', {
    WFURL: text(`${BASE_URL}/api/capture`),
    WFHTTPMethod: 'POST',
    ShowHeaders: true,
    // The import answer is the whole header value ("Bearer idj_capture_..."),
    // exactly what /setup's "Header value" button copies.
    WFHTTPHeaders: dict([{ key: 'Authorization', value: textWith(OBJ, TOKEN) }]),
    ...body,
  })

const actions: P[] = [
  // 0: the Authorization header value. The import question fills this in.
  action('gettext', {
    UUID: TOKEN.uuid,
    WFTextActionText: text('Bearer PASTE_YOUR_CAPTURE_TOKEN'),
  }),
  // 1: when recording started
  action('date', { UUID: START.uuid, WFDateActionMode: 'Current Date' }),
  // 2: record
  action('recordaudio', {
    UUID: AUDIO.uuid,
    WFRecordingCompression: 'Normal',
    WFRecordingStart: 'Immediately',
    WFRecordingEnd: 'On Tap',
  }),
  // 3: how long the recorder was open. Sign depends on Shortcuts' argument
  // order, so the check below is "between -N and N", which holds either way.
  action('gettimebetweendates', {
    UUID: ELAPSED.uuid,
    WFInput: attach(START),
    WFTimeUntilUnit: 'Seconds',
  }),
  // 4: stopped almost at once -> type instead
  action('conditional', {
    GroupingIdentifier: BRANCH,
    WFControlFlowMode: 0,
    WFInput: { Type: 'Variable', Variable: attach(ELAPSED) },
    WFCondition: IS_BETWEEN,
    WFNumberValue: -TYPE_INSTEAD_SECONDS,
    WFAnotherNumber: TYPE_INSTEAD_SECONDS,
  }),
  // 5-6: typed capture as JSON {text}
  action('ask', { UUID: TYPED.uuid, WFAskActionPrompt: 'Note for idj', WFInputType: 'Text' }),
  capture({ WFHTTPBodyType: 'JSON', WFJSONValues: dict([{ key: 'text', value: textWith(OBJ, TYPED) }]) }),
  // 7: otherwise
  action('conditional', { GroupingIdentifier: BRANCH, WFControlFlowMode: 1 }),
  // 8-9: keep a copy first (a dead network can't lose it), then upload the file
  action('documentpicker.save', {
    WFInput: attach(AUDIO),
    WFAskWhereToSave: false,
    WFFileDestinationPath: 'idj/',
    WFSaveFileOverwrite: false,
  }),
  capture({ WFHTTPBodyType: 'File', WFRequestVariable: attach(AUDIO) }),
  // 10: end if -> "If Result" is whichever upload ran
  action('conditional', { GroupingIdentifier: BRANCH, WFControlFlowMode: 2, UUID: IF_RESULT.uuid }),
  // 11: the new item's id, if the server made one
  action('getvalueforkey', {
    UUID: ITEM_ID.uuid,
    WFInput: attach(IF_RESULT),
    WFGetDictionaryValueType: 'Value',
    WFDictionaryKey: text('id'),
  }),
  // 12-16: confirm quietly, or show what went wrong
  action('conditional', {
    GroupingIdentifier: CHECK,
    WFControlFlowMode: 0,
    WFInput: { Type: 'Variable', Variable: attach(ITEM_ID) },
    WFCondition: HAS_ANY_VALUE,
  }),
  action('notification', { WFNotificationActionBody: text('🎙 Saved to idj'), WFNotificationActionSound: false }),
  action('conditional', { GroupingIdentifier: CHECK, WFControlFlowMode: 1 }),
  action('showresult', { Text: textWith(OBJ, IF_RESULT) }),
  action('conditional', { GroupingIdentifier: CHECK, WFControlFlowMode: 2 }),
]

const shortcut: P = {
  WFWorkflowClientVersion: '2607.0.2',
  WFWorkflowMinimumClientVersion: 900,
  WFWorkflowMinimumClientVersionString: '900',
  WFWorkflowHasOutputFallback: false,
  WFWorkflowHasShortcutInputVariables: false,
  WFWorkflowIcon: {
    WFWorkflowIconStartColor: 4292093695, // amber, matches the app icon
    WFWorkflowIconGlyphNumber: 59511, // microphone
  },
  WFWorkflowImportQuestions: [
    {
      ParameterKey: 'WFTextActionText',
      Category: 'Parameter',
      ActionIndex: 0,
      Text: 'Paste the Header value from idj.isozilla.com/setup (it starts with "Bearer ")',
      DefaultValue: '',
    },
  ],
  WFWorkflowInputContentItemClasses: [],
  WFWorkflowOutputContentItemClasses: [],
  WFQuickActionSurfaces: [],
  WFWorkflowTypes: [],
  WFWorkflowActions: actions,
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plist(shortcut, 0)}
</plist>
`

mkdirSync(OUT.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true })
writeFileSync(OUT, xml, 'utf8')
console.log(`wrote ${OUT} (${xml.length} bytes), base url ${BASE_URL}`)
